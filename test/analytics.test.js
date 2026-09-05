'use strict';
// Card u4xmePAo — PostHog instrumentation for the real-app surface.
//
// What can be wrong here without anyone noticing, in descending order of how
// quietly it fails — the suite is ordered around it:
//
//   1. A PERSONAL key (`phx_…`) bound instead of a project key. It is pasted
//      from an adjacent settings page, it looks right, and /api/analytics-config
//      serves it to every visitor — an account-wide credential, published.
//   2. A half-install: the page wired, the key absent, and the browser making
//      a doomed call to PostHog on every load. The default state has to be
//      SILENT, not degraded.
//   3. A key in the repo. This is Apache-2.0 and intended to be published.
//   4. `enabled:false` with no reason, so "nobody bound a key yet" and "your
//      key is truncated" look identical to the operator.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const analytics = require('../lib/analytics');
const { analyticsVerdict, verdictFromEnv, REASON, KEY_ENV, HOST_ENV, DEFAULT_API_HOST } = analytics;

const GOOD_KEY = 'phc_' + 'A1b2C3d4E5f6G7h8I9j0K1';   // shape only, not a real key
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── 1. The default state is SILENT ──────────────────────────────────────────

test('unset ⇒ disabled, named not-configured, and no key handed out', () => {
  const v = verdictFromEnv({});
  assert.strictEqual(v.enabled, false);
  assert.strictEqual(v.reason, REASON.NOT_CONFIGURED);
  assert.strictEqual(v.projectKey, null);
  assert.strictEqual(v.apiHost, DEFAULT_API_HOST);
});

test('an empty or whitespace value is the same as unset, not a malformed key', () => {
  for (const key of ['', '   ', undefined]) {
    assert.strictEqual(verdictFromEnv({ [KEY_ENV]: key }).reason, REASON.NOT_CONFIGURED, JSON.stringify(key));
  }
});

// ── 2. THE CREDENTIAL LEAK ──────────────────────────────────────────────────

test('KNOWN-POSITIVE: a personal phx_ key is REFUSED, and refused BY ITS OWN REASON', () => {
  // Not "malformed" — that would send an operator to fix a typo instead of
  // rotating a leaked account-wide credential.
  const v = verdictFromEnv({ [KEY_ENV]: 'phx_' + 'Z9y8X7w6V5u4T3s2R1q0P9' });
  assert.strictEqual(v.enabled, false);
  assert.strictEqual(v.reason, REASON.PERSONAL_KEY_REFUSED);
  assert.strictEqual(v.projectKey, null, 'a refused key must never be handed to the browser');
});

test('the refusal is not defeated by surrounding whitespace', () => {
  const v = verdictFromEnv({ [KEY_ENV]: '  phx_' + 'Z9y8X7w6V5u4T3s2R1q0P9' + '  ' });
  assert.strictEqual(v.reason, REASON.PERSONAL_KEY_REFUSED);
});

// ── 3. Shape, including the truncated paste ─────────────────────────────────

test('a well-formed project key enables, and is the value served', () => {
  const v = verdictFromEnv({ [KEY_ENV]: GOOD_KEY });
  assert.strictEqual(v.enabled, true);
  assert.strictEqual(v.reason, REASON.ENABLED);
  assert.strictEqual(v.projectKey, GOOD_KEY);
});

test('a TRUNCATED key is refused rather than silently dropping every event', () => {
  for (const key of ['phc_', 'phc_short', 'sk-live-not-posthog', 'phc-wrongseparator' + 'x'.repeat(20)]) {
    const v = verdictFromEnv({ [KEY_ENV]: key });
    assert.strictEqual(v.enabled, false, key);
    assert.strictEqual(v.reason, REASON.MALFORMED_KEY, key);
  }
});

test('KNOWN-NEGATIVE: the shape test does not reject a legitimate long key', () => {
  // The fail-shut direction — a regex tightened until nothing passes is a
  // silent opt-out that looks like a working install.
  const long = 'phc_' + 'a'.repeat(60);
  assert.strictEqual(verdictFromEnv({ [KEY_ENV]: long }).enabled, true);
});

