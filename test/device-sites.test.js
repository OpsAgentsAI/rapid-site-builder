'use strict';
// No-sign-in device memory (card jvsQp6cS): /api/my-sites validates the device
// id before touching storage, and the store helpers refuse malformed ids so no
// caller input ever shapes a GCS path. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const { rememberDeviceSite, listDeviceSites } = require('../lib/store');
const { app } = require('../server');

const GOOD_DEVICE = 'a'.repeat(32);

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}

test('GET /api/my-sites rejects missing or malformed device ids', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    for (const q of ['', '?device=short', '?device=' + 'g'.repeat(32), '?device=../sites', '?device=' + 'A'.repeat(32)]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/my-sites${q}`);
      assert.strictEqual(res.status, 400, `expected 400 for query "${q}"`);
    }
  } finally {
    server.close();
  }
});

test('GET /api/my-sites with a well-formed id returns an empty list when no bucket is configured', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/my-sites?device=${GOOD_DEVICE}`);
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.deepStrictEqual(j.sites, []);
  } finally {
    server.close();
  }
});

test('store helpers refuse malformed ids without touching storage', async () => {
  // No PUBLISHED_SITES_BUCKET in the test env: a malformed id must short-circuit
  // (resolve cleanly), and a well-formed one must hit the no-bucket guard.
  await rememberDeviceSite('not-hex', 'abcd1234'); // resolves, writes nothing
  await rememberDeviceSite(GOOD_DEVICE, '../../escape'); // bad site id — refused
  assert.deepStrictEqual(await listDeviceSites('zz'), []);
  assert.deepStrictEqual(await listDeviceSites(GOOD_DEVICE), []);
});
