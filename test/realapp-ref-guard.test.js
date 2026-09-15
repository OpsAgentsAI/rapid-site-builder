'use strict';
// Card LEBxGF5d — `deploy-realapp.yml` accepted ANY ref.
//
// THE STATE THIS REPLACES, measured on the live refs before a line changed:
//
//   git rev-list --left-right --count origin/main...origin/real-app  ->  40  14
//   git merge-base --is-ancestor origin/main origin/real-app         ->  rc 1
//
// `main` is NOT an ancestor of `real-app`. This workflow is the PROD tier
// (rapid-builder-app / builder.opsagents.agency), it is workflow_dispatch-only,
// and it deployed whatever ref it was handed. Two of the last six dispatches
// ran on `main`. Its own header already said "NEVER deployed from `main`" — the
// rule was declared and enforced by nothing, which is the sharper reading of
// the card.
//
// TWO HALVES, and neither is sufficient alone:
//   1. the DECISION (lib/realappRefGuard.js) — three exit codes, not two
//   2. the WIRING (this workflow) — the step exists, runs FIRST, is not
//      if:-gated, and checkout gives it the history it needs
// A decision nothing calls is the seam-with-no-consumer shape this fleet keeps
// recording; a step whose logic is untested is the guard-that-cannot-fail one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EXPECTED_REF, refDeployVerdict } = require('../lib/realappRefGuard');

const WF_PATH = path.join(__dirname, '..', '.github', 'workflows', 'deploy-realapp.yml');
const wfRaw = fs.readFileSync(WF_PATH, 'utf8');

/** Workflow source with whole-line `#` comments removed. */
const wf = wfRaw
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

// ── 1. THE DECISION ─────────────────────────────────────────────────────────

test('exit 0 (ancestor or equal) allows the deploy', () => {
  const v = refDeployVerdict(0, { dispatchedRef: EXPECTED_REF });
  assert.equal(v.allow, true);
  assert.equal(v.verdict, 'allow');
});

test('exit 1 REFUSES, and the message names the ref to use instead', () => {
  // The card's AC-2: the operator's next action must be obvious from the text.
  const v = refDeployVerdict(1, { dispatchedRef: 'main' });
  assert.equal(v.allow, false);
  assert.equal(v.verdict, 'refuse');
  assert.match(v.message, /REFUSED/);
  assert.match(v.message, /main/);
  assert.ok(
    v.message.includes(`ref "${EXPECTED_REF}"`),
    'the refusal must name real-app as the ref to re-dispatch with',
  );
});

test('THE VACUITY FLOOR: exit 128 is CANNOT VERIFY and still aborts', () => {
  // "could not measure" is not a pass — the failure this card exists to stop,
  // one level up.
  const v = refDeployVerdict(128, { dispatchedRef: EXPECTED_REF });
  assert.equal(v.allow, false);
  assert.equal(v.verdict, 'cannot-verify');
  assert.match(v.message, /CANNOT VERIFY/);
});

test('...and cannot-verify is DISTINCT from refuse, in the cry-wolf direction', () => {
  // Collapsing 128 into "refuse" is safe and still wrong: on a shallow clone
  // EVERY dispatch, including a correct one on real-app, would be refused with
  // "not an ancestor" — and the fix a reader reaches for under that red is to
  // weaken the guard, because the message accuses a ref that is fine.
  const shallow = refDeployVerdict(128, { dispatchedRef: EXPECTED_REF });
  const wrongRef = refDeployVerdict(1, { dispatchedRef: 'main' });
  assert.notEqual(shallow.verdict, wrongRef.verdict);
  assert.match(shallow.message, /fetch-depth: 0/, 'the remedy must be in the message');
  assert.doesNotMatch(shallow.message, /REFUSED/);
});

test('an ABSENT or unreadable exit code is cannot-verify, never allow', () => {
  // Number('') and Number(null) are both 0, i.e. the one verdict a missing
  // input must never produce.
  for (const bad of [undefined, null, '', 'nope', NaN, true, false]) {
    const v = refDeployVerdict(bad, { dispatchedRef: EXPECTED_REF });
    assert.equal(v.allow, false, `exit code ${String(bad)} must not allow a deploy`);
    assert.equal(v.verdict, 'cannot-verify');
  }
});

