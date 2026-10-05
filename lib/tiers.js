'use strict';
// Tier definitions (card 1z5hAnJv — BYOK-B). Managed vs BYOK as CODE.
//
// Two orthogonal axes now describe a tenant:
//
//   plan: 'free' | 'paid'        — billing state (card KY2YTmoL, lib/entitlements.js)
//   tier: 'managed' | 'byok'     — WHO owns the cloud + model credentials (this file)
//
// The tier axis keys off the BYOK-A seam (card Azz8fInK, lib/providerConfig.js
// on main): resolveProviderConfig() returns `source: 'byok'|'managed'` — a build
// is BYOK only when the tenant brought their own MODEL creds (Agent Engine
// resource or image project). This module maps that seam to entitlement
// capabilities, so pricing/enforcement decisions live in one place.
//
//   🏢 managed — we host cloud + AI on OUR keys. Premium: managed AI quota,
//                managed hosting/SLA, cost passthrough is ours to absorb.
//   🔑 byok    — customer brings their OWN Vertex/Arize keys (software-only
//                license). Cheaper entry; model/observability spend is theirs.
//
// Tenant record shape (tenants/{uid}.json in the published-sites bucket,
// introduced by KY2YTmoL): this module only READS an optional `tier` field on
// that record and defaults it to 'managed' — the safe direction, because a
// tenant with no BYOK keys configured can only build on managed credentials
// anyway (mirrors providerConfig's managed-by-default posture). It never
// writes: admin set-tier wiring is a documented post-merge TODO (below).
//
// HARD STOP honored: NO price, currency, or amount appears anywhere in this
// module — prices are a Michal-approval-gated draft in
// docs/PRICING-TIERS-DRAFT.md and never ship in code.
//
// NO WIRE-UP IN THIS PR (sibling-PR boundary): server.js and
// lib/entitlements.js belong to other open PRs this cycle. Post-merge TODOs:
//   TODO(1z5hAnJv+1): /api/admin/set-plan grows a sibling set-tier (or the
//     record gains `tier` in the same admin reconcile) — validate with
//     normTier() from here.
//   TODO(1z5hAnJv+1): /api/entitlement response includes `tier` +
//     capabilities() so the UI can render the right upsell.
//   TODO(1z5hAnJv+1): build path calls assertTierConsistency(tenant,
//     resolveProviderConfig(...)) once providerConfig.js lands on real-app
//     (it is merged on main; real-app has not taken that merge yet).

const TIER_NAMES = ['managed', 'byok'];
const DEFAULT_TIER = 'managed';

// Capability map — the single source of truth for what each tier entitles.
// Booleans only; anything numeric (caps, quotas, prices) is deliberately NOT
// here: quotas stay env-tunable (entitlements.js pattern) and prices stay in
// the approval-gated draft doc.
const TIERS = Object.freeze({
  managed: Object.freeze({
    name: 'managed',
    // Model + image calls run on OUR credentials (providerConfig source 'managed').
    managedAI: true,
    // Tenant does not need to supply Vertex/Arize keys.
    requiresProviderKeys: false,
    // We run the hosting surface (Cloud Run + Hosting) for the tenant.
    managedHosting: true,
    // Observability sink (Arize Phoenix) on our space by default.
    managedObservability: true,
    // Operator-grade support/SLA is part of the offer.
    slaSupport: true,
    // Model/cloud consumption is absorbed by us (priced into the tier).
    providerCostsBilledToTenant: false,
  }),
  byok: Object.freeze({
    name: 'byok',
    managedAI: false,
    // The defining trait: tenant MUST bring their own model creds — this is
    // exactly providerConfig's byok condition (agentEngine.resource or
    // image.project supplied by the tenant).
    requiresProviderKeys: true,
    managedHosting: false,
    managedObservability: false,
    slaSupport: false,
    providerCostsBilledToTenant: true,
  }),
});

// 'byok' (any case) is byok; everything else — including undefined, legacy
// records without a tier field, and garbage — is 'managed'.
function normTier(v) {
  return String(v || '').toLowerCase() === 'byok' ? 'byok' : DEFAULT_TIER;
}

// The tenant's tier, read off the KY2YTmoL tenant record (or any object
// carrying a `tier` field). Null/missing record → default tier.
function tierOf(tenant) {
  return normTier(tenant && tenant.tier);
}

function capabilities(tier) {
  return TIERS[normTier(tier)];
}

// Map BYOK-A's resolved provider source onto the tier this build LOOKS like.
// (source 'byok' ⇒ tenant-supplied model creds ⇒ byok-shaped build.)
function tierFromProviderSource(source) {
  return source === 'byok' ? 'byok' : 'managed';
}

// tierGate(tenant, capability) — same contract shape as entitlements'
// publishGate so callers compose them uniformly: { ok:true } or
// { ok:false, status, body }. Pure (no I/O) so the enforcement contract is
// unit-testable.
//
// A capability the tier carries → pass. A capability the tier lacks → 403 with
// a machine-readable body naming the tier and the missing capability (the UI
// upsell can key off `upgrade: true` exactly like the 402 entitlement upsell).
// Unknown capability names fail CLOSED (403) — a typo must never silently
// grant access. Copy is price-free on purpose (pricing hard stop).
function tierGate(tenant, capability) {
  const tier = tierOf(tenant);
  const caps = TIERS[tier];
  const known = Object.prototype.hasOwnProperty.call(caps, capability) && capability !== 'name';
  if (known && caps[capability] === true) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: {
      error: known
        ? `Your ${tier} tier does not include this capability. Upgrade to unlock it.`
        : 'Unknown capability.',
      upgrade: known,
      tier,
      capability: String(capability).slice(0, 100),
    },
  };
}

// Consistency check between the DECLARED tier (tenant record) and the RESOLVED
// provider source (BYOK-A). Returns { ok, warnings:[] } — advisory, never
// throws: a mismatch is an operator/billing signal, not a build blocker
// (fail-open mirrors providerConfig's malformed-config posture).
//   byok tier + managed source  → tenant is billed byok but burning OUR model
//                                 quota — the exact leak BYOK-B exists to stop.
//   managed tier + byok source  → tenant brought keys but is on the managed
//                                 tier — upsell/repricing signal, harmless.
function assertTierConsistency(tenant, providerConfig) {
  const declared = tierOf(tenant);
  const resolved = tierFromProviderSource(providerConfig && providerConfig.source);
  const warnings = [];
  if (declared === 'byok' && resolved === 'managed') {
    warnings.push('byok-tier tenant is building on MANAGED provider credentials (no tenant keys resolved) — managed model spend is leaking to a byok tenant.');
  } else if (declared === 'managed' && resolved === 'byok') {
    warnings.push('managed-tier tenant supplied their own provider keys — consider the byok tier (repricing signal, not an error).');
  }
  return { ok: warnings.length === 0, declared, resolved, warnings };
}

module.exports = {
  TIER_NAMES, DEFAULT_TIER, TIERS,
  normTier, tierOf, capabilities, tierFromProviderSource, tierGate, assertTierConsistency,
};