test('the ingest host is overridable and trailing slashes do not double up', () => {
  assert.strictEqual(analyticsVerdict({ key: GOOD_KEY, apiHost: 'https://eu.i.posthog.com/' }).apiHost, 'https://eu.i.posthog.com');
  assert.strictEqual(analyticsVerdict({ key: GOOD_KEY, apiHost: '  ' }).apiHost, DEFAULT_API_HOST);
  assert.strictEqual(verdictFromEnv({ [KEY_ENV]: GOOD_KEY, [HOST_ENV]: 'https://ph.example.com' }).apiHost, 'https://ph.example.com');
});

// ── 4. NO KEY IS IN THE REPO ────────────────────────────────────────────────

test('KNOWN-POSITIVE: no committed file carries a PostHog key of either kind', () => {
  // This repo is Apache-2.0 and intended to be published; the secrets guard
  // gets stricter while it is private, not looser.
  const { execFileSync } = require('node:child_process');
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => /\.(js|mjs|cjs|json|html|md|ya?ml|txt|example)$/.test(f) && !/package-lock\.json$/.test(f));
  assert.ok(tracked.length >= 20, `only ${tracked.length} tracked file(s) scanned — this sweep is measuring its own filter`);

  const hits = [];
  for (const f of tracked) {
    // The module that DECLARES the shapes, and the suite that exercises them,
    // are exempt by exact path — a scan that reds on its own detector is the
    // cry-wolf direction.
    if (f === 'lib/analytics.js' || f === 'test/analytics.test.js') continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/ph[cx]_[A-Za-z0-9]{20,}/g)) hits.push(`${f}: ${m[0].slice(0, 8)}…`);
  }
  assert.deepEqual(hits, [], `PostHog key-shaped strings committed at: ${hits.join(', ')}`);
});

// ── 5. The wiring, asserted against the artifacts ───────────────────────────

test('the pages hold NO key — they ask the server', () => {
  for (const page of ['web/index.html', 'web/board/index.html']) {
    const html = read(page);
    assert.ok(html.includes('/analytics.js'), `${page} does not load the analytics bootstrap`);
    assert.ok(!/ph[cx]_/.test(html), `${page} carries a PostHog key inline`);
  }
  const boot = read('web/analytics.js');
  assert.ok(boot.includes('/api/analytics-config'), 'the bootstrap must fetch its config');
  assert.ok(!/ph[cx]_[A-Za-z0-9]/.test(boot), 'the bootstrap must hold no key');
});

