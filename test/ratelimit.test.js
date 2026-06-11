'use strict';
// Finding 1 (PR #3 security review): the per-IP limiter must key on req.ip
// under trust-proxy(1) — the proxy-appended LAST X-Forwarded-For entry — so
// rotating the client-controlled leftmost XFF no longer mints fresh
// rate-limit identities. Env is pinned before require so the limiter builds
// with a small quota the test can exhaust.

process.env.BUILDS_PER_HOUR_PER_IP = '3';
// enable uploads so /api/uploads/sign reaches its rate gates (no GCS call is
// ever made below — the gated requests 429 before any signing happens)
process.env.USER_UPLOADS_BUCKET = 'test-uploads-bucket';

const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../server');

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}

test('rotating leftmost X-Forwarded-For does not bypass the build rate limit', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const hit = (xff) => fetch(`http://127.0.0.1:${port}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
      body: '{}'
    });
    // same real client (last hop), three different spoofed leftmost hops —
    // all must land in ONE quota bucket. The empty brief 400s after the
    // limiter passes, which is exactly what distinguishes "counted" from
    // "blocked".
    for (let i = 0; i < 3; i++) {
      const res = await hit(`10.0.0.${i}, 9.9.9.9`);
      assert.strictEqual(res.status, 400, 'pre-quota request should fail on the empty brief, not the limiter');
    }
    const blocked = await hit('10.0.0.99, 9.9.9.9');
    assert.strictEqual(blocked.status, 429, 'fresh spoofed hop must NOT reset the quota');
    const other = await hit('10.0.0.99, 8.8.8.8');
    assert.strictEqual(other.status, 400, 'a genuinely different client (last hop) gets its own bucket');
  } finally {
    server.close();
  }
});

test('an IP that exhausted its build budget cannot keep minting signed upload URLs', async () => {
  // 9.9.9.9 burned its 3 builds in the test above (module-level buckets
  // persist within this file). Signed URLs are write-capable, so the sign
  // route must answer 429 from the build-budget peek — even though this IP
  // never used a single upload slot.
  const server = await listen();
  try {
    const port = server.address().port;
    const sign = (xff) => fetch(`http://127.0.0.1:${port}/api/uploads/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
      body: JSON.stringify({ contentType: 'image/jpeg', size: 1000 })
    });
    const gated = await sign('10.0.0.123, 9.9.9.9');
    assert.strictEqual(gated.status, 429, 'sign must be gated under the build budget');
    // peek's non-consuming semantics are unit-tested in test/limiter.test.js
  } finally {
    server.close();
  }
});
