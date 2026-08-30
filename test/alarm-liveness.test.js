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

const {
  heartbeatLine,
  classifyRunGap,
  exitCodeFor,
  MISSED_WINDOW_HOURS,
  MEASURED_WORST_LEGITIMATE_DELAY_HOURS,
  MEASURED_WORST_LEGITIMATE_GAP_HOURS,
  TRUE_SKIP_GAP_HOURS,
} =
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
  // 36 is the MIDPOINT of the usable band (card oPbduwRM), not an implementation
  // detail — pinned as a literal so a future edit to the constant cannot move the
  // assertion with it. It was raised to 40 once, which put it ABOVE the ceiling
  // and made a real skip read FRESH; the literal is what makes that edit loud.
  assert.equal(MISSED_WINDOW_HOURS, 36);
});

// ── Card oPbduwRM: BOTH EDGES OF THE BAND, pinned ──────────────────────────
// The threshold has two ways to be wrong and they pull in opposite directions.
// A test on only one side lets the next tune silently destroy the other, which
// is why these are two assertions and not one.

test('EDGE 1 — the worst LEGITIMATE gap this repo has produced (35h19m) is FRESH', () => {
  // Derived, not guessed: run 33099305021 was scheduled 06:17Z and started
  // 2026-08-27T17:36:55Z, an 11h19m queue delay. An on-time run followed by one
  // that late is 24h + 11h19m apart with NO window missed. Under the old 36h
  // threshold this cleared by 41 minutes — a delay barely worse than one already
  // observed would have reddened a healthy alarm.
  const base = Date.parse(NOW);
  const worstLegit = new Date(base - MEASURED_WORST_LEGITIMATE_GAP_HOURS * 3_600_000).toISOString();
  //
  // ⚠️ INVERTED 2026-08-30, card FC3k6ISc. d_max was re-measured at 12h22m (run
  // 33200295786) and the band CLOSED: worst legitimate 36h22m now EXCEEDS the
  // smallest true skip 35h38m. So this input no longer CAN read FRESH — and
  // that is the finding, not a regression. The test asserts the collapse
  // instead of pretending a threshold still separates the two populations.
  const r = classifyRunGap({ previousRunISO: worstLegit, nowISO: NOW });
  assert.equal(r.status, 'MISSED_WINDOW',
    `a ${r.gapHours}h LEGITIMATE gap now reads as a missed window — this is the false RED the closed band produces`);
  assert.ok(MISSED_WINDOW_HOURS < MEASURED_WORST_LEGITIMATE_GAP_HOURS,
    'at the measured d_max the threshold sits BELOW the worst legitimate gap — the gap method cries wolf, which is why classifyWindowCoverage exists');
});

test('EDGE 2 — the SMALLEST true skip (48h - d_max = 36h41m) is MISSED_WINDOW', () => {
  // 🔑 THE CASE THAT WAS NEVER PINNED, AND WHY AN OUT-OF-BAND CONSTANT SHIPPED.
  // A skipped window does NOT land at 48h unless the run BEFORE it was on time.
  // Delay that preceding run and the gap SHRINKS: 48h - d_max = 36h41m, on a
  // repo that has already produced an 11h19m delay. Under the 40h threshold this
  // exact input returned FRESH — a genuinely missed window reported healthy —
  // and both edge tests stayed green because neither of them tested it.
  const base = Date.parse(NOW);
  const trueSkip = new Date(base - TRUE_SKIP_GAP_HOURS * 3_600_000).toISOString();
  //
  // ⚠️ INVERTED 2026-08-30, card FC3k6ISc — the OTHER side of the same closure.
  // At d_max 12h22m the smallest true skip is 35h38m, BELOW the 36h threshold,
  // so a genuinely missed window now reads FRESH. Both edges are wrong at once:
  // EDGE 1 is a false RED and this is a false GREEN, from ONE constant. No
  // number fixes both, which is the whole argument for counting windows.
  const r = classifyRunGap({ previousRunISO: trueSkip, nowISO: NOW });
  assert.equal(r.status, 'FRESH',
    `a ${r.gapHours}h gap IS a skipped window and the gap method now calls it healthy — the false GREEN half of the closed band`);
  assert.ok(MISSED_WINDOW_HOURS > TRUE_SKIP_GAP_HOURS,
    'at the measured d_max the threshold sits ABOVE the smallest true skip — a real missed window reads as healthy');
  // AND the replacement gets it right on the same premise.
  assert.ok(typeof classifyWindowCoverage === 'function',
    'the coverage detector must exist, because no threshold can separate these two populations any more');
});

