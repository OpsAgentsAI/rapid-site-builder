'use strict';
// User media intake: visitors may attach their own photos/videos to a build.
// Files go straight from the browser to a PRIVATE GCS bucket via short-lived
// V4 signed PUT URLs (keyless — the runtime service account signs through IAM
// signBlob), are re-verified server-side from the object's OWN metadata, then
// copied into the public image bucket for serving. JPEGs are rewritten with
// EXIF/GPS/comment segments stripped on the way. The crew and the renderer
// only ever see copies this module made — never a client-supplied URL.
//
// Env:
//   USER_UPLOADS_BUCKET      private intake bucket (required to enable uploads)
//   SITE_IMAGES_BUCKET       public bucket the verified copies are served from
//   UPLOAD_MAX_IMAGE_MB      image size cap                       (default 15)
//   UPLOAD_MAX_VIDEO_MB      video size cap                       (default 100)

const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const UPLOADS_BUCKET = process.env.USER_UPLOADS_BUCKET || '';
const PUBLIC_BUCKET = process.env.SITE_IMAGES_BUCKET || '';
const MAX_IMAGE = (Number(process.env.UPLOAD_MAX_IMAGE_MB) || 15) * 1024 * 1024;
const MAX_VIDEO = (Number(process.env.UPLOAD_MAX_VIDEO_MB) || 100) * 1024 * 1024;
const MAX_FILES_PER_BUILD = 8;

const ENABLED = !!UPLOADS_BUCKET;
const storage = new Storage();

const TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' }
};

function capFor(contentType) {
  const t = TYPES[contentType];
  return t ? (t.kind === 'video' ? MAX_VIDEO : MAX_IMAGE) : 0;
}

// uploads/<yyyymmdd>/<24 hex>.<ext> — server-generated, no client input in the
// path, unguessable, and matched strictly everywhere a name crosses the API.
const NAME_RE = /^uploads\/\d{8}\/[a-f0-9]{24}\.(jpg|png|webp|mp4)$/;

function checkRequest(contentType, size) {
  const t = TYPES[contentType];
  if (!t) return 'We accept JPEG, PNG or WebP photos and MP4 video.';
  if (!Number.isFinite(size) || size <= 0) return 'Missing file size.';
  const cap = capFor(contentType);
  if (size > cap) return `That file is too big — the limit is ${Math.round(cap / 1024 / 1024)}MB per ${t.kind}.`;
  return null;
}

// The signed length-range must enforce the DECLARED size, not just the type
// ceiling — a cap-wide range turns every minted URL into a full 15MB/100MB
// write permit regardless of the claim (PR #3 security review, finding 2).
// Small slack absorbs honest byte-count drift without reopening the cap.
const SIZE_SLACK = 16 * 1024;
function lengthRangeFor(contentType, size) {
  return `0,${Math.min(Number(size) + SIZE_SLACK, capFor(contentType))}`;
}

// Short-lived signed PUT URL. The signature binds the content type AND a
// length-range header, so the URL can only upload the file it was minted for.
async function signUpload(contentType, size) {
  if (!ENABLED) { const e = new Error('Uploads are not enabled on this deployment.'); e.status = 503; throw e; }
  const err = checkRequest(contentType, Number(size));
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `uploads/${day}/${crypto.randomBytes(12).toString('hex')}.${TYPES[contentType].ext}`;
  const range = lengthRangeFor(contentType, Number(size));
  const [url] = await storage.bucket(UPLOADS_BUCKET).file(name).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60_000,
    contentType,
    extensionHeaders: { 'x-goog-content-length-range': range }
  });
  return { name, url, headers: { 'Content-Type': contentType, 'x-goog-content-length-range': range } };
}

