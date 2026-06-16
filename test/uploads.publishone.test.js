'use strict';
// Integration coverage for publishOne's fail-closed reject path (card 4cxGFuqh
// security review): the pure magicMatches predicate is unit-tested elsewhere,
// but the AC ("non-image bytes under image/png are REJECTED") is about the
// upload PATH dropping the file — publishOne must return null and never write
// to the public bucket. We mock @google-cloud/storage at require time so no GCS
// call is made; the fake records every dest.save/copy so we can assert none ran.

const Module = require('module');

// --- controllable fake GCS, installed before lib/uploads is required ---
let SRC_META = null;     // what src.getMetadata() returns
let SRC_BYTES = null;    // what src.download() returns
const saveCalls = [];    // every write to the PUBLIC bucket lands here

class FakeFile {
  constructor(bucketName, name) { this.bucketName = bucketName; this.name = name; }
  async getMetadata() { if (!SRC_META) throw new Error('no meta'); return [SRC_META]; }
  async download() { return [SRC_BYTES]; }
  async save(buf, opts) { saveCalls.push({ op: 'save', bucket: this.bucketName, name: this.name, len: buf.length, opts }); }
  async copy() { saveCalls.push({ op: 'copy', bucket: this.bucketName, name: this.name }); }
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

const test = require('node:test');
const assert = require('node:assert');
const uploads = require('../lib/uploads');

Module._load = origLoad; // restore once the module graph is built

// Drive the integration through the PUBLIC exported wrapper (prepareUserMedia →
// publishOne); a dropped file yields an empty result + zero public writes.
const VALID_NAME = 'uploads/20260611/0123456789abcdef01234567.png';
const PNG_MAGIC = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('IHDRxxxx')]);

test('prepareUserMedia REJECTS HTML bytes declared as image/png — no result, no public write', async () => {
  saveCalls.length = 0;
  SRC_META = { contentType: 'image/png', size: 64 };
  SRC_BYTES = Buffer.from('<html><script>alert(document.cookie)</script><!-- padding padding -->');
  const out = await uploads.prepareUserMedia([VALID_NAME]);
  assert.deepStrictEqual(out, [], 'spoofed upload must degrade to "no media"');
  assert.strictEqual(saveCalls.length, 0, 'nothing may be written to the PUBLIC bucket on a magic-bytes mismatch');
});

test('prepareUserMedia PUBLISHES a real PNG — one result, exactly one public write with pinned Content-Type', async () => {
  saveCalls.length = 0;
  SRC_META = { contentType: 'image/png', size: PNG_MAGIC.length };
  SRC_BYTES = PNG_MAGIC;
  const out = await uploads.prepareUserMedia([VALID_NAME]);
  assert.strictEqual(out.length, 1, 'happy-path PNG must publish');
  assert.ok(out[0].url.includes('test-images-bucket') && out[0].url.includes('/user/'), 'served from the public bucket under user/');
  assert.strictEqual(out[0].kind, 'image');
  assert.strictEqual(saveCalls.length, 1, 'a matching PNG is written exactly once');
  assert.strictEqual(saveCalls[0].bucket, 'test-images-bucket', 'written to the PUBLIC bucket');
  assert.strictEqual(saveCalls[0].opts.metadata.contentType, 'image/png', 'served copy pins the canonical Content-Type');
});