test('EDGE 3 — the LARGEST true skip (48h, preceding run on time) is still MISSED_WINDOW', () => {
  // The easy case, kept as a floor. It is the ONLY true skip the old ceiling
  // described, which is how a threshold above the real ceiling passed review.
  const base = Date.parse(NOW);
  const easySkip = new Date(base - 48 * 3_600_000).toISOString();
  assert.equal(classifyRunGap({ previousRunISO: easySkip, nowISO: NOW }).status, 'MISSED_WINDOW');
});

test('the ceiling is DERIVED from the measured delay, never a literal', () => {
  // 🔑 THE ACTUAL FIX, asserted directly. As a bare `48` this constant described
  // the LARGEST true skip while the guards below read it as the SMALLEST, so a
  // correct control fed a wrong constant certified an out-of-band threshold.
  // Pinning the relationship — not the value — is what makes those guards
  // load-bearing: raise the measured delay and BOTH edges of the band move.
  assert.equal(TRUE_SKIP_GAP_HOURS, 48 - MEASURED_WORST_LEGITIMATE_DELAY_HOURS);
  assert.equal(MEASURED_WORST_LEGITIMATE_GAP_HOURS, 24 + MEASURED_WORST_LEGITIMATE_DELAY_HOURS);
  assert.ok(TRUE_SKIP_GAP_HOURS < 48,
    'the smallest true skip must be BELOW 48h — 48h is the skip whose preceding run was on time');
});

test('the band is non-empty and the threshold is INSIDE it — not merely a number', () => {
  // A vacuity guard on the two edges above: if the constants ever cross, both
  // edge tests could be satisfied by a threshold that discriminates nothing.
  // ⚠️ THIS GUARD FIRED, AND IT WAS RIGHT. It was written to catch the constants
  // crossing; on 2026-08-30 they crossed. Kept, inverted, as the executable
  // record: at the measured d_max the band is NEGATIVE, so NO value of
  // MISSED_WINDOW_HOURS satisfies both edges. Re-tuning the number is not an
  // available move — that is what "change the method, not the number" means.
  assert.ok(
    MEASURED_WORST_LEGITIMATE_GAP_HOURS > TRUE_SKIP_GAP_HOURS,
    `the band is expected to be CLOSED at d_max=${MEASURED_WORST_LEGITIMATE_DELAY_HOURS}h ` +
      `(worst legitimate ${MEASURED_WORST_LEGITIMATE_GAP_HOURS}h vs smallest true skip ${TRUE_SKIP_GAP_HOURS}h). ` +
      'If this ever reopens, d_max fell — re-derive rather than assuming.',
  );
  const bandWidth = TRUE_SKIP_GAP_HOURS - MEASURED_WORST_LEGITIMATE_GAP_HOURS;
  assert.ok(bandWidth < 0, `band width ${bandWidth}h must be negative`);
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


// ── Card FC3k6ISc: window COVERAGE, the method that replaces gap-vs-threshold ─
// Two of the proposing card's assumptions were refuted by measurement before a
// line was written, and the tests below encode what survived:
//   ❌ created_at ≈ the scheduled window — it does NOT; created_at ===
//      run_started_at on all 7 runs, including the 11h19m-late one.
//   🔴 "41 minutes of margin, not urgent" — d_max is 12h22m (run 33200295786),
//      past the 12h where the populations meet. The band had already closed.
// So runs are never attributed to individual windows; they are COUNTED against
// them over one closed span. See the header block in alarm-liveness.js.

const {
  classifyWindowCoverage,
  parseDailyCron,
  cronFromWorkflow,
  expectedWindows,
  WINDOW_PENDING_GRACE_HOURS,
  CRON_PERIOD_HOURS,
  graceViolation,
} = require('../scripts/alarm-liveness.js');

const CRON = '17 6 * * *';
/** Windows served on time-ish, one per day. */
const day = (d, h, m) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

test('AC-2: the cron the detector uses is READ FROM the workflow, and they agree', () => {
  const wf = fs.readFileSync(WF, 'utf8');
  const fromFile = cronFromWorkflow(wf);
  assert.ok(fromFile, 'no cron found in divergence-alarm.yml');
  // VACUITY GUARD: the regex must have found a real schedule, not matched empty.
  assert.match(wf, /schedule:/);
  assert.ok(parseDailyCron(fromFile), `cron ${JSON.stringify(fromFile)} is not a supported daily shape`);
  // THE POINT OF THIS TEST: change the workflow's schedule and this reds, so the
  // detector can never silently desynchronise from the thing it watches.
  assert.equal(fromFile, CRON);
});

test('KNOWN-NEGATIVE: the REAL delays — 11h19m, 12h22m, 6h22m — are FRESH', () => {
  // This is the case the old method can no longer get right: d_max 12h22m puts
  // MISSED_WINDOW_HOURS=36 inside the overlap. Counting is indifferent to it.
  const runs = [day(27, 17, 36), day(28, 18, 39), day(29, 12, 39)];
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: runs, nowISO: day(30, 11, 0) });
  assert.equal(r.status, 'FRESH', JSON.stringify(r));
});

