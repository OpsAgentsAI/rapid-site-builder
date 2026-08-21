'use strict';
// Card 6kf27M5o — the retirement is asserted in one direction only.
//
// deploy.yml proves the RETIRED hosts stay retired. Nothing proved the place
// they all redirect to — builder.opsagents.agency, the URL every client demo
// deck now closes with — is alive and not itself retired.
//
// These are pure-predicate tests on synthetic probe results, and that is the
// point: the state being guarded is the HEALTHY one, so a suite that only ever
// ran against the live tree would be indistinguishable from `return OK` from
// the day it was written. Two rows at the bottom DO run against the real files,
// which is the other half — a predicate nothing calls is also `return OK`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalFindings, healthIsContextOnly } = require('../lib/canonicalLive');
const { placementFindings, envKeys, envVarLiterals } = require('../lib/retireFlagPlacement');

const CANON = 'https://builder.opsagents.agency';
const WF = (name) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');

const healthy = () => ({
  expectedOrigins: [CANON],
  probes: [
    { origin: CANON, path: '/', method: 'GET', status: 200 },
    // 400 on an empty brief: server.js 400s at cleanBrief BEFORE the
    // engine.ENABLED check and before any Vertex call, which is exactly why
    // ratelimit.test.js uses that 400 as its "the request reached the handler"
    // marker. It is the one probe of this route that costs nothing.
    { origin: CANON, path: '/api/build', method: 'POST', status: 400 }
  ]
});

test('a healthy canonical surface produces no findings', () => {
  const r = canonicalFindings(healthy());
  assert.strictEqual(r.broken, false);
  assert.deepStrictEqual(r.findings, []);
});

test('THE DEFECT: RETIRE_UNGATED on the canonical service self-redirects / and 410s the engine', () => {
  const p = healthy();
  p.probes = [
    { origin: CANON, path: '/', method: 'GET', status: 301, location: CANON + '/' },
    { origin: CANON, path: '/api/build', method: 'POST', status: 410 }
  ];
  const r = canonicalFindings(p);
  assert.strictEqual(r.broken, false, 'this is a finding, not a broken scan');
  assert.strictEqual(r.findings.length, 2, r.findings.join(' | '));
  assert.match(r.findings[0], /redirecting to itself/);
  assert.match(r.findings[1], /410 Gone/);
});

test('a self-redirect is detected by ORIGIN, not string equality', () => {
  const p = healthy();
  // no trailing slash, plus a path — still the same origin, still the loop
  p.probes[0] = { origin: CANON, path: '/', method: 'GET', status: 301, location: CANON };
  assert.match(canonicalFindings(p).findings[0] || '', /redirecting to itself/);
  const q = healthy();
  q.probes[0] = { origin: CANON, path: '/', method: 'GET', status: 301, location: 'https://elsewhere.example/' };
  // a redirect somewhere ELSE is a different fault and must not claim the loop
  assert.doesNotMatch(canonicalFindings(q).findings[0] || '', /redirecting to itself/);
});

test('CRY-WOLF CONTROL: a live-but-unhappy engine is not reported as retired', () => {
  // Only 410 means retired. 429 (rate limited) and 503 (engine unconfigured)
  // both prove the request reached the app. Demanding 400 exactly would red the
  // day brief validation changes — the false-positive direction, which is the
  // one nobody tests and the one that gets a guard deleted.
  for (const status of [429, 503, 400, 200]) {
    const p = healthy();
    p.probes[1] = { origin: CANON, path: '/api/build', method: 'POST', status };
    assert.deepStrictEqual(canonicalFindings(p).findings, [], `status ${status} must not read as retired`);
  }
});

test('a root that is simply down is reported, and not as a redirect loop', () => {
  const p = healthy();
  p.probes[0] = { origin: CANON, path: '/', method: 'GET', status: 502 };
  const f = canonicalFindings(p).findings;
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /answered 502, expected 200/);
});

test('a declared origin that was never probed is a finding, not a pass', () => {
  const p = healthy();
  p.expectedOrigins = [CANON, 'https://rapid-site-builder-app.web.app'];
  const f = canonicalFindings(p).findings;
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /never probed/);
});

test('VACUITY: no declared origins, too few probes, and a statusless probe each refuse to pass', () => {
  const none = canonicalFindings({ expectedOrigins: [], probes: healthy().probes });
  assert.strictEqual(none.broken, true);
  assert.match(none.findings[0], /SCAN LOOKS BROKEN, NOT CLEAN/);

  const thin = canonicalFindings({ expectedOrigins: [CANON], probes: [healthy().probes[0]] });
  assert.strictEqual(thin.broken, true);
  assert.match(thin.findings[0], /1 probe\(s\)/);

  const p = healthy();
  p.probes[1] = { origin: CANON, path: '/api/build', method: 'POST', status: null };
  const bad = canonicalFindings(p);
  assert.strictEqual(bad.broken, true);
  assert.match(bad.findings[0], /produced no status code/);
});

