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

// ---- PNG metadata strip (card 4rF1bqG0) ----
// Synthetic chunk: length(4) + type(4) + data + crc(4). The stripper keeps kept
// chunks byte-for-byte, so the CRC field here is just a 4-byte filler.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function pngChunk(type, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), d, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])]);
}
test('stripPngMetadata drops eXIf/tEXt, keeps IHDR/IDAT/IEND', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13, 7)),
    pngChunk('eXIf', 'SECRET-GPS-COORDS'),
    pngChunk('tEXt', 'Author\0leaky-pii'),
    pngChunk('IDAT', 'pixelbytes'),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  const out = uploads.stripPngMetadata(png);
  assert.ok(!out.includes(Buffer.from('SECRET-GPS-COORDS')), 'eXIf payload must be gone');
  assert.ok(!out.includes(Buffer.from('leaky-pii')), 'tEXt payload must be gone');
  assert.ok(out.includes(Buffer.from('IHDR')), 'IHDR must survive');
  assert.ok(out.includes(Buffer.from('pixelbytes')), 'IDAT data must survive');
  assert.ok(out.includes(Buffer.from('IEND')), 'IEND must survive');
  assert.deepStrictEqual(out.subarray(0, 8), PNG_SIG);
});
test('stripPngMetadata rejects malformed PNG structure', () => {
  assert.throws(() => uploads.stripPngMetadata(Buffer.from('not a png at all here')), /reject|unparseable|malformed/i);
  // chunk length overruns the buffer
  const overrun = Buffer.concat([PNG_SIG, Buffer.from([0x7F, 0xFF, 0xFF, 0xF0]), Buffer.from('IDAT'), Buffer.from('x')]);
  assert.throws(() => uploads.stripPngMetadata(overrun), /reject|unparseable|malformed/i);
  // valid IHDR but no IEND
  const noEnd = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13, 1)), pngChunk('IDAT', 'data')]);
  assert.throws(() => uploads.stripPngMetadata(noEnd), /reject|unparseable|malformed/i);
});

// ---- WebP metadata strip (card 4rF1bqG0) ----
function webpChunk(fourcc, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const sz = Buffer.alloc(4); sz.writeUInt32LE(d.length);
  const pad = d.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, 'latin1'), sz, d, pad]);
}
function buildWebp(chunks) {
  const body = Buffer.concat(chunks);
  const head = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}