test('KNOWN-POSITIVE: the snippet loads ONLY inside the enabled branch', () => {
  // The half-install failure: a page that injects PostHog and then discovers
  // it has no key still made the request. `loadPostHog` must be unreachable
  // when `enabled` is false, so the guard has to sit BEFORE the call.
  //
  // ⚠️ This assertion was wrong on its first run, and the way it was wrong is
  // worth keeping: `indexOf('loadPostHog(cfg)')` matched the FUNCTION
  // DEFINITION, which sits above the guard — so a correct file failed. A grep
  // counts a declaration as an instance. The call site is matched by its own
  // shape instead, and the definition is asserted separately so this cannot
  // pass by finding neither.
  const boot = read('web/analytics.js');
  const guard = boot.indexOf('if (!cfg || !cfg.enabled || !cfg.projectKey) return');
  const defined = boot.match(/function loadPostHog\(cfg\) \{/);
  const callMatch = boot.match(/\n\s+loadPostHog\(cfg\);/);
  assert.ok(guard > 0, 'the disabled-state guard is missing');
  assert.ok(defined, 'loadPostHog is not defined — this test would otherwise pass vacuously');
  assert.ok(callMatch, 'loadPostHog is never CALLED — the bootstrap would be inert');
  assert.ok(callMatch.index > guard, 'the loader must be unreachable until the config says enabled');
});

test('GA4 is untouched — this card must not block on, or disturb, the gtag wiring', () => {
  // Measured on origin/real-app @c6436a1 and verified against the GA Admin
  // API: property 549064186 is "RSB Builder" in the OpsAgents AI account —
  // RSB's OWN property, not a sibling stream. The card's premise that this
  // surface has "no GA4" was already out of date; keep it that way.
  for (const page of ['web/index.html', 'web/board/index.html']) {
    assert.ok(read(page).includes('googletagmanager.com/gtag/js'), `${page} lost its GA4 wiring`);
  }
});

test('the health endpoint reports the analytics posture', () => {
  assert.ok(read('server.js').includes('posthog: analytics.ENABLED'), '/api/health must surface whether this deployment reports');
});

test('the env template documents both variables and bans the personal key', () => {
  const env = read('.env.example');
  assert.ok(env.includes(KEY_ENV), `${KEY_ENV} is undocumented`);
  assert.ok(env.includes(HOST_ENV), `${HOST_ENV} is undocumented`);
  assert.match(env, /phx_/, 'the template must name the key shape it bans, or the ban is folklore');
});

// ── 6. The served payload ───────────────────────────────────────────────────

test('/api/analytics-config FORWARDS a bound key under the contract field name', () => {
  // ⭐ AC-3, card 7hUrUOiV. Until now only `verdictFromEnv` was tested with a
  // good key; nothing proved the ROUTE forwards it, under that field name, on
  // the real boot path. A rename between verdict and response would have been
  // invisible — every other test reaches `verdictFromEnv` directly.
  //
  // WHY A CHILD PROCESS, not `delete require.cache`:
  // `lib/analytics` computes `const VERDICT = verdictFromEnv(process.env)` at
  // MODULE LOAD, so the env must be set before the graph loads. Cache surgery
  // would need to evict `lib/analytics` AND `server` (which captured its own
  // reference), re-run server.js's top-level side effects inside this process,
  // and would leave a real-looking key bound in a shared module registry for
  // every later test in the file. A child gives exact isolation and exercises
  // the actual boot, which is the thing under test.
  const script = `
    const { app } = require(${JSON.stringify(join(ROOT, 'server.js'))});
    const server = app.listen(0, async () => {
      try {
        const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/analytics-config');
        process.stdout.write(JSON.stringify(await r.json()));
      } catch (e) {
        process.stderr.write(String(e && e.message));
        process.exitCode = 1;
      } finally {
        server.close();
      }
    });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, [KEY_ENV]: GOOD_KEY },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const body = JSON.parse(out);

  assert.deepStrictEqual(Object.keys(body).sort(), ['apiHost', 'enabled', 'projectKey', 'reason']);
  assert.strictEqual(body.enabled, true, 'a good key must turn the route ON');
  assert.strictEqual(body.reason, REASON.ENABLED);
  // The whole point: the key reaches the browser under THIS name.
  assert.strictEqual(body.projectKey, GOOD_KEY);
  assert.strictEqual(body.apiHost, DEFAULT_API_HOST);
});

test('/api/analytics-config answers disabled-with-a-reason and leaks nothing', async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics-config`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();

    // ⭐ THE KEY SET FIRST, and strictly. Card 7hUrUOiV.
    //
    // `assert.equal` is loose, and `undefined == null` is TRUE — measured:
    //   assert.equal(undefined, null)       PASSES
    //   assert.strictEqual(undefined, null) THROWS
    // so `assert.equal(body.projectKey, null)` passed just as happily if the
    // field was DELETED from the response. It was measured: removing
    // `projectKey:` from server.js's res.json left all 72 tests green.
    //
    // `projectKey` is the field web/analytics.js keys on twice — the guard
    // `if (!cfg || !cfg.enabled || !cfg.projectKey) return` and the init call.
    // Drop it and analytics is bound, paid for, believed-in, and silently dead.
    // The suite was asymmetric: PRESENT-and-WRONG was caught (a string is not
    // `== null`), ABSENT was invisible — and absent is the direction that fails
    // quietly.
    //
    // The key SET, not just strict values, because this is a public endpoint:
    // it also catches a field ADDED (a leak) as well as one removed.
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ['apiHost', 'enabled', 'projectKey', 'reason'],
      'the served contract changed shape — a field was added or removed',
    );
    // The test process has no key bound, which is also the deployment default.
    assert.strictEqual(body.enabled, false);
    assert.strictEqual(body.reason, REASON.NOT_CONFIGURED);
    assert.strictEqual(body.projectKey, null);
    assert.strictEqual(body.apiHost, DEFAULT_API_HOST);
  } finally {
    server.close();
  }
});