test('VACUITY short-circuits: a broken scan does not also emit rule findings to chase', () => {
  const r = canonicalFindings({ expectedOrigins: [], probes: [] });
  assert.strictEqual(r.findings.length, 1, 'exactly one line, naming the scan');
});

test('/api/health is echoed as context and cannot appear in a verdict', () => {
  // It is exempt from the retirement middleware by design, so it is green in
  // precisely the state this module exists to catch — and it is the ONLY thing
  // deploy-realapp.yml asserts after its deploy.
  const p = healthy();
  p.probes = [
    { origin: CANON, path: '/', method: 'GET', status: 301, location: CANON + '/' },
    { origin: CANON, path: '/api/build', method: 'POST', status: 410 },
    { origin: CANON, path: '/api/health', method: 'GET', status: 200 }
  ];
  const f = canonicalFindings(p).findings;
  assert.strictEqual(f.length, 2, 'health must neither add nor cancel a finding');
  const ctx = healthIsContextOnly({ [CANON]: '200 {"auth":true}' });
  assert.match(ctx, /NOT a verdict input/);
});

// ── placement rule ──────────────────────────────────────────────────────────

test('placement: the flag belongs on deploy.yml and nowhere near deploy-realapp.yml', () => {
  const ok = placementFindings({
    'deploy.yml': 'run: gcloud run deploy --set-env-vars "^|^A=1|RETIRE_UNGATED=1|B=2"',
    'deploy-realapp.yml': 'run: gcloud run deploy --set-env-vars "A=1,B=2"'
  });
  assert.deepStrictEqual(ok.findings, []);

  const leaked = placementFindings({
    'deploy.yml': 'run: --set-env-vars "^|^A=1|RETIRE_UNGATED=1"',
    'deploy-realapp.yml': 'run: --set-env-vars "A=1,RETIRE_UNGATED=1"'
  });
  assert.strictEqual(leaked.findings.length, 1);
  assert.match(leaked.findings[0], /deploys the CANONICAL product/);

  const dropped = placementFindings({
    'deploy.yml': 'run: --set-env-vars "^|^A=1|B=2"',
    'deploy-realapp.yml': 'run: --set-env-vars "A=1"'
  });
  assert.strictEqual(dropped.findings.length, 1);
  assert.match(dropped.findings[0], /no longer sets RETIRE_UNGATED/);
});

test('placement is scoped to the env literal: prose about the flag must not red', () => {
  // Both workflows explain this rule in comments. A file-wide ban would red the
  // documentation, and the obvious repair for that red is to delete it.
  const r = placementFindings({
    'deploy.yml': '# RETIRE_UNGATED=1 is what retires this surface\nrun: --set-env-vars "^|^A=1|RETIRE_UNGATED=1"',
    'deploy-realapp.yml': '# NOTE: RETIRE_UNGATED must never be set here — it would retire the product.\nrun: --set-env-vars "A=1"'
  });
  assert.deepStrictEqual(r.findings, []);
});

test('placement VACUITY: fewer than two workflow files read is a broken scan', () => {
  const r = placementFindings({ 'deploy.yml': 'x' });
  assert.strictEqual(r.broken, true);
  assert.match(r.findings[0], /SCAN LOOKS BROKEN, NOT CLEAN/);
});

// ── quote shape: the guard must not depend on how the value happens to be typed ──
//
// These four FAIL against the previous double-quote-only regex
// (/--set-env-vars\s+"([^"]*)"/g). The first is the one that matters: it fails
// SILENTLY there — zero literals, present = false, no finding at all — which is
// the same one-directional blindness this whole card is about, reproduced
// inside the guard written to fix it.

test('QUOTE SHAPE — THE UNSAFE DIRECTION: a SINGLE-quoted leak on the canonical workflow is caught', () => {
  // deploy.yml keeps double quotes so ONLY the realapp side changes shape. Under
  // the old regex that side yielded no literals => present = false => the leaked
  // RETIRE_UNGATED produced NO finding whatsoever. Silent pass, prod retired.
  const r = placementFindings({
    'deploy.yml': 'run: --set-env-vars "^|^A=1|RETIRE_UNGATED=1"',
    'deploy-realapp.yml': "run: --set-env-vars 'A=1,RETIRE_UNGATED=1'"
  });
  assert.strictEqual(r.broken, false, 'a leak is a finding, not a broken scan');
  assert.strictEqual(r.findings.length, 1, r.findings.join(' | '));
  assert.match(r.findings[0], /deploys the CANONICAL product/);
});

