'use strict';
// Card EGVHefy0 — acquisition plumbing for builder.opsagents.agency.
//
// Measured 2026-10-17 04:5xZ (plain GETs, builder pages only):
//   * /sitemap.xml was a 404 and robots.txt named no sitemap, so Search
//     Console had nothing to crawl from (0 impressions Aug, Sep, Oct 1-14).
//   * web/analytics.js labelled every non-localhost host 'production', so
//     rapid-site-builder-app.web.app visits landed in GA4 549064186 as product
//     traffic (9 of 23 users in Aug).
//
// The suite pins three things:
//   1. /sitemap.xml serves well-formed sitemaps.org XML that lists ONLY the
//      builder's own pages, on the canonical origin, and NEVER a /sites/* URL.
//   2. robots.txt names that sitemap and keeps every existing record.
//   3. Both analytics bootstraps (web/analytics.js, web/posthog.js) run ONLY on
//      builder.opsagents.agency: executed in a sandbox per host, every other
//      host makes ZERO network calls. The allow-list lives ONLY in analytics.js
//      (window.rsbAnalyticsOn); posthog.js reads that decision and fails closed
//      without it (CTO review 5556334518, bounce dry-host-gate).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { sitemapXml, SITEMAP_PAGES, CANONICAL_ORIGIN, isForbiddenPath } = require('../lib/sitemap');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CANON = 'https://builder.opsagents.agency';

// Minimal well-formedness check (no XML dependency in this repo): one prolog,
// every element closed in order, nothing but whitespace between elements.
function assertWellFormedXml(xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'XML prolog first');
  const body = xml.slice(xml.indexOf('?>') + 2);
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/g;
  let m; let consumed = 0; let roots = 0;
  while ((m = re.exec(body))) {
    assert.strictEqual(m.index, consumed, `unparseable XML near: ${body.slice(consumed, consumed + 40)}`);
    consumed = re.lastIndex;
    if (m[5] !== undefined) {
      assert.ok(!/[<>]/.test(m[5]), 'raw < or > in text');
      assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]), 'unescaped & in text');
      if (!stack.length) assert.match(m[5], /^\s*$/, 'text outside the root element');
      continue;
    }
    const [, close, name, , selfClose] = m;
    if (close) assert.strictEqual(stack.pop(), name, `mismatched </${name}>`);
    else if (!selfClose) { if (!stack.length) roots++; stack.push(name); }
  }
  assert.strictEqual(consumed, body.length, 'trailing unparseable content');
  assert.deepStrictEqual(stack, [], 'unclosed elements');
  assert.strictEqual(roots, 1, 'exactly one root element');
}

function locs(xml) {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
}

// ── 1. The sitemap ──────────────────────────────────────────────────────────

test('sitemap: well-formed sitemaps.org urlset on the canonical origin', () => {
  const xml = sitemapXml();
  assertWellFormedXml(xml);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const urls = locs(xml);
  assert.ok(urls.length >= 1, 'KNOWN-POSITIVE: at least the home page is listed');
  assert.strictEqual(CANONICAL_ORIGIN, CANON);
  assert.ok(urls.includes(`${CANON}/`), 'the home page is listed');
  for (const u of urls) assert.ok(u.startsWith(`${CANON}/`), `${u} is not on the canonical origin`);
});

test('sitemap: NEVER lists a /sites/* (customer) URL — default list and refusal', () => {
  const xml = sitemapXml();
  assert.ok(!/\/sites(\/|<)/i.test(xml), 'a customer-site path is in the sitemap');
  for (const p of SITEMAP_PAGES) assert.ok(!isForbiddenPath(p), `${p} is a forbidden path`);
  // A future edit that adds one fails loudly instead of shipping quietly.
  for (const bad of ['/sites', '/sites/', '/sites/abc123', '/SITES/abc', '/sites/abc/llms.txt']) {
    assert.throws(() => sitemapXml({ pages: ['/', bad] }), /never list/, `${bad} was accepted`);
  }
  // KNOWN-NEGATIVE: a lookalike that is NOT under /sites/ is not refused.
  assert.doesNotThrow(() => sitemapXml({ pages: ['/sitesmap-guide'] }));
});

test('sitemap: admin / api / proxy paths are refused too; /admin is noindex', () => {
  for (const bad of ['/admin', '/admin/', '/api/health', '/rp/e']) {
    assert.throws(() => sitemapXml({ pages: [bad] }), /never list/, `${bad} was accepted`);
  }
  assert.match(read('web/admin/index.html'), /<meta name="robots" content="noindex,nofollow"\/>/);
});

