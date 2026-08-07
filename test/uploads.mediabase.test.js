'use strict';
// Card 7KlXAiW0: when PUBLIC_MEDIA_BASE_URL points at the nosniff CDN/LB
// fronting layer, newly minted public media URLs go through it — and the
// publish-time re-validation accepts BOTH the fronted form and the legacy
// direct storage.googleapis.com form (pages published before the flip keep
// validating; rollback can't strand in-flight builds). Env is read at require
// time, so this file configures the base BEFORE lib/uploads loads — node
// --test runs each file in its own process, so the other uploads tests still
// exercise the base-unset direct-URL default. Same fake-GCS install pattern
// as uploads.publishone.test.js.

const Module = require('module');

let SRC_META = null;
let SRC_BYTES = null;
const saveCalls = [];

class FakeFile {
  constructor(bucketName, name) { this.bucketName = bucketName; this.name = name; }
  async getMetadata() { if (!SRC_META) throw new Error('no meta'); return [SRC_META]; }
  async download() { return [SRC_BYTES]; }
  async save(buf, opts) { saveCalls.push({ op: 'save', bucket: this.bucketName, name: this.name, len: buf.length, opts }); }
}
class FakeBucket { constructor(name) { this.name = name; } file(name) { return new FakeFile(this.name, name); } }
class FakeStorage { bucket(name) { return new FakeBucket(name); } }

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@google-cloud/storage') return { Storage: FakeStorage };
  return origLoad.call(this, request, ...rest);
};

process.env.USER_UPLOADS_BUCKET = 'test-uploads-bucket';
process.env.SITE_IMAGES_BUCKET = 'test-images-bucket';
// Trailing slash on purpose — the helper must normalize it away.
process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.test.example/';

const test = require('node:test');
const assert = require('node:assert');
const uploads = require('../lib/uploads');
const { PUBLIC_MEDIA_BASE_URL, publicObjectUrl } = require('../lib/publicMedia');

Module._load = origLoad;

test('publicMedia normalizes the base and builds fronted object URLs', () => {
  assert.strictEqual(PUBLIC_MEDIA_BASE_URL, 'https://media.test.example', 'trailing slash stripped');
  assert.strictEqual(
    publicObjectUrl('whatever-bucket', 'user/aa/1.png'),
    'https://media.test.example/user/aa/1.png',
    'fronted form carries the object path at the root — no bucket segment');
});

// Minimal structurally-valid PNG (signature + IHDR + IDAT + IEND) so the file
// survives both the magic-bytes gate and the metadata-strip chunk walk.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function pngChunk(type, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), d, Buffer.from([0, 0, 0, 0])]);
}
const VALID_PNG = Buffer.concat([
  PNG_SIG,
  pngChunk('IHDR', Buffer.alloc(13, 7)),
  pngChunk('IDAT', 'pixelbytes'),
  pngChunk('IEND', Buffer.alloc(0))
]);
const VALID_NAME = 'uploads/20260807/0123456789abcdef01234567.png';

test('prepareUserMedia mints URLs through the fronting layer when the base is set', async () => {
  saveCalls.length = 0;
  SRC_META = { contentType: 'image/png', size: VALID_PNG.length };
  SRC_BYTES = VALID_PNG;
  const out = await uploads.prepareUserMedia([VALID_NAME]);
  assert.strictEqual(out.length, 1, 'happy-path PNG must publish');
  assert.match(out[0].url, /^https:\/\/media\.test\.example\/user\/[a-f0-9]{16}\/0\.png$/,
    'minted URL goes through PUBLIC_MEDIA_BASE_URL');
  assert.ok(!out[0].url.includes('storage.googleapis.com'), 'no direct storage URL once fronted');
  assert.strictEqual(saveCalls.length, 1, 'object still written once');
  assert.strictEqual(saveCalls[0].bucket, 'test-images-bucket',
    'the WRITE still targets the real public bucket — only the served URL changes');
  assert.strictEqual(saveCalls[0].opts.metadata.contentType, 'image/png', 'Content-Type still pinned');
});

test('sanitizeUserMedia accepts BOTH the fronted and the legacy direct form', () => {
  const fronted = 'https://media.test.example/user/0123456789abcdef/0.png';
  const legacy = 'https://storage.googleapis.com/test-images-bucket/user/0123456789abcdef/1.jpg';
  const out = uploads.sanitizeUserMedia([
    { url: fronted, kind: 'image' },
    { url: legacy, kind: 'image' }
  ]);
  assert.deepStrictEqual(out.map(m => m.url), [fronted, legacy],
    'pages published before the base-URL flip must keep validating');
});

test('sanitizeUserMedia still rejects everything else', () => {
  const bad = [
    // right shape, wrong host — an attacker-controlled look-alike
    { url: 'https://media.evil.example/user/0123456789abcdef/0.png', kind: 'image' },
    // direct form but a different bucket
    { url: 'https://storage.googleapis.com/other-bucket/user/0123456789abcdef/0.png', kind: 'image' },
    // fronted host but outside the user/ prefix
    { url: 'https://media.test.example/professional/default/hero-1.png', kind: 'image' },
    // http downgrade of the fronted form
    { url: 'http://media.test.example/user/0123456789abcdef/0.png', kind: 'image' }
  ];
  assert.deepStrictEqual(uploads.sanitizeUserMedia(bad), [], 'no foreign URL may reach a published page');
});
