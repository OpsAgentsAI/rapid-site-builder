'use strict';
// Never-fail builds (card aAp5r5af): a TOTAL engine failure mid-run must still
// end the SSE stream with a rendered `site` event (deterministic category-aware
// fallback), never a bare `error` end-state. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

// Force the engine "configured but broken" BEFORE the app loads: ENABLED must
// be true to get past the 503 guard, and runBuild throws like a real outage.
const engine = require('../lib/engine');
engine.ENABLED = true;
engine.runBuild = async () => { throw new Error('agent-engine returned no events across all phases'); };

const { app } = require('../server');

function collectSse(body) {
  return body.split('\n\n')
    .map(chunk => chunk.split('\n').find(l => l.startsWith('data:')))
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
    .filter(Boolean);
}

test('engine throw → deterministic fallback site, no error end-state', async () => {
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: 'Cafe Luna', category: 'food_beverage', description: 'a cozy neighborhood coffee shop', lang: 'en' })
    });
    assert.equal(r.status, 200);
    const events = collectSse(await r.text());
    const types = events.map(e => e.type);

    assert.ok(types.includes('start'), 'stream starts');
    assert.ok(!types.includes('error'), `no error end-state, got: ${types.join(',')}`);
    const site = events.find(e => e.type === 'site');
    assert.ok(site, 'a site event always arrives');
    assert.equal(site.spec.business, 'Cafe Luna');
    assert.ok(site.html && site.html.includes('Cafe Luna'), 'fallback site is rendered html');
    assert.ok(
      events.some(e => e.type === 'step' && /turbulence/.test(e.text || '')),
      'honest system line tells the user the draft came from the playbook'
    );
    assert.equal(types[types.length - 1], 'done', 'stream still closes cleanly');
  } finally {
    server.close();
  }
});