// Strip JPEG metadata segments (EXIF/GPS in APP1, ICC/XMP in other APPn, and
// COM comments) without re-encoding: walk the marker segments and drop
// APP1–APP15 + COM, keeping APP0/JFIF and everything from start-of-scan on.
// Phone photos carry GPS coordinates in EXIF — published pages must not.
function stripJpegMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  for (;;) {
    // The ONLY clean exit is reaching start-of-scan through valid markers.
    // Re-emitting an un-walked tail on a parse anomaly could ship EXIF/GPS we
    // never inspected (PR #3 security review, finding 3) — reject instead;
    // the caller drops just this file ("no media" beats leaked coordinates).
    if (i + 4 > buf.length || buf[i] !== 0xFF) {
      throw new Error('Unparseable JPEG marker layout — file rejected, metadata cannot be verified stripped');
    }
    const marker = buf[i + 1];
    if (marker === 0xDA) break; // start of scan — image data from here, keep as-is
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) {
      throw new Error('Unparseable JPEG marker layout — file rejected, metadata cannot be verified stripped');
    }
    const drop = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

// Magic-bytes content sniffing. The object's declared Content-Type is metadata
// the uploader controls — a .png slot can hold an HTML/SVG/script payload that a
// sniffing browser then executes off our PUBLIC bucket (stored-XSS). Inspect the
// real leading bytes and refuse to serve a copy whose body doesn't match its
// claimed type. JPEG is structurally validated by stripJpegMetadata; this covers
// the png/webp/mp4 paths that were copied verbatim with no byte inspection.
//   PNG  : 89 50 4E 47 0D 0A 1A 0A          (8-byte signature)
//   WebP : "RIFF" ....  "WEBP"              (bytes 0-3 + bytes 8-11)
//   MP4  : ....  "ftyp"  ....               (an ftyp box — bytes 4-7 == "ftyp")
//   JPEG : FF D8 FF                          (SOI + first marker)
function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return 'image/png';
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) { // "WEBP"
    return 'image/webp';
  }
  // MP4: an "ftyp" box at bytes 4-7. (mp4/mov/3gp all start with an ftyp box.)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) { // "ftyp"
    return 'video/mp4';
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  return null;
}

// True iff the buffer's real magic bytes match the declared content type.
function magicMatches(buf, contentType) {
  return sniffType(buf) === contentType;
}

// Strip PNG privacy metadata without re-encoding: walk the chunk stream
// (8-byte signature, then repeating length(4)+type(4)+data+crc(4)) and DROP the
// ancillary chunks that can carry EXIF/GPS/PII — eXIf, tEXt, iTXt, zTXt, tIME —
// while keeping every critical + rendering chunk verbatim (their CRCs stay valid
// because the bytes are untouched). Fail-closed on any structural anomaly, same
// posture as stripJpegMetadata: a half-parsed PNG could ship un-inspected EXIF,
// so the caller drops just this file ("no media" beats leaked coordinates).
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
function stripPngMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Unparseable PNG signature — file rejected, metadata cannot be verified stripped');
  }
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  let sawIEND = false;
  for (;;) {
    if (i === buf.length) break;            // clean end exactly at a chunk boundary
    if (i + 8 > buf.length) {
      throw new Error('Unparseable PNG chunk layout — file rejected, metadata cannot be verified stripped');
    }
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;               // 4 len + 4 type + len data + 4 crc
    if (len > 0x7FFFFFFF || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) {
      throw new Error('Unparseable PNG chunk layout — file rejected, metadata cannot be verified stripped');
    }
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') { sawIEND = true; break; }
  }
  if (!sawIEND) {
    throw new Error('PNG missing IEND — file rejected, metadata cannot be verified stripped');
  }
  return Buffer.concat(parts);
}

