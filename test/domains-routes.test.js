'use strict';
// Connect-your-domain route gates (card DYE9159z). In the test env neither
// FIREBASE_HOSTING_SITE nor the auth env is set, so both routes must fail
// closed (503) BEFORE any Firebase Hosting call — a domain attach never happens
// during CI. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../server');

function listen() {
  return new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
}

test('POST /api/domains/connect fails closed (503) when custom domains are not configured', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/domains/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'abcd1234', domain: 'shop.example.com' })
    });
    assert.strictEqual(res.status, 503);
    const j = await res.json();
    assert.match(j.error, /not configured/);
  } finally { server.close(); }
});

test('GET /api/domains/status fails closed (503) when custom domains are not configured', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/domains/status?siteId=abcd1234`);
    assert.strictEqual(res.status, 503);
  } finally { server.close(); }
});

test('/api/health reports the customDomains flag', async () => {
  const server = await listen();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(typeof j.customDomains, 'boolean');
    assert.strictEqual(j.customDomains, false, 'unconfigured test env → disabled');
  } finally { server.close(); }
});