test('sitemap: every listed page has an explicit page route in server.js', () => {
  const server = read('server.js');
  for (const p of SITEMAP_PAGES) {
    const lit = p === '/' ? "app.get('/', " : `'${p}'`;
    assert.ok(server.includes(lit), `${p} is listed but server.js has no page route for it`);
  }
});

test('sitemap: escapes XML metacharacters and rejects a non-origin base', () => {
  const xml = sitemapXml({ pages: ['/a?b=1&c=<2>'] });
  assertWellFormedXml(xml);
  assert.ok(xml.includes('/a?b=1&amp;c=&lt;2&gt;'));
  assert.throws(() => sitemapXml({ origin: 'http://builder.opsagents.agency' }), /https origin/);
  assert.throws(() => sitemapXml({ origin: 'https://x.test/path' }), /https origin/);
  assert.throws(() => sitemapXml({ pages: ['relative'] }), /site-relative/);
});

test('GET /sitemap.xml serves the sitemap as XML (route, not a 404)', async () => {
  const { app } = require('../server');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/sitemap.xml`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^application\/xml/);
    const body = await res.text();
    assert.strictEqual(body, sitemapXml());
    assertWellFormedXml(body);
    assert.ok(!body.includes('/sites/'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── 2. robots.txt ───────────────────────────────────────────────────────────

test('robots.txt names the sitemap exactly once, on the canonical origin', () => {
  const robots = read('web/robots.txt');
  const lines = robots.split('\n').filter((l) => /^sitemap:/i.test(l.trim()));
  assert.deepStrictEqual(lines, [`Sitemap: ${CANON}/sitemap.xml`]);
});

test('robots.txt keeps every existing record (no crawler newly disallowed)', () => {
  const robots = read('web/robots.txt');
  assert.match(robots, /User-agent: \*\nAllow: \//);
  for (const ua of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'Google-Extended', 'PerplexityBot', 'CCBot']) {
    assert.ok(robots.includes(`User-agent: ${ua}\nAllow: /`), `${ua} record lost`);
  }
  assert.ok(!/^Disallow:/im.test(robots), 'a Disallow record appeared');
});

// ── 3. Analytics host gate ──────────────────────────────────────────────────

// Execute browser bootstraps IN ORDER in ONE page sandbox at `hostname`, the
// way a page runs its `defer` scripts, and record every network call per file.
// fetch() returns a never-settling promise, so only the synchronous decision
// "does this host call out at all" is observed. `sources` maps a file to
// replacement source text (to prove the single allow-list drives both files).
function runPage(files, hostname, sources = {}) {
  const perFile = {};
  let calls = [];
  const sandbox = {
    location: { hostname, href: `https://${hostname}/`, protocol: 'https:' },
    document: {
      title: 't', referrer: '',
      createElement() { calls.push('createElement'); return {}; },
      getElementsByTagName() { return [{ parentNode: { insertBefore() { calls.push('insertBefore'); } } }]; }
    },
    fetch(url) { calls.push(String(url)); return new Promise(() => {}); },
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    calls = [];
    vm.runInContext(sources[file] || read(file), sandbox, { filename: file });
    perFile[file] = calls;
  }
  return { perFile, win: sandbox };
}
function runBootstrap(file, hostname) {
  const { perFile, win } = runPage([file], hostname);
  return { calls: perFile[file], win };
}
// Every page that loads posthog.js loads analytics.js before it.
const PAGE = ['web/analytics.js', 'web/posthog.js'];

const OFF_HOSTS = [
  'rapid-site-builder-app.web.app',          // the Hosting site behind the custom domain
  'rapid-site-builder-app.firebaseapp.com',
  'rapid-builder-stg.web.app',               // staging
  'rapid-site-builder-app--pr-123-abcd1234.web.app', // a preview channel
  'rapid-builder-app-abc123-uc.a.run.app',   // the raw Cloud Run URL
  'rapid-site-builder.web.app',              // the retired hackathon host
  'localhost', '127.0.0.1',
  'builder.opsagents.agency.evil.test',      // suffix lookalike
  'staging.builder.opsagents.agency'         // a subdomain is not the prod host
];

test('analytics.js: KNOWN-POSITIVE — builder.opsagents.agency fetches both configs', () => {
  for (const h of ['builder.opsagents.agency', 'BUILDER.opsagents.agency', 'builder.opsagents.agency.']) {
    const { calls, win } = runBootstrap('web/analytics.js', h);
    assert.ok(calls.includes('/api/analytics-config'), `${h}: PostHog config not fetched`);
    assert.ok(calls.includes('/api/client-config'), `${h}: GA4 config not fetched`);
    assert.strictEqual(typeof win.rsbTrack, 'function');
    assert.strictEqual(typeof win.rsbCapture, 'function');
  }
});