// Strip WebP privacy metadata: RIFF container is "RIFF"+size(4)+"WEBP" then a
// run of chunks (FourCC(4)+size(4)+payload, padded to even length). DROP the
// "EXIF" and "XMP " chunks; keep VP8/VP8L/VP8X/ALPH/ANIM/ANMF and any other
// rendering chunk. Rewrite the RIFF size to match the kept body. Clearing the
// chunks is sufficient for privacy even if VP8X still flags EXIF/XMP present.
// Fail-closed on any structural anomaly.
function stripWebpMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 ||
      buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('Unparseable WebP header — file rejected, metadata cannot be verified stripped');
  }
  const declared = buf.readUInt32LE(4);
  // RIFF size counts everything after the 8-byte "RIFF"+size field.
  if (declared + 8 > buf.length || declared < 4) {
    throw new Error('Unparseable WebP RIFF size — file rejected, metadata cannot be verified stripped');
  }
  const body = [];
  let i = 12;
  const limit = 8 + declared;               // end of RIFF payload within the buffer
  while (i < limit) {
    if (i + 8 > limit) {
      throw new Error('Unparseable WebP chunk layout — file rejected, metadata cannot be verified stripped');
    }
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const padded = size + (size & 1);       // chunks are padded to even length
    const end = i + 8 + padded;
    if (!/^[\x20-\x7E]{4}$/.test(fourcc) || end > limit) {
      throw new Error('Unparseable WebP chunk layout — file rejected, metadata cannot be verified stripped');
    }
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') body.push(buf.subarray(i, end));
    i = end;
  }
  const payload = Buffer.concat(body);
  const head = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  head.writeUInt32LE(payload.length + 4, 4); // +4 for the "WEBP" FourCC
  return Buffer.concat([head, payload]);
}

// Strip MP4 privacy metadata: walk top-level boxes (size(4)+type(4); size==1
// → 64-bit largesize in the next 8 bytes; size==0 → extends to EOF), descend
// into "moov", and DROP its "udta" AND "meta" child boxes. udta carries the
// Android ©xyz GPS strings + meta/loci; meta (a direct child of moov) carries
// the iOS com.apple.quicktime.location.ISO6709 GPS atom — both must go or a
// phone-shot clip leaks coordinates onto the public bucket. Rewrite the moov
// size and the file-level box sizes to match. Fail-closed on any anomaly so a
// half-parsed file is dropped, not shipped.
function readBox(buf, off, end) {
  if (off + 8 > end) throw new Error('mp4 box truncated');
  let size = buf.readUInt32BE(off);
  const type = buf.toString('latin1', off + 4, off + 8);
  let headerLen = 8;
  if (size === 1) {                          // 64-bit largesize
    if (off + 16 > end) throw new Error('mp4 64-bit box truncated');
    const hi = buf.readUInt32BE(off + 8);
    const lo = buf.readUInt32BE(off + 12);
    size = hi * 0x100000000 + lo;
    headerLen = 16;
  } else if (size === 0) {                   // extends to end of buffer
    size = end - off;
  }
  if (size < headerLen || off + size > end) throw new Error('mp4 box size out of range');
  if (!/^[\x20-\x7E]{4}$/.test(type)) throw new Error('mp4 box type invalid');
  return { type, start: off, size, headerLen, dataStart: off + headerLen, dataEnd: off + size };
}
// Emit a fresh box header (always 32-bit size — moov stays well under 4GiB once
// GPS udta boxes are gone) wrapping the given body.
function box32(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
function stripMp4Metadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    throw new Error('Unparseable MP4 — file rejected, metadata cannot be verified stripped');
  }
  try {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const b = readBox(buf, i, buf.length);
      if (b.type === 'moov') {
        // Re-emit moov with every udta AND meta child removed. udta = Android
        // ©xyz GPS; meta = the iOS ISO6709 location atom (sibling of udta).
        const kept = [];
        let j = b.dataStart;
        while (j < b.dataEnd) {
          const child = readBox(buf, j, b.dataEnd);
          if (child.type !== 'udta' && child.type !== 'meta') kept.push(buf.subarray(child.start, child.dataEnd));
          j = child.dataEnd;
        }
        out.push(box32('moov', Buffer.concat(kept)));
      } else {
        out.push(buf.subarray(b.start, b.dataEnd));
      }
      i = b.dataEnd;
    }
    return Buffer.concat(out);
  } catch {
    throw new Error('Unparseable MP4 box layout — file rejected, metadata cannot be verified stripped');
  }
}

