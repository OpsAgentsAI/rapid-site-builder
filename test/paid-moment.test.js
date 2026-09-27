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
  assert.match(fn, /upgradeEvent\('rsb_upgrade_shown', siteId\)/);
  assert.match(fn, /upgradeEvent\('rsb_upgrade_click', siteId\)/);
  const code = fn.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /begin_checkout/, 'a click to a pricing page is not a checkout');
});

test('the offer states the canon price in both languages ($19/mo, +$12 per extra site)', () => {
  const en = I18N_SRC.match(/'upgrade\.body': '([^']*)'/g) || [];
  assert.equal(en.length, 2, 'EN + HE upgrade.body');
  for (const line of en) {
    assert.match(line, /\$19/);
    assert.match(line, /\$12/);
  }
  assert.match(HTML_SRC, /UPGRADE_URL = 'https:\/\/opsagents\.agency\/pricing\?[^']*#sku-rapid-site-builder'/);
});
