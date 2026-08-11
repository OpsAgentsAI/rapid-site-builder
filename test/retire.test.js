'use strict';
// Card KjHpbn3J (retire ungated hackathon surfaces), steps 1–3 — REVERSIBLE:
// with RETIRE_UNGATED=1 the ungated surface must
//   1. 410 the anonymous engine endpoints (/api/build, /api/publish, /api/ask)
//      so anonymous Vertex/engine burn stops at the door,
//   2. 301 the pages (/ , /board , /campfire) to the canonical product surface
//      (REDIRECT, never 404 — launch posts link the old URLs), and
//   3. keep published demo sites /sites/{id} and health endpoints serving.
// Env is pinned before require so the flag is read at module load.

process.env.RETIRE_UNGATED = '1';
process.env.CANONICAL_APP_URL = 'https://builder.opsagents.agency';

const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../server');

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}

test('retirement mode: 410 engine APIs, 301 pages, health + /sites keep serving', async () => {
  const server = await listen();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p) => fetch(base + p, { redirect: 'manual' });
    const post = (p) => fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'manual'
    });

    // step 1 — anonymous engine endpoints are gone
    for (const p of ['/api/build', '/api/publish', '/api/ask']) {
      const res = await post(p);
      assert.strictEqual(res.status, 410, `${p} must be 410 Gone`);
      const body = await res.json();
      assert.strictEqual(body.canonical, 'https://builder.opsagents.agency');
    }

    // step 2 — pages 301 to the canonical surface (never 404)
    const cases = [
      ['/', 'https://builder.opsagents.agency/'],
      ['/index.html', 'https://builder.opsagents.agency/'],
      ['/board', 'https://builder.opsagents.agency/board'],
      ['/board/', 'https://builder.opsagents.agency/board'],
      ['/campfire', 'https://builder.opsagents.agency/campfire']
    ];
    for (const [p, dest] of cases) {
      const res = await get(p);
      assert.strictEqual(res.status, 301, `${p} must 301`);
      assert.strictEqual(res.headers.get('location'), dest, `${p} Location`);
    }

    // step 3 — published demo sites are NOT redirected or gone (404 here only
    // because no GCS bucket is configured in tests; live sites keep resolving)
    const site = await get('/sites/some-demo-site');
    assert.ok(site.status !== 301 && site.status !== 410,
      `/sites/{id} must keep serving (got ${site.status})`);

    // monitoring stays up
    const health = await get('/api/health');
    assert.strictEqual(health.status, 200, '/api/health must stay 200');
    const healthz = await get('/healthz');
    assert.strictEqual(healthz.status, 200, '/healthz must stay 200');

    // CORS preflight still answered (not 410) so cross-origin error surfaces cleanly
    const preflight = await fetch(base + '/api/build', { method: 'OPTIONS' });
    assert.strictEqual(preflight.status, 204, 'OPTIONS preflight must stay 204');
  } finally {
    server.close();
  }
});
