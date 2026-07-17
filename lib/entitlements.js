'use strict';
// Entitlements (card KY2YTmoL) — free/paid account plans for the auth-ON surface.
//
// The tenant record is one tiny JSON object in the SAME published-sites bucket
// the app already uses (tenants/{uid}.json, mirroring owners/{uid}/) — no new
// database. Everyone defaults to "free"; "paid" is set manually through the
// admin reconcile endpoint after the recurring payment is confirmed out-of-band.
//
// Free tier: up to FREE_SITE_CAP live sites per account; each free publish is
// stamped expiresAt (+FREE_SITE_TTL_DAYS) in its meta and carries a small
// "Free site" badge on the published page. Paid: no cap, no badge, no expiry.
//
// Checkout is an EXTERNAL recurring-payment page — this codebase only links to
// it via the operator-set CHECKOUT_URL env var, and every checkout CTA hides
// itself when that is unset. Deliberately price-free: no price number lives
// anywhere in this repo (pricing is approved separately).
//
// Fail direction on a tenant-record read blip: treat as "free" — the safe
// (revenue-guarding) side. A paid customer would at worst see the free gate
// for one request, never the other way around.

const { loadTenant, saveTenant } = require('./store');

const FREE_SITE_CAP = Number(process.env.FREE_SITE_CAP) || 3;
const FREE_SITE_TTL_DAYS = Number(process.env.FREE_SITE_TTL_DAYS) || 30;
// Only an https URL may ever reach an href — anything else renders as no link.
const RAW_CHECKOUT = (process.env.CHECKOUT_URL || '').trim();
const CHECKOUT_URL = /^https:\/\/[^"'<>\s]+$/.test(RAW_CHECKOUT) ? RAW_CHECKOUT : '';

// Manual-reconcile allowlist (admin gate). Comma-separated, case-insensitive;
// the default is the operator's two identities.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'michal@opsagents.agency,michal@msapps.mobi')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const PLANS = ['free', 'paid'];

function normPlan(v) {
  return String(v || '').toLowerCase() === 'paid' ? 'paid' : 'free';
}

function isAdmin(email) {
  return !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());
}

// The caller's plan, defaulting (and failing) to 'free'.
async function getPlan(uid) {
  if (!uid) return 'free';
  try {
    const t = await loadTenant(uid);
    return normPlan(t && t.plan);
  } catch {
    return 'free';
  }
}

async function setPlan(uid, plan, actor) {
  const record = {
    plan: normPlan(plan),
    updatedAt: new Date().toISOString(),
    ...(actor ? { updatedBy: String(actor).slice(0, 200) } : {})
  };
  await saveTenant(uid, record);
  return record;
}

// The 402 upsell body. Copy is price-free on purpose (pricing hard stop).
function upsell() {
  return {
    error: `Your free plan is full (${FREE_SITE_CAP} live sites). Upgrade to keep publishing.`,
    upgrade: true,
    plan: 'free',
    cap: FREE_SITE_CAP,
    ...(CHECKOUT_URL ? { checkoutUrl: CHECKOUT_URL } : {})
  };
}

// Pure gate decision (no I/O) so the enforcement contract is unit-testable:
// paid always passes; free passes while the account owns fewer than
// FREE_SITE_CAP live sites, else 402 + upsell.
function publishGate({ plan, ownedCount }) {
  if (normPlan(plan) === 'paid') return { ok: true };
  if (Number(ownedCount) >= FREE_SITE_CAP) return { ok: false, status: 402, body: upsell() };
  return { ok: true };
}

function freeExpiresAt(now) {
  return new Date((now == null ? Date.now() : now) + FREE_SITE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
}

// Small fixed badge injected server-side into the renderer's output at publish
// time for FREE-tier sites (never client HTML). Static markup — the only
// dynamic part is CHECKOUT_URL, already validated https-only above.
function injectFreeBadge(html) {
  const badge =
    '<div id="rsb-free-badge" style="position:fixed;bottom:14px;left:14px;z-index:9999;' +
    'font:600 12px/1.2 system-ui,sans-serif;background:rgba(30,33,56,.85);color:#fff;' +
    'padding:8px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25)">Free site' +
    (CHECKOUT_URL
      ? ' &middot; <a href="' + CHECKOUT_URL + '" target="_blank" rel="noopener" ' +
        'style="color:#FFB38A;text-decoration:underline">keep it live</a>'
      : '') +
    '</div>';
  const s = String(html);
  const i = s.lastIndexOf('</body>');
  return i < 0 ? s + badge : s.slice(0, i) + badge + s.slice(i);
}

module.exports = {
  FREE_SITE_CAP, FREE_SITE_TTL_DAYS, CHECKOUT_URL, PLANS,
  normPlan, isAdmin, getPlan, setPlan, upsell, publishGate, freeExpiresAt, injectFreeBadge
};