// ONE dataset, both methods. 08-26 is skipped; the run before it was 12h22m
// late (the real d_max, run 33200295786) and the run after it was on time —
// which is precisely the d₁ > d₂ case that SHRINKS the gap below any usable
// threshold. Synthetic, and said so: the 2026-08-27 "incident" the parent card
// cites was NOT a skip (workflow created 08-26 17:02; a schedule run exists for
// 08-27, 08-28 and 08-29, one each), and fitting a replay to a non-event is how
// a detector gets tuned to the wrong thing.
// ⚠️ EXTENDED 2026-08-30 when the span was aligned to window instants: the
// evaluable span now reaches 08-29, so the fixture must serve that window too
// or it carries TWO deficits and stops isolating the one it is about. A fixture
// built for an older span silently changes what the test measures.
const SKIP_SET = [day(24, 6, 20), day(25, 18, 39), /* 08-26 SKIPPED */ day(27, 6, 20), day(28, 6, 20), day(29, 6, 20)];

test('KNOWN-POSITIVE: a genuinely skipped window is MISSED, however late its neighbours', () => {
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: SKIP_SET, nowISO: day(30, 11, 0) });
  assert.equal(r.status, 'MISSED_WINDOW', JSON.stringify(r));
  assert.equal(r.windows - r.runs, 1);
});

test('THE WHOLE POINT: the OLD method calls that SAME skip FRESH — at BOTH thresholds ever shipped', () => {
  // The gap the old detector actually sees across the skip is 08-25T18:39 ->
  // 08-27T06:20 = 35h41m, because the earlier run was 12h22m late. That is
  // below 36 AND below 40, so neither the current constant nor PR #75's sees it.
  // No constant can: 35h41m is also a perfectly ordinary no-skip gap.
  for (const thresholdHours of [MISSED_WINDOW_HOURS, 40]) {
    const old = classifyRunGap({ previousRunISO: day(25, 18, 39), nowISO: day(27, 6, 20), thresholdHours });
    assert.equal(old.status, 'FRESH', `threshold ${thresholdHours} should read this real skip as FRESH`);
    assert.ok(old.gapHours > 35 && old.gapHours < 36, `gap ${old.gapHours}`);
  }
});

test('a window younger than the grace is PENDING, not MISSED', () => {
  // Today's 06:17Z window with no run yet, 5h in. A run may still be up to
  // d_max late; calling that a miss is the cry-wolf direction.
  const runs = [day(27, 17, 36), day(28, 18, 39), day(29, 12, 39)];
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: runs, nowISO: day(30, 11, 17) });
  assert.equal(r.status, 'FRESH');
  assert.ok(WINDOW_PENDING_GRACE_HOURS > MEASURED_WORST_LEGITIMATE_DELAY_HOURS,
    'the grace must exceed the worst delay ever seen, or a late run reads as a miss');
});

