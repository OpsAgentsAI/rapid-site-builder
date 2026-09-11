'use strict';
/*
 * Card WWGnAZUR — the anonymous engine budget.
 *
 * WHY THIS EXISTS
 * Every client demo deck now closes on https://builder.opsagents.agency/ and
 * tells the recipient they can type a brief and watch it build. Before this
 * budget the only thing between an unauthenticated caller and a Vertex-billed
 * build was the PER-IP limiter, which bounds one visitor and says nothing about
 * a thousand: N unique IPs cost N × BUILDS_PER_HOUR_PER_IP builds, and a deck
 * link reaches many IPs by design.
 *
 * The gates are asserted in ORDER and by their DISTINCT bodies, because "a 429
 * came back" is not the same claim as "the budget fired" — the per-IP limiter
 * returns 429 too, and a test that only counted statuses would pass with the
 * budget deleted.
 *
 * No build ever runs here: every request below is refused at a gate that sits
 * above the engine call, so this suite costs nothing to run. That is the same
 * no-engine-burn rule the card's own QA respects.
 */

// Roomy per-IP budget, tiny anonymous one — so the ANON gate is what a single
// caller hits, which is the interaction under test.
process.env.BUILDS_PER_HOUR_PER_IP = '50';
process.env.ANON_BUILDS_PER_HOUR = '2';

const test = require('node:test');
const assert = require('node:assert');
const { app, hourlyBudget } = require('../server');

function listen() {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

const build = (port, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/api/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ business: 'Test Co', description: 'a one line description' })
  });

test('hourlyBudget: one pool for everyone, and peek does not consume it', () => {
  const b = hourlyBudget(2);
  assert.strictEqual(b.peek(), true);
  assert.strictEqual(b.peek(), true, 'peeking twice burns nothing');
  assert.strictEqual(b(), true);
  assert.strictEqual(b(), true);
  assert.strictEqual(b.peek(), false, 'exhausted → peek says so');
  assert.strictEqual(b(), false);
});

test('hourlyBudget: unlike the per-IP limiter, the caller identity is irrelevant', () => {
  // This is the whole point of the card. The per-IP limiter gives every new
  // address a fresh allowance; this pool does not.
  const b = hourlyBudget(1);
  assert.strictEqual(b(), true);
  assert.strictEqual(b(), false, 'a second caller, however different, shares the pool');
});

test('anonymous builds stop at the pool ceiling, from DIFFERENT IPs', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    // Three distinct addresses, so the per-IP limiter (50) cannot be what stops
    // the third — before this budget existed, all three would have proceeded.
    const a = await build(port, { 'X-Forwarded-For': '203.0.113.10' });
    const b = await build(port, { 'X-Forwarded-For': '203.0.113.11' });
    const c = await build(port, { 'X-Forwarded-For': '203.0.113.12' });

    // The first two pass the budget. They then hit the next gate down — this
    // deployment has no Agent Engine configured, so 503 — which is itself the
    // proof that no build was billed to run this test.
    for (const [i, r] of [a, b].entries()) {
      assert.notStrictEqual(r.status, 429, `request ${i + 1} should have passed the budget`);
    }

    assert.strictEqual(c.status, 429, 'the third anonymous build is over the ceiling');
    const body = await c.json();
    assert.strictEqual(
      body.code, 'anon_engine_budget_exhausted',
      'the ANON budget must be distinguishable from the per-IP limiter, which also 429s'
    );
  } finally {
    server.close();
  }
});

test('the refusal tells the caller what to do about it', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    // Budget already exhausted by the test above (same module instance).
    const r = await build(port, { 'X-Forwarded-For': '203.0.113.13' });
    assert.strictEqual(r.status, 429);
    const body = await r.json();
    assert.match(
      body.error, /sign in/i,
      'a dead end with no next step is how a deck recipient leaves and does not come back'
    );
  } finally {
    server.close();
  }
});
