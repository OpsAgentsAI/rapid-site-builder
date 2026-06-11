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

// Short-lived signed PUT URL. The signature binds the content type AND a
// length-range header, so the URL can only upload the file it was minted for.
async function signUpload(contentType, size) {
  if (!ENABLED) { const e = new Error('Uploads are not enabled on this deployment.'); e.status = 503; throw e; }
  const err = checkRequest(contentType, Number(size));
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `uploads/${day}/${crypto.randomBytes(12).toString('hex')}.${TYPES[contentType].ext}`;
  const range = `0,${capFor(contentType)}`;
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
  while (i + 4 <= buf.length && buf[i] === 0xFF) {
    const marker = buf[i + 1];
    if (marker === 0xDA) break; // start of scan — image data from here, keep as-is
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break; // malformed — keep the rest untouched
    const drop = (marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
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
  if (meta.contentType === 'image/jpeg') {
    const [buf] = await src.download();
    await dest.save(stripJpegMetadata(buf), { contentType: 'image/jpeg', resumable: false });
  } else {
    await src.copy(dest);
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
  checkRequest, signUpload, prepareUserMedia, sanitizeUserMedia, stripJpegMetadata
};
