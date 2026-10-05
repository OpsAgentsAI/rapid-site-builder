'use strict';
// Card uLLFw04n (CTO ruling 5399696225): the builder's paid offer shows ONLY the price the
// products server serves. No literal price lives in this repo — not in web/, not here.
//
// The products server (opsagent-chat-api /v1/products) sends no CORS header for the builder's
// origin, so the browser cannot read it directly; this server reads it and hands the browser
// the one row it needs via GET /api/price. Any failure is `null`, and the page then hides the
// offer — never a fallback number.

const DEFAULT_PRODUCTS_URL = 'https://opsagent-chat-api-zadkrinzra-uc.a.run.app/v1/products';
const SLUG = 'rapid-site-builder';
const TTL_MS = 10 * 60 * 1000;

/** The products row → the fields the offer needs, or null when the row cannot back an offer. */
function priceFromRow(row) {
  const p = row && row.pricing;
  if (!row || row.slug !== SLUG || row.status !== 'live' || !p) return null;
  const amount = Number(p.amount);
  const extra = p.overage && p.overage.unit === 'site' ? Number(p.overage.amount) : NaN;
  // The offer's copy is per month and per extra site; any other shape must not be displayed.
  if (!(amount > 0) || !(extra > 0) || p.interval !== 'month' || typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) {
    return null;
  }
  return { slug: SLUG, amount, extra, currency: p.currency, interval: p.interval };
}

function productsList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.products)) return body.products;
  return [];
}

function makePriceReader({ fetchImpl = globalThis.fetch, url = process.env.OPSAGENTS_PRODUCTS_URL || DEFAULT_PRODUCTS_URL, now = Date.now, ttlMs = TTL_MS } = {}) {
  let cache = null; // { at, value }
  return async function readPrice() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    let value = null;
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (res.ok) value = priceFromRow(productsList(await res.json()).find((r) => r && r.slug === SLUG));
    } catch (_) {
      value = null; // GUARD-OK: an unreadable price hides the offer; it never invents one
    }
    // Only a good answer is cached, so a transient failure is retried on the next request.
    if (value) cache = { at: now(), value };
    return value;
  };
}

module.exports = { priceFromRow, makePriceReader, DEFAULT_PRODUCTS_URL, SLUG };
