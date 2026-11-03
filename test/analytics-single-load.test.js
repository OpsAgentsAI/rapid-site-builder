'use strict';
// Card 9fKDq2nw — every page loads each analytics loader EXACTLY ONCE.
//
// Measured on origin/real-app d13b5ea (static read, 2026-10-17): web/index.html
// carried <script src="/analytics.js" defer> at :27 AND :339, and
// web/board/index.html at :13 AND :286. Both duplicates arrived with the
// main -> real-app reconciliation merge 22909d9 (card xe1q8uHa). analytics.js
// has no run-once guard: each execution fetches its configs, initialises the
// GA4 adapter and sends its own page_view, so / and /board most likely sent
// TWO page_views per load into GA4 (the live double count is not measured here).
//
// The suite pins, for every HTML page under web/:
//   1. /analytics.js and /posthog.js each appear at most once (live markup; a
//      tag inside an HTML comment does not load and does not count), and the
//      four product pages load /analytics.js exactly once.
//   2. A page that loads /posthog.js loads /analytics.js BEFORE it, both
//      `defer`, so document order runs analytics.js first (the host-gate
//      decision posthog.js reads, card EGVHefy0, depends on that order).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');

function htmlPages(dir = WEB, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlPages(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Live <script> tags for `src` (comments stripped), with position and attrs.
function scriptTags(html, src) {
  const live = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const re = /<script\b([^>]*)>/gi;
  const tags = [];
  let m;
  while ((m = re.exec(live))) {
    const attrs = m[1];
    const s = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (s === src) tags.push({ index: m.index, defer: /\bdefer\b/i.test(attrs) });
  }
  return tags;
}

const rel = (p) => path.relative(path.join(__dirname, '..'), p);
const PRODUCT_PAGES = ['web/index.html', 'web/board/index.html', 'web/campfire/index.html', 'web/admin/index.html'];

test('scriptTags: KNOWN-POSITIVE — counts live tags, ignores commented ones', () => {
  const html = '<script src="/analytics.js" defer></script>\n<!-- <script src="/analytics.js" defer></script> -->\n<script src="/analytics.js"></script>';
  assert.strictEqual(scriptTags(html, '/analytics.js').length, 2);
  assert.strictEqual(scriptTags('<script src="/analytics.js?v=1"></script>', '/analytics.js').length, 0);
});

test('the page walk finds the four product pages', () => {
  const found = htmlPages().map(rel);
  for (const p of PRODUCT_PAGES) assert.ok(found.includes(p), `${p} not found by the walk`);
});

test('every page loads /analytics.js and /posthog.js at most once', () => {
  for (const file of htmlPages()) {
    const html = fs.readFileSync(file, 'utf8');
    for (const src of ['/analytics.js', '/posthog.js']) {
      const n = scriptTags(html, src).length;
      assert.ok(n <= 1, `${rel(file)} loads ${src} ${n} times (one page_view per execution)`);
    }
  }
});

test('the four product pages load /analytics.js exactly once', () => {
  for (const p of PRODUCT_PAGES) {
    const html = fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    assert.strictEqual(scriptTags(html, '/analytics.js').length, 1, `${p}`);
  }
});

test('a page that loads /posthog.js loads /analytics.js first, both defer', () => {
  let withPosthog = 0;
  for (const file of htmlPages()) {
    const html = fs.readFileSync(file, 'utf8');
    const [ph] = scriptTags(html, '/posthog.js');
    if (!ph) continue;
    withPosthog++;
    const [an] = scriptTags(html, '/analytics.js');
    assert.ok(an, `${rel(file)} loads /posthog.js without /analytics.js`);
    assert.ok(an.index < ph.index, `${rel(file)} loads /posthog.js before /analytics.js`);
    assert.ok(an.defer && ph.defer, `${rel(file)}: both loaders must be defer so document order holds`);
  }
  assert.ok(withPosthog >= 1, 'KNOWN-POSITIVE: at least one page loads /posthog.js');
});