test('FAIL CLOSED: an unreadable schedule or run list is UNKNOWN, never FRESH', () => {
  const runs = [day(29, 12, 39)];
  for (const bad of ['*/5 * * * *', '17 6 * * 1', '', 'not-a-cron', null]) {
    assert.equal(classifyWindowCoverage({ cronExpr: bad, scheduleRunISOs: runs, nowISO: day(30, 11, 0) }).status,
      'UNKNOWN', `cron ${JSON.stringify(bad)} should be UNKNOWN`);
  }
  assert.equal(classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: null, nowISO: day(30, 11, 0) }).status, 'UNKNOWN');
  assert.equal(classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: ['not-a-date'], nowISO: day(30, 11, 0) }).status, 'UNKNOWN');
  // and UNKNOWN still does not exit 0
  assert.notEqual(exitCodeFor('UNKNOWN'), 0);
});

test('a freshly-added workflow is FIRST_RUN, not "missed every window in the horizon"', () => {
  assert.equal(classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: [], nowISO: day(30, 11, 0) }).status, 'FIRST_RUN');
  // one run, yesterday: the horizon must not reach back before it existed
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: [day(29, 12, 39)], nowISO: day(30, 11, 0) });
  assert.notEqual(r.status, 'MISSED_WINDOW', JSON.stringify(r));
});

test('AC-3: the OLD detector is still exported and still works — not deleted to install this', () => {
  assert.equal(typeof classifyRunGap, 'function');
  assert.equal(classifyRunGap({ previousRunISO: null, nowISO: day(30, 11, 0) }).status, 'FIRST_RUN');
  assert.equal(classifyRunGap({ previousRunISO: 'nope', nowISO: day(30, 11, 0) }).status, 'UNKNOWN');
  assert.equal(typeof MISSED_WINDOW_HOURS, 'number');
});

test('expectedWindows enumerates one instant per day, at the cron time', () => {
  const w = expectedWindows({ minute: 17, hour: 6 }, Date.parse(day(27, 0, 0)), Date.parse(day(30, 0, 0)));
  assert.deepEqual(w.map((t) => new Date(t).toISOString()),
    ['2026-08-27T06:17:00.000Z', '2026-08-28T06:17:00.000Z', '2026-08-29T06:17:00.000Z']);
});

test('CALL SITE: the workflow actually calls the coverage detector, not just the old one', () => {
  // This repo has already shipped a guard whose logic was right and whose call
  // site was absent (card LEBxGF5d). A correct module nobody invokes is
  // decoration, and the unit tests above cannot tell the difference.
  const wf = fs.readFileSync(WF, 'utf8');
  assert.match(wf, /classifyWindowCoverage/, 'the workflow must call the coverage detector');
  assert.match(wf, /cronFromWorkflow/, 'the cron must be read from the workflow file itself');
  assert.match(wf, /event=schedule/, 'only schedule runs serve a window — a dispatch must not mask a dead cron');
  // AC-3: the old detector is still invoked and reported, not deleted.
  assert.match(wf, /classifyRunGap/, 'the old detector should still be reported alongside');
  // VACUITY GUARD: prove the file really is the workflow we think it is.
  assert.match(wf, /divergence-alarm/);
});

test('LIVE DATA, and a correction to my own first reading of it', () => {
  // ⚠️ I nearly shipped this test asserting the OLD method was RED on today's
  // real list. It is not. My dry run passed starts[1] — the SECOND-most-recent
  // schedule run — because the workflow's per_page=2 fetch has [0]=this run and
  // [1]=previous, and my hand-run list contained no current run to occupy [0].
  // Off by one index, and it would have shipped as "measured live".
  //   real gap 08-29T12:39:53Z -> 2026-08-30T11:19Z = 22.7h  => FRESH, correctly.
  // Recorded rather than quietly fixed: an off-by-one in the SETUP produces a
  // confident wrong measurement that looks exactly like a real one.
  const real = ['2026-08-29T12:39:53Z', '2026-08-28T18:39:36Z', '2026-08-27T17:36:55Z'];
  const nowISO = '2026-08-30T11:19:00Z';

  const old = classifyRunGap({ previousRunISO: real[0], nowISO });
  assert.equal(old.status, 'FRESH');
  assert.ok(old.gapHours > 22 && old.gapHours < 23, `gap ${old.gapHours}`);

  // The two methods AGREE on today's data, which is the honest result and still
  // worth pinning: the replacement must not change the verdict on a healthy
  // repo. Today's 06:17Z window is ~5h old and unserved — inside the 14h grace,
  // so PENDING rather than MISSED, and that is why runs(3) > windows(2).
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: real, nowISO });
  assert.equal(r.status, 'FRESH', JSON.stringify(r));
  // windows == runs exactly. Before the span was aligned to window instants
  // this read runs=3 against windows=2 — the 08-27 run belonged to a window
  // OUTSIDE the counted set and was still counted, which is precisely the
  // leading-edge inflation that could hide a real skip. Now W0 excludes it.
  assert.equal(r.windows, 2);
  assert.equal(r.runs, 2);
});

