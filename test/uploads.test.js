'use strict';
// Pure-function coverage for the media-intake abuse guards: type whitelist,
// size caps, server-shaped object names, the publish-time URL sanitizer, and
// the JPEG metadata stripper. No GCS calls — env is pinned before require so
// the module builds its allowlist regexes deterministically.

process.env.USER_UPLOADS_BUCKET = 'test-uploads-bucket';
process.env.SITE_IMAGES_BUCKET = 'test-images-bucket';

const test = require('node:test');
const assert = require('node:assert');
const uploads = require('../lib/uploads');

test('checkRequest rejects non-whitelisted content types', () => {
  assert.ok(uploads.checkRequest('image/gif', 1000));
  assert.ok(uploads.checkRequest('text/html', 1000));
  assert.ok(uploads.checkRequest('video/quicktime', 1000));
  assert.ok(uploads.checkRequest('', 1000));
});

test('checkRequest accepts whitelisted types within caps', () => {
  assert.strictEqual(uploads.checkRequest('image/jpeg', 5 * 1024 * 1024), null);
  assert.strictEqual(uploads.checkRequest('image/png', 1024), null);
  assert.strictEqual(uploads.checkRequest('image/webp', 1024), null);
  assert.strictEqual(uploads.checkRequest('video/mp4', 50 * 1024 * 1024), null);
});

test('checkRequest enforces size caps per kind', () => {
  assert.ok(uploads.checkRequest('image/jpeg', 16 * 1024 * 1024)); // > 15MB image cap
  assert.ok(uploads.checkRequest('video/mp4', 101 * 1024 * 1024)); // > 100MB video cap
  assert.ok(uploads.checkRequest('image/jpeg', 0));
  assert.ok(uploads.checkRequest('image/jpeg', NaN));
});

test('NAME_RE accepts only server-shaped object names', () => {
  assert.ok(uploads.NAME_RE.test('uploads/20260611/0123456789abcdef01234567.jpg'));
  assert.ok(uploads.NAME_RE.test('uploads/20260611/0123456789abcdef01234567.mp4'));
  assert.ok(!uploads.NAME_RE.test('uploads/20260611/0123456789abcdef01234567.gif'));
  assert.ok(!uploads.NAME_RE.test('uploads/../secrets.json'));
  assert.ok(!uploads.NAME_RE.test('sites/abc/index.html'));
  assert.ok(!uploads.NAME_RE.test('uploads/20260611/UPPERCASE0123456789abcdef.jpg'));
  assert.ok(!uploads.NAME_RE.test('uploads/20260611/0123456789abcdef01234567.jpg/extra'));
});

test('sanitizeUserMedia keeps only our public-bucket user/ URLs', () => {
  const ours = 'https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/0.jpg';
  const out = uploads.sanitizeUserMedia([
    { url: ours, kind: 'image' },
    { url: 'https://evil.example.com/x.jpg', kind: 'image' },
    { url: 'https://storage.googleapis.com/other-bucket/user/0123456789abcdef/0.jpg', kind: 'image' },
    { url: 'https://storage.googleapis.com/test-images-bucket/food_beverage/default/hero-1.png', kind: 'image' },
    { url: ours.replace('.jpg', '.mp4'), kind: 'video' },
    'not-an-object',
    null
  ]);
  assert.deepStrictEqual(out, [
    { url: ours, kind: 'image' },
    { url: ours.replace('.jpg', '.mp4'), kind: 'video' }
  ]);
});

test('sanitizeUserMedia caps the list and coerces kind', () => {
  const mk = (i) => ({ url: `https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/${i}.jpg`, kind: 'banana' });
  const out = uploads.sanitizeUserMedia(Array.from({ length: 12 }, (_, i) => mk(i)));
  assert.strictEqual(out.length, uploads.MAX_FILES_PER_BUILD);
  assert.ok(out.every(m => m.kind === 'image'));
});

// Minimal synthetic JPEG: SOI · APP0/JFIF (kept) · APP1/EXIF (dropped) ·
// COM (dropped) · DQT (kept) · SOS + image bytes + EOI (kept verbatim).
function segment(marker, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xFF, marker]), len, payload]);
}
test('stripJpegMetadata drops APP1/COM, keeps JFIF, DQT and scan data', () => {
  const soi = Buffer.from([0xFF, 0xD8]);
  const app0 = segment(0xE0, Buffer.from('JFIF\0rest'));
  const app1 = segment(0xE1, Buffer.from('Exif\0\0SECRET-GPS-COORDS'));
  const com = segment(0xFE, Buffer.from('a comment'));
  const dqt = segment(0xDB, Buffer.from([0x00, 1, 2, 3]));
  const scan = Buffer.concat([Buffer.from([0xFF, 0xDA, 0x00, 0x04, 0x01, 0x02]), Buffer.from('imagedata'), Buffer.from([0xFF, 0xD9])]);
  const jpeg = Buffer.concat([soi, app0, app1, com, dqt, scan]);

  const out = uploads.stripJpegMetadata(jpeg);
  assert.ok(!out.includes('SECRET-GPS-COORDS'), 'EXIF payload must be gone');
  assert.ok(!out.includes('a comment'), 'COM payload must be gone');
  assert.ok(out.includes('JFIF'), 'APP0/JFIF must survive');
  assert.ok(out.includes('imagedata'), 'scan data must survive');
  assert.deepStrictEqual(out.subarray(0, 2), Buffer.from([0xFF, 0xD8]));
  assert.deepStrictEqual(out.subarray(out.length - 2), Buffer.from([0xFF, 0xD9]));
});

