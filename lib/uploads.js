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
  // Always pull the bytes so the body can be sniffed before anything is served.
  // Magic-bytes must match the declared type — a spoofed object (e.g. HTML under
  // image/png) is dropped ("no media" beats a stored-XSS payload on the public
  // bucket). JPEG keeps its existing strip path (which also validates structure).
  const [buf] = await src.download();
  if (!magicMatches(buf, meta.contentType)) return null;
  // Serve the public copy with X-Content-Type-Options: nosniff so the browser
  // honours our Content-Type and never MIME-sniffs the body into something
  // executable. GCS lets custom response headers ride on object metadata.metadata
  // (surfaced as x-goog-meta-*) — we ALSO pin contentDisposition: inline and the
  // canonical contentType, the response controls GCS reliably exposes on a public
  // object. Defense in depth alongside the magic-bytes gate above.
  const saveOpts = {
    contentType: meta.contentType,
    resumable: false,
    metadata: {
      contentType: meta.contentType,
      contentDisposition: 'inline',
      metadata: { 'X-Content-Type-Options': 'nosniff' }
    }
  };
  if (meta.contentType === 'image/jpeg') {
    await dest.save(stripJpegMetadata(buf), saveOpts);
  } else {
    await dest.save(buf, saveOpts);
  }
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
  lengthRangeFor, sniffType, magicMatches
};