test('analytics.js: web.app / staging / preview / localhost make ZERO network calls', () => {
  for (const h of OFF_HOSTS) {
    const { calls, win } = runBootstrap('web/analytics.js', h);
    assert.deepStrictEqual(calls, [], `${h} called out: ${calls.join(', ')}`);
    // Callers never guard: the helpers exist and do nothing.
    assert.doesNotThrow(() => win.rsbTrack('page_view', {}));
    assert.doesNotThrow(() => win.rsbCapture('build_started', {}));
  }
});

test('posthog.js: after analytics.js, loads only on builder.opsagents.agency; silent elsewhere', () => {
  const on = runPage(PAGE, 'builder.opsagents.agency');
  assert.strictEqual(on.win.rsbAnalyticsOn, true);
  assert.deepStrictEqual(on.perFile['web/posthog.js'], ['/api/client-config'], 'KNOWN-POSITIVE: prod host fetches its config');
  for (const h of OFF_HOSTS) {
    const { perFile, win } = runPage(PAGE, h);
    assert.strictEqual(win.rsbAnalyticsOn, false, `${h}: analytics.js must publish OFF`);
    assert.deepStrictEqual(perFile['web/posthog.js'], [], `${h} called out: ${perFile['web/posthog.js'].join(', ')}`);
    assert.doesNotThrow(() => win.rsbPH('signup', {}));
  }
});

test('posthog.js: FAIL CLOSED when the analytics.js decision is missing or not exactly true', () => {
  // Loaded alone, even on the prod host: no decision published -> OFF.
  const alone = runBootstrap('web/posthog.js', 'builder.opsagents.agency');
  assert.deepStrictEqual(alone.calls, [], 'posthog.js alone must not call out');
  assert.doesNotThrow(() => alone.win.rsbPH('signup', {}));
  // A truthy non-boolean is not a decision.
  for (const v of ['true', 1, {}, null, undefined]) {
    const { perFile } = runPage(['web/posthog.js'], 'builder.opsagents.agency', {
      'web/posthog.js': `window.rsbAnalyticsOn = ${v === undefined ? 'undefined' : JSON.stringify(v)};\n` + read('web/posthog.js')
    });
    assert.deepStrictEqual(perFile['web/posthog.js'], [], `rsbAnalyticsOn=${JSON.stringify(v)} must be OFF`);
  }
});

test('ONE host gate: analytics.js owns the allow-list, posthog.js only reads its decision', () => {
  const a = read('web/analytics.js');
  const p = read('web/posthog.js');
  const decl = /var ANALYTICS_HOSTS = (\[[^\]]*\]);/g;
  // KNOWN-POSITIVE: the single source exists, exactly once, with the one prod host.
  const hits = [...a.matchAll(decl)].map((m) => m[1]);
  assert.deepStrictEqual(hits, ["['builder.opsagents.agency']"]);
  // posthog.js carries no copy: no list, no hostname rule of its own.
  assert.ok(!/ANALYTICS_HOSTS/.test(p), 'posthog.js declares its own allow-list again');
  assert.ok(!/hostname/.test(p), 'posthog.js derives its own host decision again');
  assert.ok(/window\.rsbAnalyticsOn !== true/.test(p), 'posthog.js does not read the shared decision fail-closed');
  // No other browser file re-declares the list.
  for (const f of fs.readdirSync(path.join(ROOT, 'web')).filter((n) => n.endsWith('.js'))) {
    if (f === 'analytics.js') continue;
    assert.ok(!/ANALYTICS_HOSTS/.test(read(`web/${f}`)), `web/${f} carries a second allow-list`);
  }
});

test('ONE host gate: changing the allow-list in analytics.js alone changes BOTH loaders', () => {
  const extra = 'staging.builder.opsagents.agency';
  // Baseline: not on the list -> both silent.
  const before = runPage(PAGE, extra);
  assert.deepStrictEqual(before.perFile['web/analytics.js'], []);
  assert.deepStrictEqual(before.perFile['web/posthog.js'], []);
  // Edit ONLY analytics.js: add the host. posthog.js source is untouched.
  const edited = read('web/analytics.js').replace(
    "var ANALYTICS_HOSTS = ['builder.opsagents.agency'];",
    `var ANALYTICS_HOSTS = ['builder.opsagents.agency', '${extra}'];`
  );
  assert.notStrictEqual(edited, read('web/analytics.js'), 'KNOWN-POSITIVE: the edit applied');
  const after = runPage(PAGE, extra, { 'web/analytics.js': edited });
  assert.ok(after.perFile['web/analytics.js'].includes('/api/client-config'), 'analytics.js did not follow its own list');
  assert.deepStrictEqual(after.perFile['web/posthog.js'], ['/api/client-config'], 'posthog.js did not follow the one list');
});
