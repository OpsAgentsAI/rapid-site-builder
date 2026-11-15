'use strict';
// Card uLLFw04n — the builder's paid moment (slice 1 of the CFO build order,
// 2026-09-26): the FREE badge on every published site, and the $19/mo offer
// right after publish, with its funnel events.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { render, BADGE_URL } = require('../lib/renderer');

const SPEC = { business: 'Cafe Luna', tagline: 'Neighbourhood coffee', lang: 'en', layout: 'standard', contact: {} };
const HTML_SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'i18n.js'), 'utf8');

test('a published site carries the "Built with OpsAgents AI" badge, linking back to the builder', () => {
  const html = render(SPEC);
  assert.match(html, /<a class="rsb-badge" href="https:\/\/builder\.opsagents\.agency\/\?utm_source=rsb_badge[^"]*"[^>]*>Built with OpsAgents AI<\/a>/);
  assert.ok(html.includes(BADGE_URL), 'badge href is the exported BADGE_URL');
});

test('the badge is localised on a Hebrew site', () => {
  const html = render({ ...SPEC, lang: 'he' });
  assert.match(html, /class="rsb-badge"[^>]*>נבנה עם OpsAgents AI<\/a>/);
});

test('the badge CANNOT be removed from the client-supplied spec (removal is a paid feature)', () => {
  // publish receives the spec from the browser; any spec flag would be a free bypass.
  for (const extra of [{ paid: true }, { badge: false }, { plan: 'paid' }]) {
    assert.match(render({ ...SPEC, ...extra }), /class="rsb-badge"/, `badge dropped for ${JSON.stringify(extra)}`);
  }
});

test('the brand in the badge is "OpsAgents AI", never the bare form', () => {
  const m = render(SPEC).match(/class="rsb-badge"[^>]*>([^<]*)<\/a>/);
  assert.ok(m && /OpsAgents AI/.test(m[1]));
});

test('the post-publish offer exists, starts hidden, and is shown only from the publish success path', () => {
  assert.match(HTML_SRC, /<div class="upgrade" id="upgrade" hidden>/);
  const pub = HTML_SRC.slice(HTML_SRC.indexOf('async function publish()'));
  const ok = pub.indexOf("if (!r.ok) throw new Error");
  const shown = pub.indexOf('showUpgrade(');
  assert.ok(ok > 0 && shown > ok, 'showUpgrade must run only after the publish succeeded');
  assert.ok(shown < pub.indexOf('} catch (e) {'), 'and not from the error branch');
});

test('funnel events: rsb_upgrade_shown on show, rsb_upgrade_click on click, to GA4 and PostHog; no fake begin_checkout', () => {
  const fn = HTML_SRC.slice(HTML_SRC.indexOf('function upgradeEvent'), HTML_SRC.indexOf('async function publish()'));
  assert.match(fn, /rsbTrack\(name, p\)/);
  assert.match(fn, /rsbPH\(name, p\)/);
  assert.match(fn, /upgradeEvent\('rsb_upgrade_shown', siteId, price\)/);
  assert.match(fn, /upgradeEvent\('rsb_upgrade_click', siteId, price\)/);
  assert.match(fn, /value: price\.amount, currency: price\.currency/, 'the event value comes from the served price');
  const code = fn.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /begin_checkout/, 'a click to a pricing page is not a checkout');
});