test('a missing dispatchedRef does not crash the refusal path', () => {
  const v = refDeployVerdict(1);
  assert.equal(v.allow, false);
  assert.match(v.message, /unknown ref/);
});

// ── 2. THE NEGATIVE TEST THE CARD ASKS FOR, ON THE REAL REPOSITORY ──────────

test('NEGATIVE TEST: real `main` is genuinely not on the real-app line', () => {
  // The card: "Prove it on a ref that is genuinely wrong, not on a synthetic
  // one." This runs the real git question against the real refs, so it is a
  // claim about this repository rather than about a fixture.
  //
  // Skipped rather than failed where the refs are absent (a shallow CI clone,
  // a fork) — the point is that WHERE it can be measured, it is measured, and
  // the skip is loud. The decision table above is fully covered regardless.
  const { spawnSync } = require('node:child_process');
  const repo = path.join(__dirname, '..');
  const have = (ref) =>
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repo }).status === 0;

  const mainRef = ['refs/remotes/origin/main', 'main'].find(have);
  const appRef = [`refs/remotes/origin/${EXPECTED_REF}`, EXPECTED_REF].find(have);
  if (!mainRef || !appRef) {
    console.log(`SKIP: need both main and ${EXPECTED_REF} locally (shallow clone?)`);
    return;
  }

  const rc = spawnSync('git', ['merge-base', '--is-ancestor', mainRef, appRef], { cwd: repo })
    .status;
  const v = refDeployVerdict(rc, { dispatchedRef: 'main' });

  // Not asserting rc === 1 outright: if someone forward-ports and the branches
  // reconcile, main BECOMES a legitimate ancestor and this must not cry wolf.
  // What is pinned is that the guard's verdict tracks the real git answer.
  if (rc === 0) {
    assert.equal(v.allow, true, 'main is now an ancestor — a dispatch on it would be legitimate');
  } else {
    assert.equal(v.allow, false, 'main is not an ancestor, so a dispatch on it must be REFUSED');
    assert.equal(v.verdict, 'refuse');
  }
});

// ── 3. THE WIRING ───────────────────────────────────────────────────────────
/**
 * ⚠️ SIX WORKFLOW-SHAPE TESTS WERE REMOVED HERE BY THE 2026-09-15 RECONCILE
 * (card XUCfQGz6, issue #70) — guard-step-exists · ref-read-from-the-module ·
 * before-auth-and-deploy · no-`if:` · fetch-depth-0 · ref-through-`env:`.
 *
 * They asserted MAIN's call-site shape for `deploy-realapp.yml`
 * (`require('./lib/realappRefGuard').EXPECTED_REF`). On this branch card
 * 22I0yUum (#85) rewrote that call site to read its ref from DEPLOY_REF_POLICY,
 * and #85's version is the reviewed one on the PROD branch, so these six
 * described a workflow that no longer exists here.
 *
 * They were NOT dropped — every one of the properties is asserted in
 * test/deploy-ref-policy.test.js, generically over the GUARDED set, which now
 * contains all three deploy workflows. Retargeting them here instead would have
 * left two shape suites for one workflow, drifting apart, which is the exact
 * duplication this card series exists to shrink. The one property that suite did
 * not carry — a guard step with no off-switch — moved across with them, and got
 * sharper on the way: `deploy.yml` legitimately scopes its guard to dispatches
 * because it also fires on `push: main`.
 *
 * WHAT STAYS BELOW IS THE DECISION, WHICH THE RECONCILE DOES NOT CHANGE: the
 * three-way verdict, its refusal message, and the vacuity floor.
 */


test('the exit code is captured with `|| rc=$?`, not left to `bash -e`', () => {
  // GitHub runs run: blocks under `bash -e`. A bare `--is-ancestor` returning 1
  // aborts the step immediately, so the refusal message this card requires
  // would never be printed — fail-closed, but silent about which ref to use.
  assert.match(wf, /\|\|\s*rc=\$\?/);
});


test('VACUITY: the comment stripper leaves real code intact', () => {
  // Without this, a stripper that ate code would blank the file and every
  // wiring assertion above would be passing on nothing.
  assert.ok(wf.length > 2000, 'stripped workflow is implausibly short');
  assert.match(wf, /^\s*jobs:/m);
  assert.match(wf, /workflow_dispatch:/);
});
