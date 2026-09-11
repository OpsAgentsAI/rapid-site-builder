'use strict';
// Admin multi-tenant board (card 1BzUR9n2, Dash-E). Two things under test:
// (1) groupTenants — the pure server-side grouping the admin view renders:
//     account tenants by owner email, anonymous-device tenants by the HASHED
//     device key (the raw device id is a possession credential and never leaves
//     the server), a catch-all anonymous bucket, newest-activity-first ordering.
// (2) the /api/admin/tenants gate: non-admins get a 404 (never a 403 — the
//     surface's existence is not confirmed), an x-admin-key admin gets data.
// Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const { app, groupTenants } = require('../server');

test('groupTenants groups by owner email, hashed device key, then anonymous', () => {
  const tenants = groupTenants([
    { id: 'aaaaaaaa', business: 'Cafe Luna', createdAt: '2026-08-01T10:00:00Z', ownerEmail: 'x@y.com', deviceKey: '', url: 'u1' },
    { id: 'bbbbbbbb', business: 'Cafe Luna 2', createdAt: '2026-08-03T10:00:00Z', ownerEmail: 'X@Y.com', deviceKey: '', url: 'u2' },
    { id: 'cccccccc', business: 'Pilates', createdAt: '2026-08-02T10:00:00Z', ownerEmail: '', deviceKey: 'abc123def456', url: 'u3' },
    { id: 'dddddddd', business: 'Bakery', createdAt: '2026-07-30T10:00:00Z', ownerEmail: '', deviceKey: '', url: 'u4' }
  ]);
  assert.equal(tenants.length, 3, 'two same-email sites merge into one account tenant (case-insensitive)');
  const kinds = tenants.map(t => t.kind);
  assert.deepStrictEqual(kinds, ['account', 'device', 'anonymous'], 'newest-activity-first ordering');
  const acct = tenants[0];
  assert.equal(acct.siteCount, 2);
  assert.equal(acct.sites[0].id, 'bbbbbbbb', 'sites newest-first within a tenant');
  assert.equal(acct.lastActivity, '2026-08-03T10:00:00Z');
  const dev = tenants[1];
  assert.equal(dev.label, 'device · abc123def456', 'device tenants are labeled by the hashed key only');
  assert.ok(!JSON.stringify(tenants).includes('ownerUid'), 'no internal ids in the payload');
});

test('groupTenants handles empty and missing input', () => {
  assert.deepStrictEqual(groupTenants([]), []);
  assert.deepStrictEqual(groupTenants(undefined), []);
});

async function getTenants(headers) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/tenants`, { headers: headers || {} });
    return { status: r.status, json: await r.json() };
  } finally {
    server.close();
  }
}

test('non-admin gets 404 — the surface is never confirmed', async () => {
  delete process.env.ADMIN_KEY;
  const { status } = await getTenants();
  assert.equal(status, 404);
});

test('x-admin-key admin gets the tenant list (empty without a bucket)', async () => {
  process.env.ADMIN_KEY = 'test-admin-key';
  try {
    const wrong = await getTenants({ 'x-admin-key': 'wrong' });
    assert.equal(wrong.status, 404, 'wrong key is still a 404');
    const { status, json } = await getTenants({ 'x-admin-key': 'test-admin-key' });
    assert.equal(status, 200);
    assert.deepStrictEqual(json.tenants, [], 'no bucket configured in tests → empty list, not an error');
    assert.equal(json.tenantCount, 0);
    assert.equal(json.siteCount, 0);
  } finally {
    delete process.env.ADMIN_KEY;
  }
});