// CTO ruling 5399696225 (09-28 rule): prices come ONLY from /v1/products. INVERTED from the
// first edition, which pinned the literals.
test('NO literal price anywhere under web/ — the offer is filled from /api/price at render time', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(html|js)$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const re of [/\$\s?(19|12)\b/g, /\b(19|12)\s?(USD|\$|דולר)/g, /value:\s*19\b/g]) {
          for (const m of src.matchAll(re)) offenders.push(`${path.relative(path.join(__dirname, '..'), p)}: ${m[0]}`);
        }
      }
    }
  };
  walk(path.join(__dirname, '..', 'web'));
  assert.deepEqual(offenders, []);
  const lines = I18N_SRC.match(/'upgrade\.(body|cta)': '([^']*)'/g) || [];
  assert.equal(lines.length, 4, 'EN + HE body and cta');
  for (const l of lines) assert.match(l, /\{price\}/, `placeholder missing: ${l}`);
  assert.match(HTML_SRC, /UPGRADE_URL = 'https:\/\/opsagents\.agency\/pricing\?[^']*#sku-rapid-site-builder'/);
});

test('the offer is hidden when the price cannot be read — no fallback number, no event', () => {
  const fn = HTML_SRC.slice(HTML_SRC.indexOf('async function showUpgrade'), HTML_SRC.indexOf('async function publish()'));
  assert.match(fn, /fetch\('\/api\/price'/);
  const guard = fn.indexOf('return; // no price, no offer');
  assert.ok(guard > 0, 'a missing price returns before anything is shown');
  assert.ok(guard < fn.indexOf('box.hidden = false'), 'the guard runs before the panel is revealed');
  assert.ok(guard < fn.indexOf("upgradeEvent('rsb_upgrade_shown'"), 'and before any event fires');
});

// ── lib/pricing.js: the server-side read of the products row ──
const { priceFromRow, makePriceReader } = require('../lib/pricing');
const ROW = { slug: 'rapid-site-builder', status: 'live', pricing: { currency: 'USD', interval: 'month', amount: 21, included: { unit: 'site', qty: 1 }, overage: { unit: 'site', per: 1, amount: 13 } } };

test('priceFromRow reads amount, extra-site amount and currency straight from the row (no constants)', () => {
  assert.deepEqual(priceFromRow(ROW), { slug: 'rapid-site-builder', amount: 21, extra: 13, currency: 'USD', interval: 'month' });
});

test('priceFromRow refuses a row the offer copy cannot honestly describe', () => {
  assert.equal(priceFromRow(null), null);
  assert.equal(priceFromRow({ ...ROW, status: 'draft' }), null);
  assert.equal(priceFromRow({ ...ROW, pricing: { ...ROW.pricing, interval: 'year' } }), null);
  assert.equal(priceFromRow({ ...ROW, pricing: { ...ROW.pricing, overage: null } }), null);
  assert.equal(priceFromRow({ ...ROW, pricing: { ...ROW.pricing, amount: 0 } }), null);
  assert.equal(priceFromRow({ ...ROW, slug: 'other' }), null);
});

test('makePriceReader: a fetch failure or missing row is null (hide), and only a good answer is cached', async () => {
  let calls = 0;
  let mode = 'fail';
  const fetchImpl = async () => {
    calls++;
    if (mode === 'fail') throw new Error('ECONNRESET');
    if (mode === 'empty') return { ok: true, json: async () => ({ products: [] }) };
    return { ok: true, json: async () => ({ products: [ROW] }) };
  };
  let t = 0;
  const read = makePriceReader({ fetchImpl, url: 'https://products.test/v1/products', now: () => t, ttlMs: 1000 });
  assert.equal(await read(), null);
  mode = 'empty';
  assert.equal(await read(), null);
  mode = 'ok';
  assert.equal((await read()).amount, 21);
  mode = 'fail';
  t = 500;
  assert.equal((await read()).amount, 21, 'served from cache inside the TTL');
  t = 2000;
  assert.equal(await read(), null, 'TTL expired and the fetch fails → hide, not stale-forever');
  assert.equal(calls, 4);
});

test('server.js exposes GET /api/price from lib/pricing and answers 503 when unavailable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/pricing'\)\.makePriceReader\(\)/);
  assert.match(src, /app\.get\('\/api\/price'/);
  assert.match(src, /status\(503\)\.json\(\{ error: 'price_unavailable' \}\)/);
});