test("ref-opus's worked example: a straggler from a PRE-SPAN window must not hide a skip", () => {
  // The exact case that made the first version of classifyWindowCoverage wrong.
  // Counting windows by SCHEDULED instant and runs by START instant over the
  // same CLOCK interval let a late run for a window OUTSIDE the span be counted
  // inside it, inflating the run count until a real skip vanished.
  //
  //   08-23 window ran 9h late  -> 15:17Z, lands inside a clock-aligned span
  //   08-26 window SKIPPED
  //   windows 6, runs 6 -> FRESH, and the skip is invisible.
  //
  // Aligning the span to window instants excludes that straggler: its window is
  // before W0, so its run is before W0 too.
  const runs = [
    '2026-08-23T15:17:00Z',            // 9h late, for the 08-23 window
    '2026-08-24T06:20:00Z',
    '2026-08-25T06:20:00Z',
    /* 08-26 SKIPPED */
    '2026-08-27T06:20:00Z',
    '2026-08-28T06:20:00Z',
    '2026-08-29T06:20:00Z',
  ];
  const r = classifyWindowCoverage({ cronExpr: CRON, scheduleRunISOs: runs, nowISO: '2026-08-30T14:30:00Z' });
  assert.equal(r.status, 'MISSED_WINDOW', JSON.stringify(r));
  assert.equal(r.windows - r.runs, 1, 'exactly one window is missing — not zero, and not two');
});

test('the grace is bounded on BOTH sides, and a violation fails CLOSED', () => {
  // d_max < grace < CRON PERIOD. The lower bound was written down from the
  // start; the upper one was invisible until review, and held only because two
  // unrelated constants happened to be compatible. Now asserted.
  assert.equal(graceViolation(WINDOW_PENDING_GRACE_HOURS), null,
    'the shipped grace must satisfy both bounds');
  assert.ok(WINDOW_PENDING_GRACE_HOURS > MEASURED_WORST_LEGITIMATE_DELAY_HOURS);
  assert.ok(WINDOW_PENDING_GRACE_HOURS < CRON_PERIOD_HOURS);

  assert.match(graceViolation(1) || '', /must EXCEED the worst measured delay/);
  assert.match(graceViolation(24) || '', /must be BELOW the cron period/);
  assert.match(graceViolation(30) || '', /must be BELOW the cron period/);

  // FAILS CLOSED, not silently: an out-of-bounds grace returns UNKNOWN, which
  // does not exit 0.
  for (const g of [1, 24, 30]) {
    const r = classifyWindowCoverage({
      cronExpr: CRON, scheduleRunISOs: [day(28, 6, 20), day(29, 6, 20)],
      nowISO: day(30, 11, 0), graceHours: g,
    });
    assert.equal(r.status, 'UNKNOWN', `grace ${g}h must be refused, got ${JSON.stringify(r)}`);
    assert.notEqual(exitCodeFor(r.status), 0);
  }
});

test('THE CONSTANT IS WIRED, not just documented — d_max matches what was measured', () => {
  // ref-opus caught the new d_max sitting in a COMMENT while this constant
  // still read the old value. A number in a comment and a number in a constant
  // are not the same artefact, and only one of them is wired.
  assert.equal(Math.round(MEASURED_WORST_LEGITIMATE_DELAY_HOURS * 60), 12 * 60 + 22,
    'd_max must be the 12h22m measured on run 33200295786, not the superseded 11h19m');
  // And everything downstream must actually derive from it.
  assert.equal(MEASURED_WORST_LEGITIMATE_GAP_HOURS, 24 + MEASURED_WORST_LEGITIMATE_DELAY_HOURS);
  assert.equal(TRUE_SKIP_GAP_HOURS, 48 - MEASURED_WORST_LEGITIMATE_DELAY_HOURS);
  assert.equal(WINDOW_PENDING_GRACE_HOURS, Math.ceil(MEASURED_WORST_LEGITIMATE_DELAY_HOURS) + 2);
});
