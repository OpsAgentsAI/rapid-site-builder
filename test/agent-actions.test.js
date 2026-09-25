'use strict';
// Live approval actions v1 (card 7uOa4dJ8): the board's approve/decline gate
// posts here. The contract under test: (1) the decision is always RECORDED
// (ok:true) once validation passes, (2) the live orchestrator is notified with
// ONE real turn when the engine is up, (3) engine trouble degrades to an honest
// engineNotified:false — never a failed request, because the audit already
// landed, and (4) nothing but known roster agents + the two verbs get through.
// Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../lib/engine');

const { app } = require('../server');

async function actOnce(body) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: r.status, json: await r.json() };
  } finally {
    server.close();
  }
}

test('approve → recorded + one real orchestrator turn, ack returned', async () => {
  engine.ENABLED = true;
  const calls = [];
  engine.oneTurn = async (prompt) => {
    calls.push(prompt);
    return 'Thank you — Uri will roll the update out carefully.';
  };
  const { status, json } = await actOnce({
    agent: 'uri', action: 'approve', business: 'Cafe Luna',
    siteUrl: 'https://example.com/sites/abc12345', lang: 'en'
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.engineNotified, true);
  assert.match(json.ack, /Uri will roll/);
  assert.ok(json.id && json.at, 'audit id + timestamp returned');
  assert.equal(calls.length, 1, 'exactly one engine turn');
  assert.match(calls[0], /APPROVED/, 'the decision reaches the orchestrator');
  assert.match(calls[0], /uri/, 'the agent is named in the turn');
  assert.match(calls[0], /Cafe Luna/, 'the site context rides along');
});

test('decline → recorded, decision verb reaches the orchestrator', async () => {
  engine.ENABLED = true;
  const calls = [];
  engine.oneTurn = async (prompt) => { calls.push(prompt); return 'Understood — nothing changes without you.'; };
  const { status, json } = await actOnce({ agent: 'uri', action: 'decline' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.engineNotified, true);
  assert.match(calls[0], /DECLINED/);
});

test('engine down → still recorded, honest engineNotified:false', async () => {
  engine.ENABLED = false;
  engine.oneTurn = async () => { throw new Error('must not be called'); };
  const { status, json } = await actOnce({ agent: 'uri', action: 'approve' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.engineNotified, false);
  assert.equal(json.ack, '');
});

test('engine turn throws → still recorded, engineNotified:false (audit already landed)', async () => {
  engine.ENABLED = true;
  engine.oneTurn = async () => { throw new Error('engine turbulence'); };
  const { status, json } = await actOnce({ agent: 'vera', action: 'approve' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.engineNotified, false);
});

test('unknown agent or verb → 400, no engine call', async () => {
  engine.ENABLED = true;
  let called = 0;
  engine.oneTurn = async () => { called++; return 'nope'; };
  for (const body of [
    { agent: 'theo', action: 'approve' },        // not a roster id
    { agent: 'uri', action: 'publish' },         // invented verb
    { agent: '', action: 'approve' },
    { action: 'approve' }
  ]) {
    const { status } = await actOnce(body);
    assert.equal(status, 400, JSON.stringify(body) + ' must be rejected');
  }
  assert.equal(called, 0, 'invalid requests never reach the engine');
});
