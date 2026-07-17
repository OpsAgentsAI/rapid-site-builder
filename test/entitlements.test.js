'use strict';
// Entitlement unit tests (card KY2YTmoL) — run with `npm test` (node --test).
// Covers the pure gate/badge/admin logic only: publishGate (the enforcement
// contract /api/publish relies on), plan normalization, free-tier expiry,
// badge injection, CHECKOUT_URL validation, the admin allowlist, and the
// pricing hard stop (no currency ever ships in entitlement copy).
// No GCS calls anywhere — getPlan/setPlan are thin wrappers over lib/store.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ENT_PATH = path.join(__dirname, '..', 'lib', 'entitlements.js');
const STORE_PATH = path.join(__dirname, '..', 'lib', 'store.js');
const ENV_KEYS = ['FREE_SITE_CAP', 'FREE_SITE_TTL_DAYS', 'CHECKOUT_URL', 'ADMIN_EMAILS'];

// Fresh module instance under a controlled env (same pattern as auth.test.js —
// the module reads env at require time).
function freshEnt(env) {
  delete require.cache[require.resolve(ENT_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env || {});
  const mod = require(ENT_PATH);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

test('normPlan: only "paid" (any case) is paid, everything else is free', () => {
  const ent = freshEnt();
  assert.equal(ent.normPlan('paid'), 'paid');
  assert.equal(ent.normPlan('PAID'), 'paid');
  assert.equal(ent.normPlan('free'), 'free');
  assert.equal(ent.normPlan(''), 'free');
  assert.equal(ent.normPlan(undefined), 'free');
  assert.equal(ent.normPlan('premium'), 'free');
});

test('publishGate: free passes under the default cap of 3', () => {
  const ent = freshEnt();
  assert.equal(ent.FREE_SITE_CAP, 3);
  assert.deepEqual(ent.publishGate({ plan: 'free', ownedCount: 0 }), { ok: true });
  assert.deepEqual(ent.publishGate({ plan: 'free', ownedCount: 2 }), { ok: true });
});

test('publishGate: free at/over the cap gets 402 with an upsell payload', () => {
  const ent = freshEnt();
  for (const n of [3, 4, 100]) {
    const g = ent.publishGate({ plan: 'free', ownedCount: n });
    assert.equal(g.ok, false);
    assert.equal(g.status, 402);
    assert.equal(g.body.upgrade, true);
    assert.equal(g.body.plan, 'free');
    assert.equal(g.body.cap, 3);
    assert.ok(g.body.error);
    // CHECKOUT_URL unset → the upsell carries no checkout link at all.
    assert.ok(!('checkoutUrl' in g.body));
  }
});

test('publishGate: paid never hits the cap', () => {
  const ent = freshEnt();
  assert.deepEqual(ent.publishGate({ plan: 'paid', ownedCount: 500 }), { ok: true });
});

test('publishGate: FREE_SITE_CAP env override is honored', () => {
  const ent = freshEnt({ FREE_SITE_CAP: '1' });
  assert.deepEqual(ent.publishGate({ plan: 'free', ownedCount: 0 }), { ok: true });
  assert.equal(ent.publishGate({ plan: 'free', ownedCount: 1 }).status, 402);
});

test('CHECKOUT_URL: https URLs pass through; anything else is dropped', () => {
  assert.equal(freshEnt({ CHECKOUT_URL: 'https://pay.example.com/page/abc' }).CHECKOUT_URL,
    'https://pay.example.com/page/abc');
  assert.equal(freshEnt({ CHECKOUT_URL: 'http://pay.example.com/x' }).CHECKOUT_URL, '');
  assert.equal(freshEnt({ CHECKOUT_URL: 'javascript:alert(1)' }).CHECKOUT_URL, '');
  assert.equal(freshEnt({ CHECKOUT_URL: 'https://x.com/a"onclick="y' }).CHECKOUT_URL, '');
  assert.equal(freshEnt().CHECKOUT_URL, '');
});

test('upsell carries checkoutUrl only when a valid CHECKOUT_URL is set', () => {
  const url = 'https://pay.example.com/keep-live';
  const withUrl = freshEnt({ CHECKOUT_URL: url });
  assert.equal(withUrl.publishGate({ plan: 'free', ownedCount: 9 }).body.checkoutUrl, url);
});

test('freeExpiresAt: default 30 days out, env-overridable', () => {
  const ent = freshEnt();
  const now = Date.UTC(2026, 0, 1);
  assert.equal(ent.freeExpiresAt(now), new Date(now + 30 * 24 * 3600 * 1000).toISOString());
  const short = freshEnt({ FREE_SITE_TTL_DAYS: '7' });
  assert.equal(short.freeExpiresAt(now), new Date(now + 7 * 24 * 3600 * 1000).toISOString());
});

test('injectFreeBadge: lands before </body>, links only when checkout is set', () => {
  const html = '<html><body><h1>Site</h1></body></html>';
  const plain = freshEnt().injectFreeBadge(html);
  assert.ok(plain.includes('rsb-free-badge'));
  assert.ok(plain.indexOf('rsb-free-badge') < plain.lastIndexOf('</body>'));
  assert.ok(!plain.includes('<a href'), 'no checkout configured → no link');

  const url = 'https://pay.example.com/keep-live';
  const linked = freshEnt({ CHECKOUT_URL: url }).injectFreeBadge(html);
  assert.ok(linked.includes(`href="${url}"`));
  assert.ok(linked.includes('rel="noopener"'));

  // No </body> (defensive) → badge appended, page still whole.
  const appended = freshEnt().injectFreeBadge('<h1>bare</h1>');
  assert.ok(appended.startsWith('<h1>bare</h1>'));
  assert.ok(appended.includes('rsb-free-badge'));
});

test('pricing hard stop: entitlement copy never carries a currency amount', () => {
  const ent = freshEnt({ CHECKOUT_URL: 'https://pay.example.com/x' });
  const surfaces = [
    JSON.stringify(ent.upsell()),
    ent.injectFreeBadge('<body></body>')
  ];
  for (const s of surfaces) {
    assert.ok(!/[$₪€£]\s?\d|\d\s?[$₪€£]/.test(s), 'no price numbers in: ' + s);
  }
});

test('isAdmin: default allowlist, case-insensitive, env-overridable', () => {
  const ent = freshEnt();
  assert.equal(ent.isAdmin('michal@opsagents.agency'), true);
  assert.equal(ent.isAdmin('Michal@MSApps.mobi'), true);
  assert.equal(ent.isAdmin('someone@else.com'), false);
  assert.equal(ent.isAdmin(''), false);
  assert.equal(ent.isAdmin(undefined), false);
  const custom = freshEnt({ ADMIN_EMAILS: 'ops@example.com' });
  assert.equal(custom.isAdmin('ops@example.com'), true);
  assert.equal(custom.isAdmin('michal@opsagents.agency'), false);
});
