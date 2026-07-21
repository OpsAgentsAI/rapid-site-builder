'use strict';
// Tier unit tests (card 1z5hAnJv — BYOK-B) — run with `npm test` (node --test).
// Pure logic only: tier normalization, capability maps, the tierGate contract
// (same { ok / status / body } shape as entitlements' publishGate), the
// BYOK-A provider-source mapping, declared-vs-resolved consistency, and the
// pricing hard stop (no currency/price ever ships in tier code or copy).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tiers = require('../lib/tiers');

test('normTier: only "byok" (any case) is byok; everything else is managed', () => {
  assert.equal(tiers.normTier('byok'), 'byok');
  assert.equal(tiers.normTier('BYOK'), 'byok');
  assert.equal(tiers.normTier('managed'), 'managed');
  assert.equal(tiers.normTier(''), 'managed');
  assert.equal(tiers.normTier(undefined), 'managed');
  assert.equal(tiers.normTier('premium'), 'managed');
  assert.equal(tiers.DEFAULT_TIER, 'managed');
});

test('tierOf: reads the KY2YTmoL tenant record shape; missing/legacy records default to managed', () => {
  // Legacy KY2YTmoL record — plan only, no tier field.
  assert.equal(tiers.tierOf({ plan: 'paid', updatedAt: '2026-07-17T00:00:00Z' }), 'managed');
  // Extended record — tier orthogonal to plan.
  assert.equal(tiers.tierOf({ plan: 'paid', tier: 'byok' }), 'byok');
  assert.equal(tiers.tierOf({ plan: 'free', tier: 'byok' }), 'byok');
  assert.equal(tiers.tierOf(null), 'managed');
  assert.equal(tiers.tierOf(undefined), 'managed');
});

test('capability map: managed hosts on our keys; byok requires tenant keys', () => {
  const m = tiers.capabilities('managed');
  const b = tiers.capabilities('byok');
  assert.equal(m.managedAI, true);
  assert.equal(m.requiresProviderKeys, false);
  assert.equal(m.managedHosting, true);
  assert.equal(m.slaSupport, true);
  assert.equal(m.providerCostsBilledToTenant, false);
  assert.equal(b.managedAI, false);
  assert.equal(b.requiresProviderKeys, true);
  assert.equal(b.managedHosting, false);
  assert.equal(b.slaSupport, false);
  assert.equal(b.providerCostsBilledToTenant, true);
  // Unknown tier resolves to the managed map, never undefined.
  assert.equal(tiers.capabilities('nope').name, 'managed');
});

test('tier definitions are frozen — no runtime mutation of entitlements', () => {
  assert.ok(Object.isFrozen(tiers.TIERS));
  assert.ok(Object.isFrozen(tiers.TIERS.managed));
  assert.ok(Object.isFrozen(tiers.TIERS.byok));
  assert.throws(() => { 'use strict'; tiers.TIERS.byok.managedAI = true; }, TypeError);
});

test('tierGate: granted capability passes', () => {
  assert.deepEqual(tiers.tierGate({ tier: 'managed' }, 'managedAI'), { ok: true });
  assert.deepEqual(tiers.tierGate({ tier: 'byok' }, 'requiresProviderKeys'), { ok: true });
  // Default tier (no record) carries managed capabilities.
  assert.deepEqual(tiers.tierGate(null, 'managedHosting'), { ok: true });
});

test('tierGate: missing capability → 403 with a machine-readable upsell body', () => {
  const g = tiers.tierGate({ plan: 'paid', tier: 'byok' }, 'managedAI');
  assert.equal(g.ok, false);
  assert.equal(g.status, 403);
  assert.equal(g.body.upgrade, true);
  assert.equal(g.body.tier, 'byok');
  assert.equal(g.body.capability, 'managedAI');
  assert.ok(g.body.error);
});

test('tierGate: unknown capability fails CLOSED and is not an upsell', () => {
  for (const cap of ['definitelyNotACapability', 'name', '', undefined]) {
    const g = tiers.tierGate({ tier: 'managed' }, cap);
    assert.equal(g.ok, false, `capability ${String(cap)} must not pass`);
    assert.equal(g.status, 403);
    assert.equal(g.body.upgrade, false);
  }
});

test('tierGate: plan and tier are orthogonal — plan never changes the tier verdict', () => {
  for (const plan of ['free', 'paid']) {
    assert.equal(tiers.tierGate({ plan, tier: 'byok' }, 'managedAI').ok, false);
    assert.equal(tiers.tierGate({ plan, tier: 'managed' }, 'managedAI').ok, true);
  }
});

test('tierFromProviderSource: maps the BYOK-A providerConfig source seam', () => {
  // resolveProviderConfig() (lib/providerConfig.js on main) returns
  // source: 'byok' | 'managed' — byok only when tenant model creds resolved.
  assert.equal(tiers.tierFromProviderSource('byok'), 'byok');
  assert.equal(tiers.tierFromProviderSource('managed'), 'managed');
  assert.equal(tiers.tierFromProviderSource(undefined), 'managed');
});

test('assertTierConsistency: byok tier on managed creds = spend leak warning', () => {
  const r = tiers.assertTierConsistency({ tier: 'byok' }, { source: 'managed' });
  assert.equal(r.ok, false);
  assert.equal(r.declared, 'byok');
  assert.equal(r.resolved, 'managed');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /leak/i);
});

test('assertTierConsistency: managed tier with tenant keys = repricing signal, not an error', () => {
  const r = tiers.assertTierConsistency({ tier: 'managed' }, { source: 'byok' });
  assert.equal(r.ok, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /repricing/i);
});

test('assertTierConsistency: matched declared/resolved is clean (both tiers)', () => {
  assert.deepEqual(
    tiers.assertTierConsistency({ tier: 'byok' }, { source: 'byok' }).warnings, []);
  assert.deepEqual(
    tiers.assertTierConsistency({ tier: 'managed' }, { source: 'managed' }).warnings, []);
  // Null-safe: no record + no config = managed/managed, clean.
  assert.equal(tiers.assertTierConsistency(null, null).ok, true);
});

test('pricing hard stop: no currency or price number ships in tier code', () => {
  // Same posture as KY2YTmoL's currency scan on entitlement copy: the tier
  // module (and this test) must never carry a price — prices live only in the
  // Michal-approval-gated docs/PRICING-TIERS-DRAFT.md, never in code.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tiers.js'), 'utf8');
  assert.ok(!/[$₪€£]\s?\d/.test(src), 'currency amount found in lib/tiers.js');
  assert.ok(!/\d+\s?(USD|ILS|NIS|EUR)\b/i.test(src), 'currency code amount found in lib/tiers.js');
  assert.ok(!/price[sd]?\s*[:=]\s*\d/i.test(src), 'numeric price literal found in lib/tiers.js');
});