// Verify one uploaded object against ITS OWN metadata (never the client's
// claims), then copy it into the public bucket under user/<token>/. Returns
// { url, kind } or null — a failed file degrades to "no media", it never
// blocks a build.
async function publishOne(name, token, idx) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const src = storage.bucket(UPLOADS_BUCKET).file(name);
  let meta;
  try { [meta] = await src.getMetadata(); } catch { return null; }
  const t = TYPES[meta.contentType];
  if (!t) return null;
  if (Number(meta.size) > capFor(meta.contentType)) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const destName = `user/${token}/${idx}.${ext}`;
  const dest = storage.bucket(PUBLIC_BUCKET).file(destName);
  // Pull the bytes once, then run BOTH P2a controls before serving:
  //  (1) magic-bytes gate — a spoofed object (e.g. HTML under image/png) is
  //      dropped here ("no media" beats a stored-XSS payload on the PUBLIC bucket);
  //  (2) metadata strip — EXIF/GPS/PII removed for EVERY type (verbatim copy
  //      leaked PNG/WebP/MP4 location data; the strip throws on a parse anomaly
  //      and prepareUserMedia's per-file try/catch then drops it, fail-closed).
  const [buf] = await src.download();
  if (!magicMatches(buf, meta.contentType)) return null;
  const STRIP = {
    'image/jpeg': stripJpegMetadata,
    'image/png': stripPngMetadata,
    'image/webp': stripWebpMetadata,
    'video/mp4': stripMp4Metadata
  };
  const cleaned = STRIP[meta.contentType](buf);
  // Serve with the canonical Content-Type (a REAL response header GCS serves from
  // the fixed field) + contentDisposition: inline, so an explicitly-typed image/*
  // body is never MIME-sniffed into executable HTML. NOTE: a true
  // `X-Content-Type-Options: nosniff` RESPONSE header can't be set on a direct
  // storage.googleapis.com object — custom metadata surfaces only as
  // `x-goog-meta-*`, which browsers ignore. The magic-bytes gate + real
  // Content-Type are the load-bearing control; a real nosniff header needs a
  // CDN/LB in front of the public bucket (tracked as a follow-up card).
  const saveOpts = {
    contentType: meta.contentType,
    resumable: false,
    metadata: {
      contentType: meta.contentType,
      contentDisposition: 'inline',
      metadata: { 'x-content-type-options': 'nosniff' } // x-goog-meta breadcrumb only (see note above)
    }
  };
  await dest.save(cleaned, saveOpts);
  return { url: `https://storage.googleapis.com/${PUBLIC_BUCKET}/${destName}`, kind: t.kind };
}

// Turn the intake's upload names into servable public media. Order preserved;
// bad entries dropped silently.
async function prepareUserMedia(names) {
  if (!ENABLED || !PUBLIC_BUCKET || !Array.isArray(names) || !names.length) return [];
  const token = crypto.randomBytes(8).toString('hex');
  const list = names.slice(0, MAX_FILES_PER_BUILD);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const m = await publishOne(list[i], token, i);
      if (m) out.push(m);
    } catch { /* one bad file never blocks the build */ }
  }
  return out;
}

// Re-validate media URLs a client sends back at publish time: only URLs this
// module could have minted (our public bucket, user/ prefix, expected shape)
// are accepted — published pages never embed arbitrary client URLs.
const PUBLIC_MEDIA_RE = PUBLIC_BUCKET
  ? new RegExp(
    '^https://storage\\.googleapis\\.com/' +
    PUBLIC_BUCKET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '/user/[a-f0-9]{16}/\\d{1,2}\\.(jpg|png|webp|mp4)$')
  : null;

function sanitizeUserMedia(arr) {
  if (!PUBLIC_MEDIA_RE || !Array.isArray(arr)) return [];
  const out = [];
  for (const m of arr.slice(0, MAX_FILES_PER_BUILD)) {
    if (!m || typeof m !== 'object') continue;
    const url = String(m.url || '');
    if (PUBLIC_MEDIA_RE.test(url)) out.push({ url, kind: m.kind === 'video' ? 'video' : 'image' });
  }
  return out;
}

module.exports = {
  ENABLED, MAX_FILES_PER_BUILD, NAME_RE, TYPES,
  checkRequest, signUpload, prepareUserMedia, sanitizeUserMedia, stripJpegMetadata,
  lengthRangeFor, sniffType, magicMatches,
  stripPngMetadata, stripWebpMetadata, stripMp4Metadata
};