test('stripWebpMetadata drops EXIF/XMP, keeps VP8, rewrites RIFF size', () => {
  const webp = buildWebp([
    webpChunk('VP8 ', 'realimagepayload'),
    webpChunk('EXIF', 'SECRET-GPS-COORDS'),
    webpChunk('XMP ', '<x:xmpmeta>pii</x:xmpmeta>')
  ]);
  const out = uploads.stripWebpMetadata(webp);
  assert.ok(!out.includes(Buffer.from('SECRET-GPS-COORDS')), 'EXIF payload must be gone');
  assert.ok(!out.includes(Buffer.from('xmpmeta')), 'XMP payload must be gone');
  assert.ok(out.includes(Buffer.from('VP8 ')), 'VP8 chunk must survive');
  assert.ok(out.includes(Buffer.from('realimagepayload')), 'VP8 data must survive');
  assert.strictEqual(out.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(out.toString('latin1', 8, 12), 'WEBP');
  // rewritten RIFF size must equal the actual trailing byte count
  assert.strictEqual(out.readUInt32LE(4), out.length - 8);
});
test('stripWebpMetadata rejects malformed WebP structure', () => {
  assert.throws(() => uploads.stripWebpMetadata(Buffer.from('RIFFxxxxNOTWEBP!!')), /reject|unparseable|malformed/i);
  assert.throws(() => uploads.stripWebpMetadata(Buffer.from('tooshort')), /reject|unparseable|malformed/i);
  // a chunk whose declared size overruns the RIFF payload must be rejected:
  // hand-build VP8 with a bogus oversized size field, then wrap in a valid RIFF
  const bogusChunk = Buffer.concat([Buffer.from('VP8 '), (() => { const s = Buffer.alloc(4); s.writeUInt32LE(0xFFFFFF); return s; })(), Buffer.from('ab')]);
  const bad = buildWebp([bogusChunk]);
  assert.throws(() => uploads.stripWebpMetadata(bad), /reject|unparseable|malformed/i);
});

// ---- MP4 metadata strip (card 4rF1bqG0) ----
function mp4box(type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  const head = Buffer.alloc(8); head.writeUInt32BE(b.length + 8); head.write(type, 4, 'latin1');
  return Buffer.concat([head, b]);
}
test('stripMp4Metadata removes moov>udta GPS, keeps moov/mdat', () => {
  const udta = mp4box('udta', mp4box('\xA9xyz', '+37.7-122.4/SECRET-GPS-COORDS'));
  const mvhd = mp4box('mvhd', Buffer.alloc(20, 3));
  const moov = mp4box('moov', Buffer.concat([mvhd, udta]));
  const mdat = mp4box('mdat', 'rawvideopayload');
  const ftyp = mp4box('ftyp', 'mp42mp42');
  const mp4 = Buffer.concat([ftyp, moov, mdat]);

  const out = uploads.stripMp4Metadata(mp4);
  assert.ok(!out.includes(Buffer.from('SECRET-GPS-COORDS')), 'udta GPS payload must be gone');
  assert.ok(!out.includes(Buffer.from('xyz')), 'udta child box must be gone');
  assert.ok(out.includes(Buffer.from('mvhd')), 'mvhd must survive inside moov');
  assert.ok(out.includes(Buffer.from('mdat')), 'mdat must survive');
  assert.ok(out.includes(Buffer.from('rawvideopayload')), 'mdat data must survive');
  assert.ok(out.includes(Buffer.from('moov')), 'moov must survive');
  // moov box size must be rewritten to match its new (smaller) body
  const moovIdx = out.indexOf(Buffer.from('moov')) - 4;
  const moovSize = out.readUInt32BE(moovIdx);
  assert.ok(moovSize < moov.length, 'rewritten moov must be smaller than the original');
});
test('stripMp4Metadata removes iOS moov>meta ISO6709 GPS, keeps mvhd/mdat', () => {
  // iPhone capture writes location to com.apple.quicktime.location.ISO6709
  // inside a `meta` box that is a direct child of moov (sibling of udta).
  const meta = mp4box('meta', mp4box('ilst', '\xA9xyz+37.7749-122.4194/SECRET-IOS-GPS'));
  const mvhd = mp4box('mvhd', Buffer.alloc(20, 3));
  const moov = mp4box('moov', Buffer.concat([mvhd, meta]));
  const mdat = mp4box('mdat', 'rawvideopayload');
  const ftyp = mp4box('ftyp', 'mp42mp42');
  const mp4 = Buffer.concat([ftyp, moov, mdat]);

  const out = uploads.stripMp4Metadata(mp4);
  assert.ok(!out.includes(Buffer.from('SECRET-IOS-GPS')), 'iOS moov>meta GPS payload must be gone');
  assert.ok(!out.includes(Buffer.from('ilst')), 'moov>meta child box must be gone');
  assert.ok(out.includes(Buffer.from('mvhd')), 'mvhd must survive inside moov');
  assert.ok(out.includes(Buffer.from('mdat')), 'mdat must survive');
  assert.ok(out.includes(Buffer.from('rawvideopayload')), 'mdat data must survive');
  assert.ok(out.includes(Buffer.from('moov')), 'moov must survive');
});
test('stripMp4Metadata handles 64-bit box sizes', () => {
  // ftyp with the 64-bit largesize form (size field == 1, real size in next 8B)
  const body = Buffer.from('mp42mp42');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0); head.write('ftyp', 4, 'latin1');
  head.writeUInt32BE(0, 8); head.writeUInt32BE(body.length + 16, 12);
  const ftyp64 = Buffer.concat([head, body]);
  const mdat = mp4box('mdat', 'video');
  const out = uploads.stripMp4Metadata(Buffer.concat([ftyp64, mdat]));
  assert.ok(out.includes(Buffer.from('ftyp')), 'ftyp must survive');
  assert.ok(out.includes(Buffer.from('mdat')), 'mdat must survive');
});
test('stripMp4Metadata rejects malformed MP4 structure', () => {
  assert.throws(() => uploads.stripMp4Metadata(Buffer.from([0, 1, 2])), /reject|unparseable|malformed/i);
  // box claims a size far past the buffer end
  const overrun = Buffer.concat([(() => { const h = Buffer.alloc(8); h.writeUInt32BE(0x7FFFFFFF); h.write('ftyp', 4, 'latin1'); return h; })(), Buffer.from('xx')]);
  assert.throws(() => uploads.stripMp4Metadata(overrun), /reject|unparseable|malformed/i);
});
