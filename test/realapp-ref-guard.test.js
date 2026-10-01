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

test('exit 0 (ancestor or equal) allows the deploy — WITH the second probe saying "not on main"', () => {
  // Card 8itdTRtX: this test used to pass exit 0 alone and expect allow. That
  // was the fail-open opsagents-cto caught on PR #98 — once main is an ancestor
  // of real-app, exit 0 is what a dispatch on MAIN measures too. The PROD row
  // now requires a probe against main, so exit 0 alone is cannot-verify (see
  // the next test) and this is the shape that allows.
  const v = refDeployVerdict(0, { dispatchedRef: EXPECTED_REF, forbidden: [{ ref: 'main', exitCode: 1 }] });
  assert.equal(v.allow, true);
  assert.equal(v.verdict, 'allow');
});

test('exit 0 ALONE is no longer an allow — the PROD row demands proof the ref is not on main', () => {
  const v = refDeployVerdict(0, { dispatchedRef: EXPECTED_REF });
  assert.equal(v.allow, false, 'PR #67\'s one-probe call shape allowed a deploy — that is the 8itdTRtX fail-open');
  assert.equal(v.verdict, 'cannot-verify');
  assert.match(v.message, /NOT on the main line/);
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
  const onMain = spawnSync('git', ['merge-base', '--is-ancestor', mainRef, mainRef], { cwd: repo })
    .status;
  assert.equal(onMain, 0, 'git is not answering: main is not an ancestor of itself');
  const v = refDeployVerdict(rc, { dispatchedRef: 'main', forbidden: [{ ref: 'main', exitCode: onMain }] });

  // ⚠️ RETARGETED (card 8itdTRtX). This used to say: "if the branches
  // reconcile, main BECOMES a legitimate ancestor and this must not cry wolf" —
  // and asserted allow on rc === 0. That sentence is the fail-open: after the
  // #70 ancestry merge main IS an ancestor of real-app, and a dispatch on main
  // is still a dispatch of the wrong line onto PROD. The invariant that holds
  // in BOTH worlds is that the FULL verdict refuses main — by the first probe
  // before the merge, by the second after it.
  assert.equal(v.allow, false, `a dispatch on main was ALLOWED onto PROD (is-ancestor main real-app -> ${rc})`);
  assert.equal(v.verdict, 'refuse');
  assert.equal(v.reason, rc === 0 ? 'shared-line' : 'off-line');
});

// ── 3. THE WIRING ───────────────────────────────────────────────────────────

test('the guard step exists in deploy-realapp.yml', () => {
  assert.match(wf, /- name: Refuse any ref that is not on the real-app line/);
  assert.match(
    wf,
    /refDeployVerdict/,
    'the step must call the tested decision by name, not re-implement it',
  );
});

test('the ref name is READ from the module, never re-typed into the workflow', () => {
  // Caught by a probe against this file, not reasoned about: an earlier version
  // asserted only /realappRefGuard/, which the `node -e` body satisfies on its
  // own — so replacing the EXPECTED_REF lookup with a hardcoded 'real-app'
  // stayed fully GREEN. Behaviour survived that mutation, but it plants a
  // SECOND source of truth for the one ref this workflow may deploy, and the
  // two only have to disagree once.
  assert.match(wf, /require\(['"]\.\/lib\/realappRefGuard['"]\)\.EXPECTED_REF/);
  const runBody = wf.slice(
    wf.indexOf('- name: Refuse any ref that is not on the real-app line'),
    wf.indexOf('google-github-actions/auth@v2'),
  );
  assert.doesNotMatch(
    runBody.replace(/require\([^)]*\)\.EXPECTED_REF/g, ''),
    /['"]real-app['"]/,
    'the guard must not carry its own literal copy of the ref name',
  );
});

test('the guard runs BEFORE auth and BEFORE any deploy', () => {
  const guard = wf.indexOf('Refuse any ref that is not on the real-app line');
  const auth = wf.indexOf('google-github-actions/auth@v2');
  const deploy = wf.indexOf('gcloud run deploy');
  for (const [name, at] of [['guard', guard], ['auth', auth], ['deploy', deploy]]) {
    assert.ok(at > -1, `anchor not found: ${name}`);
  }
  // indexOf returns -1 when absent, and -1 is less than any real position — so
  // "the guard is before the deploy" would be satisfied by there being NO
  // deploy at all. Presence is asserted first, above, deliberately.
  assert.ok(guard < auth, 'the guard must not run after credentials are minted');
  assert.ok(guard < deploy, 'the guard must not run after the deploy has started');
});

test('the guard carries no `if:` — it cannot be switched off in place', () => {
  const block = wf.slice(
    wf.indexOf('- name: Refuse any ref that is not on the real-app line'),
    wf.indexOf('google-github-actions/auth@v2'),
  );
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /^\s{8}if:/m, '`if: false` leaves the step textually present and inert');
});

test('checkout uses fetch-depth: 0 — without it the guard can never answer', () => {
  // The default depth-1 clone has no history and no real-app ref, so
  // --is-ancestor exits 128 and every dispatch aborts as cannot-verify. This
  // value is what makes the guard usable rather than permanently red.
  const checkout = wf.indexOf('actions/checkout@v4');
  const guard = wf.indexOf('Refuse any ref that is not on the real-app line');
  assert.ok(checkout > -1 && guard > checkout, 'checkout must precede the guard');
  assert.match(wf.slice(checkout, guard), /fetch-depth:\s*0/);
});

test('the exit code is captured with `|| rc=$?`, not left to `bash -e`', () => {
  // GitHub runs run: blocks under `bash -e`. A bare `--is-ancestor` returning 1
  // aborts the step immediately, so the refusal message this card requires
  // would never be printed — fail-closed, but silent about which ref to use.
  assert.match(wf, /\|\|\s*rc=\$\?/);
});

test('the dispatched ref reaches the shell through env:, not inline interpolation', () => {
  // A git branch name may legally contain `$`, backticks and parens, so an
  // inline `${{ github.ref_name }}` inside a double-quoted shell word is a
  // command-substitution sink.
  const block = wf.slice(
    wf.indexOf('- name: Refuse any ref that is not on the real-app line'),
    wf.indexOf('google-github-actions/auth@v2'),
  );
  assert.match(block, /REF_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.match(block, /process\.env\.REF_NAME/);
  const runBody = block.slice(block.indexOf('run: |'));
  assert.doesNotMatch(
    runBody,
    /\$\{\{\s*github\.ref_name\s*\}\}/,
    'github.ref_name must not be interpolated into the run: body',
  );
});

test('VACUITY: the comment stripper leaves real code intact', () => {
  // Without this, a stripper that ate code would blank the file and every
  // wiring assertion above would be passing on nothing.
  assert.ok(wf.length > 2000, 'stripped workflow is implausibly short');
  assert.match(wf, /^\s*jobs:/m);
  assert.match(wf, /workflow_dispatch:/);
});
