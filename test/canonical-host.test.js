'use strict';
// Card LfD3DX9h — the real app's own self-references must name the URL it is
// actually served and linked at: https://builder.opsagents.agency.
//
// Measured live 2026-10-14 before this test existed: builder.opsagents.agency/
// served a page whose <link rel=canonical>, og:url, og:image, twitter:image and
// JSON-LD url all named https://rapid-site-builder.web.app/ — the retired
// hackathon host, which 301s `/` straight back to builder.opsagents.agency
// (test/retire.test.js). So every directory backlink previewed a redirect, and
// SEO was told the canonical page lives on a host that no longer serves it.
// The post-deploy probe likewise proved only the *.web.app host, which stays
// green while the custom-domain mapping or its certificate lapses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CANON = 'https://builder.opsagents.agency';
// The retired hackathon hosts. rapid-site-builder-app.web.app is NOT here: it is
// the live Hosting site behind the custom domain, and a legitimate second probe.
const RETIRED = /https:\/\/rapid-site-builder(-he)?\.web\.app/;

function head(html) {
  const end = html.indexOf('</head>');
  assert.ok(end > 0, 'KNOWN-POSITIVE: web/index.html has a </head>');
  return html.slice(0, end);
}

test('index.html head: canonical, og:url and JSON-LD url name the custom domain', () => {
  const h = head(read('web/index.html'));
  assert.match(h, /<link rel="canonical" href="https:\/\/builder\.opsagents\.agency\/"\/>/);
  assert.match(h, /<meta property="og:url" content="https:\/\/builder\.opsagents\.agency\/"\/>/);
  const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.strictEqual(ld.url, `${CANON}/`);
  assert.ok(ld.publisher.logo.url.startsWith(`${CANON}/`), 'logo is served from the custom domain');
});

test('index.html head: share images are absolute URLs on the custom domain', () => {
  const h = head(read('web/index.html'));
  const imgs = [...h.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(imgs.length, 2, 'KNOWN-POSITIVE: og:image and twitter:image were both read');
  for (const u of imgs) assert.strictEqual(u, `${CANON}/og.png`);
});

test('no retired hackathon host is named in the served head or llms.txt', () => {
  assert.doesNotMatch(head(read('web/index.html')), RETIRED);
  const llms = read('web/llms.txt');
  assert.ok(llms.includes(`${CANON}/`), 'KNOWN-POSITIVE: llms.txt links the app');
  assert.doesNotMatch(llms, RETIRED);
});

test('deploy-realapp.yml smoke-tests the custom domain AND the Hosting site behind it', () => {
  const wf = read('.github/workflows/deploy-realapp.yml');
  assert.match(wf, /^  APP_URL: https:\/\/builder\.opsagents\.agency$/m);
  assert.match(wf, /^  HOSTING_URL: https:\/\/rapid-site-builder-app\.web\.app$/m);
  const step = wf.slice(wf.indexOf('- name: Smoke test Hosting'));
  const probe = step.slice(0, step.indexOf('\n      - '));
  assert.match(probe, /curl -sf [^\n]*"\$APP_URL\/api\/health"/, 'custom domain is probed, fail-hard (-f)');
  assert.match(probe, /curl -sf [^\n]*"\$HOSTING_URL\/api\/health"/, 'web.app host is probed too');
});
