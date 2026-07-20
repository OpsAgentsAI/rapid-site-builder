'use strict';
// Hebrew twin sweep (card aOpMHEAd): a Hebrew brief must produce a Hebrew,
// RTL experience end to end — the instant draft, the engine-failure fallback,
// the published-page chrome, and the live feed's pure-Hebrew agent lines.

const test = require('node:test');
const assert = require('node:assert');

// Force the engine "configured" BEFORE the app loads; individual tests swap
// runBuild to simulate outage vs. a crew that streams Hebrew-only lines.
const engine = require('../lib/engine');
engine.ENABLED = true;

const { app, fallbackSpec } = require('../server');
const { render } = require('../lib/renderer');

function collectSse(body) {
  return body.split('\n\n')
    .map(chunk => chunk.split('\n').find(l => l.startsWith('data:')))
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
    .filter(Boolean);
}

const HEB = /[֐-׿]/;

test('fallbackSpec: Hebrew brief → Hebrew spec stamped lang/dir', () => {
  const spec = fallbackSpec({ business: 'קפה לונה', category: 'food_beverage', description: 'קפה שכונתי', lang: 'he', style: 'default' });
  assert.equal(spec.lang, 'he');
  assert.equal(spec.dir, 'rtl');
  assert.ok(HEB.test(spec.items_heading), 'items heading is Hebrew');
  assert.ok(HEB.test(spec.cta_button), 'CTA is Hebrew');
  assert.ok(spec.why.every(w => HEB.test(w.title)), 'why cards are Hebrew');
  // English path unchanged
  const en = fallbackSpec({ business: 'Cafe Luna', category: 'food_beverage', description: 'coffee', lang: 'en', style: 'default' });
  assert.equal(en.lang, 'en');
  assert.ok(!HEB.test(JSON.stringify(en)), 'English fallback carries no Hebrew');
});

test('renderer: Hebrew spec gets RTL + Hebrew chrome + Hebrew-capable fonts', () => {
  const spec = fallbackSpec({ business: 'קפה לונה', category: 'food_beverage', description: 'קפה שכונתי', lang: 'he', style: 'default' });
  const html = render(spec, {});
  assert.ok(html.includes('<html lang="he" dir="rtl">'), 'lang/dir stamped');
  assert.ok(html.includes('שעות פתיחה'), 'visit card labeled in Hebrew');
  assert.ok(html.includes('אודות'), 'nav/about chrome in Hebrew');
  assert.ok(!html.includes('Opening hours'), 'no English chrome leakage');
  assert.ok(!html.includes('Get in touch'), 'no English CTA default leakage');
  assert.ok(/Heebo|Rubik/.test(html), 'Hebrew-coverage fonts loaded');
  assert.ok(!/family=Fraunces/.test(html), 'Latin-only display font not loaded for he');
  // English spec renders exactly as before
  const enHtml = render(fallbackSpec({ business: 'Cafe Luna', category: 'food_beverage', description: 'coffee', lang: 'en', style: 'default' }), {});
  assert.ok(enHtml.includes('<html lang="en"><head>'), 'no dir attr for en');
  assert.ok(enHtml.includes('Opening hours'), 'English chrome intact');
});

test('SSE: engine outage on a Hebrew build → Hebrew RTL fallback site + Hebrew system line', async () => {
  engine.runBuild = async () => { throw new Error('engine outage'); };
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: 'קפה לונה', category: 'food_beverage', description: 'בית קפה שכונתי', lang: 'he' })
    });
    assert.equal(r.status, 200);
    const events = collectSse(await r.text());
    const site = events.find(e => e.type === 'site');
    assert.ok(site, 'a site event always arrives');
    assert.equal(site.spec.lang, 'he');
    assert.ok(site.html.includes('dir="rtl"'), 'fallback site is RTL');
    assert.ok(HEB.test(site.spec.items_heading), 'fallback content is Hebrew');
    const sys = events.filter(e => e.type === 'step').map(e => e.text).join('\n');
    assert.ok(HEB.test(sys), 'system line reaches the user in Hebrew');
    assert.ok(!/turbulence/.test(sys), 'no English system line on a Hebrew build');
  } finally {
    server.close();
  }
});

test('SSE: pure-Hebrew agent lines are not dropped by the content filter', async () => {
  engine.runBuild = async (brief, onStep) => {
    onStep({ agent: 'copy_agent', text: 'שלום! מתחילים לכתוב את הקופי.' }, 1); // no [a-zA-Z0-9] at all
    onStep({ agent: 'copy_agent', text: '---' }, 1);                            // divider must still be skipped
    return { spec: null };
  };
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: 'קפה לונה', category: 'food_beverage', description: 'בית קפה', lang: 'he' })
    });
    const events = collectSse(await r.text());
    const steps = events.filter(e => e.type === 'step').map(e => e.text);
    assert.ok(steps.includes('שלום! מתחילים לכתוב את הקופי.'), 'pure-Hebrew step streamed to the feed');
    assert.ok(!steps.includes('---'), 'contentless divider still filtered');
  } finally {
    server.close();
  }
});
