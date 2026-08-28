'use strict';

// Card oWtnNDT5. These pin the DECISIONS, not the plumbing. The live-tree
// assertions at the bottom pin that the workflow actually CALLS them, because
// this repo has already shipped one guard whose logic was correct and whose
// call site was absent (card LEBxGF5d: EXPECTED_REF asserted in two places, one
// of which satisfied the test on its own).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { heartbeatLine, classifyRunGap, exitCodeFor, MISSED_WINDOW_HOURS } =
  require('../scripts/alarm-liveness.js');

const WF = path.join(__dirname, '..', '.github', 'workflows', 'divergence-alarm.yml');
const wfSrc = fs.readFileSync(WF, 'utf8');

// A workflow file is YAML with prose comments that quote the very strings we
// assert on — the header alone names "Re-measured" and the close text. Strip
// whole-comment lines before any source assertion, or a comment satisfies it.
// (This repo has been bitten by exactly that; see the paired control below.)
const stripYamlComments = (s) =>
  s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const wf = stripYamlComments(wfSrc);

// ── heartbeatLine ──────────────────────────────────────────────────────────
test('the stamp carries the EVENT, not just a timestamp — that is the whole point', () => {
  const line = heartbeatLine({ ts: '2026-08-28 06:17 UTC', event: 'schedule', verdict: 'clear' });
  assert.match(line, /trigger: schedule/);
  assert.match(line, /2026-08-28 06:17 UTC/);
  assert.match(line, /verdict: clear/);
});

test('a dispatch stamp and a schedule stamp are DISTINGUISHABLE', () => {
  const a = heartbeatLine({ ts: 'T', event: 'schedule', verdict: 'clear' });
  const b = heartbeatLine({ ts: 'T', event: 'workflow_dispatch', verdict: 'clear' });
  assert.notEqual(a, b);
  // The real defect reproduced: issue #70 carries two comments of identical
  // FORM, one from each trigger. Same timestamp, same verdict, no event ->
  // identical strings. That is the state this function exists to make impossible.
  assert.notEqual(a.includes('workflow_dispatch'), b.includes('workflow_dispatch'));
});

test('an EMPTY event is refused rather than silently producing a weaker stamp', () => {
  assert.throws(() => heartbeatLine({ ts: 'T', event: '', verdict: 'clear' }), /event is required/);
  assert.throws(() => heartbeatLine({ ts: 'T', event: '   ', verdict: 'clear' }), /event is required/);
});

test('an unknown verdict is refused — "clear" must never be the default', () => {
  assert.throws(() => heartbeatLine({ ts: 'T', event: 'schedule', verdict: undefined }), /verdict must be/);
  assert.throws(() => heartbeatLine({ ts: 'T', event: 'schedule', verdict: 'ok' }), /verdict must be/);
});

// ── classifyRunGap ─────────────────────────────────────────────────────────
const NOW = '2026-08-28T06:17:00Z';

test('a normal daily cadence is FRESH', () => {
  const r = classifyRunGap({ previousRunISO: '2026-08-27T06:17:00Z', nowISO: NOW });
  assert.equal(r.status, 'FRESH');
  assert.equal(Math.round(r.gapHours), 24);
});

test('the 11h19m delay actually observed on run 33099305021 is still FRESH — not a cry wolf', () => {
  // Measured: the 06:17Z window was delivered at 17:36:55Z. If that reads as a
  // missed window the check fires on healthy behaviour and gets switched off.
  const r = classifyRunGap({ previousRunISO: '2026-08-27T17:36:55Z', nowISO: NOW });
  assert.equal(r.status, 'FRESH');
});

test('a genuinely missed window is MISSED_WINDOW', () => {
  const r = classifyRunGap({ previousRunISO: '2026-08-26T06:17:00Z', nowISO: NOW });
  assert.equal(r.status, 'MISSED_WINDOW');
  assert.ok(r.gapHours > MISSED_WINDOW_HOURS);
});