test('stripJpegMetadata leaves non-JPEG buffers untouched', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
  assert.strictEqual(uploads.stripJpegMetadata(png), png);
  const tiny = Buffer.from([0xFF, 0xD8]);
  assert.strictEqual(uploads.stripJpegMetadata(tiny), tiny);
});

test('stripJpegMetadata REJECTS malformed segment layouts instead of shipping the un-stripped tail', () => {
  const soi = Buffer.from([0xFF, 0xD8]);
  // declared length runs past the end of the buffer — un-walked bytes could
  // carry EXIF/GPS, so the file must be rejected (security review finding 3)
  const overrun = Buffer.concat([soi, Buffer.from([0xFF, 0xE1, 0xFF, 0xFF, 0x01, 0x02])]);
  assert.throws(() => uploads.stripJpegMetadata(overrun), /rejected/);
  // stray fill byte between segments breaks the marker walk before SOS
  const strayFill = Buffer.concat([soi, Buffer.from([0xFF, 0xDB, 0x00, 0x02]), Buffer.from([0x00, 0xFF, 0xDA, 0x00, 0x02])]);
  assert.throws(() => uploads.stripJpegMetadata(strayFill), /rejected/);
  // truncated before reaching start-of-scan
  const truncated = Buffer.concat([soi, Buffer.from([0xFF, 0xDB, 0x00, 0x04, 0x01, 0x02])]);
  assert.throws(() => uploads.stripJpegMetadata(truncated), /rejected/);
});

test('lengthRangeFor binds the signature to the declared size, capped at the type ceiling', () => {
  const SLACK = 16 * 1024;
  assert.strictEqual(uploads.lengthRangeFor('image/jpeg', 1000), `0,${1000 + SLACK}`);
  assert.strictEqual(uploads.lengthRangeFor('video/mp4', 5_000_000), `0,${5_000_000 + SLACK}`);
  // a declaration at (or near) the cap never exceeds the cap
  assert.strictEqual(uploads.lengthRangeFor('image/jpeg', 15 * 1024 * 1024), `0,${15 * 1024 * 1024}`);
  assert.strictEqual(uploads.lengthRangeFor('video/mp4', 10 ** 12), `0,${100 * 1024 * 1024}`);
});

// --- magic-bytes MIME sniff (card 4cxGFuqh) ---
// Real headers per format; pad past the 12-byte minimum the sniffer needs.
const PNG_MAGIC = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('IHDRxxxx')]);
const WEBP_MAGIC = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]);
const MP4_MAGIC = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from('mp42mp42')]);
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);

test('sniffType detects real magic bytes for each whitelisted format', () => {
  assert.strictEqual(uploads.sniffType(PNG_MAGIC), 'image/png');
  assert.strictEqual(uploads.sniffType(WEBP_MAGIC), 'image/webp');
  assert.strictEqual(uploads.sniffType(MP4_MAGIC), 'video/mp4');
  assert.strictEqual(uploads.sniffType(JPEG_MAGIC), 'image/jpeg');
});

test('sniffType returns null for spoofed / non-media bytes', () => {
  assert.strictEqual(uploads.sniffType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.strictEqual(uploads.sniffType(Buffer.from('GIF89a............')), null);
  assert.strictEqual(uploads.sniffType(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.strictEqual(uploads.sniffType(Buffer.alloc(4)), null);   // too short
  assert.strictEqual(uploads.sniffType('not a buffer'), null);
  // "RIFF" container that is NOT WebP (e.g. WAV) must not pass as webp
  assert.strictEqual(uploads.sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')])), null);
});

test('magicMatches enforces declared-type vs real-bytes agreement', () => {
  assert.strictEqual(uploads.magicMatches(PNG_MAGIC, 'image/png'), true);
  assert.strictEqual(uploads.magicMatches(WEBP_MAGIC, 'image/webp'), true);
  assert.strictEqual(uploads.magicMatches(MP4_MAGIC, 'video/mp4'), true);
  assert.strictEqual(uploads.magicMatches(JPEG_MAGIC, 'image/jpeg'), true);
  // spoof: HTML body declared as image/png is rejected
  assert.strictEqual(uploads.magicMatches(Buffer.from('<html>this is not a png at all!!!</html>'), 'image/png'), false);
  // cross-type spoof: a real PNG body declared as mp4 still mismatches
  assert.strictEqual(uploads.magicMatches(PNG_MAGIC, 'video/mp4'), false);
});