test('QUOTE SHAPE: an UNQUOTED leak on the canonical workflow is caught', () => {
  const r = placementFindings({
    'deploy.yml': 'run: --set-env-vars "^|^A=1|RETIRE_UNGATED=1"',
    'deploy-realapp.yml': 'run: --set-env-vars A=1,RETIRE_UNGATED=1 --region me-west1'
  });
  assert.strictEqual(r.findings.length, 1, r.findings.join(' | '));
  assert.match(r.findings[0], /deploys the CANONICAL product/);
});

test('QUOTE SHAPE: single-quoted and unquoted and --set-env-vars= all read as literals', () => {
  assert.deepStrictEqual(envVarLiterals('run: --set-env-vars "A=1,B=2"'), ['A=1,B=2']);
  assert.deepStrictEqual(envVarLiterals("run: --set-env-vars 'A=1,B=2'"), ['A=1,B=2']);
  assert.deepStrictEqual(envVarLiterals('run: --set-env-vars A=1,B=2 \\'), ['A=1,B=2']);
  assert.deepStrictEqual(envVarLiterals('run: --set-env-vars=A=1,B=2'), ['A=1,B=2']);
  // the ^|^ delimiter survives every shape, so envKeys still splits correctly
  assert.deepStrictEqual(envKeys(envVarLiterals("run: --set-env-vars '^|^A=1|RETIRE_UNGATED=1'")[0]),
    ['A', 'RETIRE_UNGATED']);
  assert.deepStrictEqual(envKeys(envVarLiterals('run: --set-env-vars ^|^A=1|RETIRE_UNGATED=1')[0]),
    ['A', 'RETIRE_UNGATED']);
});

test('QUOTE SHAPE: the flag DROPPED from a single-quoted deploy.yml still reds', () => {
  // The safe direction, asserted so the fix is not one-directional either.
  const r = placementFindings({
    'deploy.yml': "run: --set-env-vars '^|^A=1|B=2'",
    'deploy-realapp.yml': "run: --set-env-vars 'A=1'"
  });
  assert.strictEqual(r.findings.length, 1, r.findings.join(' | '));
  assert.match(r.findings[0], /no longer sets RETIRE_UNGATED/);
});

test('QUOTE SHAPE CRY-WOLF CONTROL: the wider regex must not red on prose or echo strings', () => {
  // The bare-word arm is the new false-positive risk. Both narrowings are pinned
  // here: full-line comments are stripped, and a bare value must contain `=`.
  const r = placementFindings({
    'deploy.yml': '# --set-env-vars RETIRE_UNGATED=1 is what retires this surface\nrun: --set-env-vars "^|^A=1|RETIRE_UNGATED=1"',
    'deploy-realapp.yml':
      '# NOTE: never pass --set-env-vars RETIRE_UNGATED=1 here — it would retire the product.\n' +
      'run: --set-env-vars "A=1"\n' +
      'run: echo "check RETIRE_UNGATED=1 survived the --set-env-vars rewrite."'
  });
  assert.deepStrictEqual(r.findings, [], r.findings.join(' | '));
});

test('envKeys honours gcloud\'s ^|^ custom delimiter as well as commas', () => {
  assert.deepStrictEqual(envKeys('^|^A=1|B=x,y|C=3'), ['A', 'B', 'C']);
  assert.deepStrictEqual(envKeys('A=1,B=2'), ['A', 'B']);
});

// ── the live tree ───────────────────────────────────────────────────────────

test('LIVE: the real workflow files satisfy the placement rule', () => {
  const r = placementFindings({ 'deploy.yml': WF('deploy.yml'), 'deploy-realapp.yml': WF('deploy-realapp.yml') });
  assert.strictEqual(r.broken, false, r.findings.join(' | '));
  assert.deepStrictEqual(r.findings, [], r.findings.join(' | '));
});

test('WIRING: deploy.yml actually runs the canonical liveness check after deploying', () => {
  // A predicate nothing calls is `return OK`. The marker is the script path,
  // which is a thing a maintainer types into a run: block — not a heading and
  // not a sentence, so a comment cannot satisfy this assertion.
  const yml = WF('deploy.yml');
  const codeOnly = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(codeOnly, /scripts\/check-canonical-live\.js/,
    'deploy.yml no longer invokes scripts/check-canonical-live.js — the live half is unwired');
});