test('the FIRST run is not a missed window — a fresh install must not be red', () => {
  assert.equal(classifyRunGap({ previousRunISO: null, nowISO: NOW }).status, 'FIRST_RUN');
  assert.equal(classifyRunGap({ previousRunISO: '', nowISO: NOW }).status, 'FIRST_RUN');
});

test('an UNPARSEABLE previous timestamp is UNKNOWN, never FRESH — fail closed', () => {
  const r = classifyRunGap({ previousRunISO: 'not-a-date', nowISO: NOW });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.gapHours, null);
});

test('a broken NOW throws rather than answering', () => {
  assert.throws(() => classifyRunGap({ previousRunISO: NOW, nowISO: 'nope' }), /unparseable nowISO/);
});

test('the threshold is a real boundary in BOTH directions', () => {
  const base = Date.parse(NOW);
  const under = new Date(base - (MISSED_WINDOW_HOURS - 1) * 3_600_000).toISOString();
  const over = new Date(base - (MISSED_WINDOW_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(classifyRunGap({ previousRunISO: under, nowISO: NOW }).status, 'FRESH');
  assert.equal(classifyRunGap({ previousRunISO: over, nowISO: NOW }).status, 'MISSED_WINDOW');
  // 36 is the CARD's number, not an implementation detail — pinned as a literal
  // so a future edit to the constant cannot move the assertion with it.
  assert.equal(MISSED_WINDOW_HOURS, 36);
});

test('UNKNOWN does not exit 0 — a check that cannot answer must not answer healthy', () => {
  assert.equal(exitCodeFor('FRESH'), 0);
  assert.equal(exitCodeFor('FIRST_RUN'), 0);
  assert.equal(exitCodeFor('MISSED_WINDOW'), 1);
  assert.equal(exitCodeFor('UNKNOWN'), 2);
  assert.throws(() => exitCodeFor('probably-fine'), /unknown status/);
});

// ── the workflow actually uses them (call-site pins) ───────────────────────
test('WIRED: the workflow stamps liveness on EVERY path, not only when diverged', () => {
  // The all-clear path is the one that wrote nothing; an `if:`-guarded stamp
  // would re-open exactly the hole this card is about.
  // Anchor to END OF LINE and assert the step name is UNIQUE.
  // Found by probe P2: the first version, /name:\s*Stamp liveness/, is a
  // SUBSTRING match — a step renamed "Stamp liveness_DISABLED_PROBE" satisfied
  // it and the probe read GREEN. A rename is harmless (the step still runs);
  // a NEAR-DUPLICATE is not, because the slice below starts at the first hit.
  //
  // ⚠️ THE COUNT IS THE HALF THAT IS PROVEN. I also tried replacing the
  // indexOf lookup with a match-position slice and could NOT construct a case
  // where it changes the verdict — probe P7 planted a decoy step above the real
  // one and both forms agreed; a padded decoy reddened both equally. So that
  // refinement is NOT claimed here, and the assertion is left as the count plus
  // the deletion case, which is what the probes actually demonstrate:
  // removing the whole Stamp liveness step block reds 2 (P2, run faithfully).
  const anchors = wf.match(/^\s*- name: Stamp liveness\s*$/gm) || [];
  assert.equal(anchors.length, 1, `expected exactly one "Stamp liveness" step, found ${anchors.length}`);
  const stamp = wf.slice(wf.indexOf('- name: Stamp liveness'));
  assert.match(stamp.slice(0, 400), /if:\s*always\(\)/, 'the stamp step must run on every path');
});

test('WIRED: the stamp is computed by this module, not re-spelled in YAML', () => {
  assert.match(wf, /alarm-liveness\.js/);
});

test('WIRED: both existing issue writes now name the trigger', () => {
  const reMeasured = wf.match(/Re-measured[^\n]*/g) || [];
  const cleared = wf.match(/Cleared \$\(date[^\n]*/g) || [];
  assert.ok(reMeasured.length >= 1, 'the "Re-measured" comment vanished');
  assert.ok(cleared.length >= 1, 'the "Cleared" comment vanished');
  for (const line of [...reMeasured, ...cleared]) {
    assert.match(line, /github\.event_name|EVENT_NAME/, `stamp without a trigger: ${line.trim()}`);
  }
});

test('PAIRED CONTROL: comment-stripping is load-bearing for the assertion above', () => {
  // The file's own header prose quotes "Re-measured". Without stripping, the
  // trigger assertion could be satisfied — or defeated — by a comment rather
  // than by the command that runs. Proven, not assumed:
  const rawHits = (wfSrc.match(/Re-measured[^\n]*/g) || []).length;
  const codeHits = (wf.match(/Re-measured[^\n]*/g) || []).length;
  assert.ok(rawHits > codeHits, 'expected at least one commented mention to be stripped');
});

test('VACUITY: the workflow was actually read', () => {
  assert.ok(wf.length > 2000, 'workflow source looks empty — the assertions above prove nothing');
  assert.match(wf, /divergence-alarm/);
});

test('WIRED: a missed window actually REDS the run (AC-2 is a red, not a note)', () => {
  const idx = wf.indexOf('name: Fail the run if the alarm is up');
  assert.ok(idx > -1, 'the fail step is missing');
  const failStep = wf.slice(idx, idx + 600);
  assert.match(failStep, /steps\.gap\.outcome\s*==\s*'failure'/,
    'the fail step ignores the liveness verdict — a missed window would be recorded and never noticed');
  assert.match(failStep, /exit 1/);
});

test('WIRED: the gap step cannot suppress the divergence measurement', () => {
  const idx = wf.indexOf('name: Detect a missed window');
  assert.ok(idx > -1, 'the gap step is missing');
  const gapStep = wf.slice(idx, wf.indexOf('name: Measure unreachable work'));
  assert.match(gapStep, /continue-on-error:\s*true/,
    'without continue-on-error a missed window aborts before the branches are measured at all');
  // …and it must run BEFORE the measurement, or "previous run" includes this one.
  assert.ok(wf.indexOf('name: Detect a missed window') < wf.indexOf('name: Measure unreachable work'));
});

// ── the permission the gap step cannot run without ─────────────────────────
// Card oWtnNDT5, second pass. Every test above this line passed on the commit
// that shipped #72, and the gap step STILL could not run: the unit tests feed
// classifyRunGap() a synthetic timestamp, so they exercise the classifier and
// say nothing about whether the workflow can obtain a real one. Measured on
// run 33152268617 — `gh: Resource not accessible by integration (HTTP 403)`,
// because `permissions:` granted contents+issues and the step reads
// `/actions/workflows/.../runs`, which on a private repo needs `actions`.
//
// The gap between "the logic is right" and "the caller can feed it" is where
// this repo keeps losing guards, so the permission is pinned here rather than
// left to review.
test('WIRED: the token can actually READ the run history the gap step depends on', () => {
  const idx = wf.indexOf('permissions:');
  assert.ok(idx > -1, 'the workflow declares no permissions block');
  const perms = wf.slice(idx, wf.indexOf('env:', idx));
  assert.match(perms, /actions:\s*read/,
    'permissions: is missing `actions: read` — the "Detect a missed window" step 403s on ' +
    'GET /actions/workflows/.../runs and reports UNKNOWN on every run, reddening the alarm ' +
    'for a reason unrelated to divergence (measured: run 33152268617)');
  // The step this permission exists for must still be the one making the call.
  const gapStep = wf.slice(wf.indexOf('name: Detect a missed window'),
                           wf.indexOf('name: Measure unreachable work'));
  assert.match(gapStep, /actions\/workflows\/divergence-alarm\.yml\/runs/,
    'the gap step no longer reads the run history — this permission is then unexplained');
});

test('CONTROL: the actions:read assertion is not satisfied by its own comment', () => {
  // The comment block above `actions: read` in the workflow says the words
  // "actions: read" out loud. Asserting on the RAW source would therefore pass
  // even if the permission itself were deleted. Prove the strip does its job.
  assert.ok(/^\s*#.*actions: read/m.test(wfSrc),
    'expected the workflow to carry a commented mention of actions: read to strip');
  assert.ok(!/^\s*#.*actions: read/m.test(wf),
    'stripYamlComments left a commented mention in place — every assertion on `wf` is suspect');
});
