#!/usr/bin/env node
'use strict';

// Card oWtnNDT5 — the divergence alarm could not report its own liveness.
//
// ── WHAT WAS ACTUALLY WRONG, MEASURED 2026-08-28 06:3xZ ─────────────────────
// The card that filed this said the alarm "has never run on its SCHEDULE" and
// that "ran, divergence unchanged" is byte-identical to "never ran". BOTH
// halves were measured false, and correcting them is what located the real
// hole:
//
//   actions/workflows/divergence-alarm.yml/runs  ->  3 runs, ALL conclusion=failure
//     33099305021  event=schedule          2026-08-27T17:36:55Z
//     33027673750  event=workflow_dispatch 2026-08-27T00:41:19Z
//     33003729513  event=workflow_dispatch 2026-08-26T19:10:23Z
//
//   issue #70 comments:
//     2026-08-27T17:37:04Z  "Re-measured 2026-08-27 17:37 UTC: still unreachable."
//
// So the cron DOES fire (card AC-3 satisfied by run 33099305021), and a run
// with divergence present DOES leave a dated comment. And `conclusion=failure`
// is not a fault at all — the workflow's last step is literally named "Fail the
// run if the alarm is up", so a red run is the alarm WORKING. Reading the
// conclusion field alone inverts the meaning of every run in the list.
//
// ── THE REAL BLIND SPOT IS THE ALL-CLEAR PATH, AND IT IS THE STEADY STATE ───
// Trace the three reachable paths of divergence-alarm.yml:
//
//   divergence present            -> edit issue + "Re-measured <ts>" comment  (VISIBLE)
//   divergence cleared, issue open-> close issue + "Cleared <ts>" comment     (VISIBLE, once)
//   divergence cleared, no issue  -> prints "nothing to close", exits 0       (NOTHING)
//
// The third row writes no artifact anywhere a human looks. It is also the state
// the repo enters the moment somebody fixes the divergence — i.e. exactly when
// everyone stops watching. From the issue page, a healthy silent alarm and a
// dead one are the same picture. That is this repo's own recurring shape, and
// it is why the stamp below runs on EVERY path rather than on the two that
// already speak for themselves.
//
// This module holds the decisions so they are unit-testable; the workflow only
// moves strings. Same split as check-branch-divergence.js / branch-divergence.test.js.

/**
 * THE ONE MEASURED NUMBER. GitHub's worst queue delay this repo has actually
 * produced. Every bound below is derived from it, so raising it moves both
 * edges of the band together and the guards in the test file react on their own.
 *
 *   2026-08-27  run 33099305021  window 06:17Z  started 17:36:55Z  11h19m
 *   2026-08-28  run 33200295786  window 06:17Z  started 18:39:36Z  12h22m  <- max
 *   2026-08-29  run 33253070892  window 06:17Z  started 12:39:53Z   6h22m
 *
 * ⚠️ RAISED FROM 11h19m TO 12h22m, 2026-08-30. The 12h22m run was measured
 * while writing card FC3k6ISc and the number was written into a COMMENT twelve
 * lines below while this constant — the one thing everything derives from —
 * still read 11h19m. Caught in review by ref-opus.
 *
 * 🔑 A NUMBER IN A COMMENT AND A NUMBER IN A CONSTANT ARE NOT THE SAME
 * ARTEFACT, AND ONLY ONE OF THEM IS WIRED. Documenting a measurement can feel
 * like applying it. If you measure a worse delay, change THIS LINE first.
 */
const MEASURED_WORST_LEGITIMATE_DELAY_HOURS = 12 + 22 / 60;

/** Worst gap two consecutive legitimate runs can show: 24h + the worst delay on the LATER one. */
const MEASURED_WORST_LEGITIMATE_GAP_HOURS = 24 + MEASURED_WORST_LEGITIMATE_DELAY_HOURS;

/**
 * SMALLEST gap a genuinely skipped window can show — the ceiling of the band.
 *
 * DERIVED, never a literal. As the bare `48` it was the gap for a skip whose
 * PRECEDING run was on time, i.e. the largest true skip rather than the
 * smallest, and feeding that to the guards below made both of them pass over
 * an out-of-band threshold. `48 − d_max` is the real ceiling.
 */
const TRUE_SKIP_GAP_HOURS = 48 - MEASURED_WORST_LEGITIMATE_DELAY_HOURS;

/**
 * The liveness stamp. The EVENT NAME IS MANDATORY and is why this is not just a
 * timestamp: the two comments already on issue #70 are byte-identical in form,
 * one written by a schedule and one by a dispatch, so a reader cannot tell
 * whether the cron has ever worked. A dispatch proves a human pressed a button;
 * only `schedule` proves the clock is alive.
 */
function heartbeatLine({ ts, event, verdict }) {
  if (typeof ts !== 'string' || !ts.trim()) throw new Error('heartbeatLine: ts is required');
  if (typeof event !== 'string' || !event.trim()) {
    // Fail closed. An empty event silently degrades the stamp back into the
    // ambiguous form this card exists to remove, and it would still LOOK like a
    // working heartbeat.
    throw new Error('heartbeatLine: event is required (schedule | workflow_dispatch | …)');
  }
  if (verdict !== 'diverged' && verdict !== 'clear') {
    throw new Error(`heartbeatLine: verdict must be "diverged" or "clear", got ${JSON.stringify(verdict)}`);
  }
  return `last run: ${ts} · trigger: ${event} · verdict: ${verdict}`;
}

/*
 * ── THE REPLACEMENT METHOD: COUNT WINDOWS, DO NOT MEASURE GAPS ──────────────
 * Card FC3k6ISc; the gap method RETIRED by OynwcCbs. `classifyRunGap` was kept
 * here — a working detector is not deleted to install an unproven one — until
 * the replacement earned it. It has: a synthetic SKIPPED window makes
 * `classifyWindowCoverage` report MISSED_WINDOW (deficit-1) while an all-served
 * span reports FRESH, so the detector is known to DISCRIMINATE and not merely
 * known to say FRESH. It is now DELETED rather than left printing a second
 * verdict beside the live one.
 *
 * The measurements that closed its band are kept, because they are WHY the
 * remedy was deletion rather than a better constant. Both measured 2026-08-30:
 *
 * ❌ "GitHub supplies created_at ≈ the scheduled window." IT DOES NOT.
 *    All 7 runs of this workflow have created_at === run_started_at, INCLUDING
 *    the 11h19m-late one (33099305021: both 2026-08-27T17:36:55Z). GitHub
 *    stamps no scheduled instant anywhere on the run object, so runs cannot be
 *    matched to windows by any field. The obvious redesign is unbuildable.
 *
 * 🔴 "41 minutes of margin, not urgent." THE BAND HAD ALREADY CLOSED.
 *    Measured delay per schedule run, cron verified `17 6 * * *` across all
 *    four commits that touched the workflow:
 *        33099305021  window 08-27 06:17Z  start 17:36:55Z  11h19m
 *        33200295786  window 08-28 06:17Z  start 18:39:36Z  12h22m   <-- d_max
 *        33253070892  window 08-29 06:17Z  start 12:39:53Z   6h22m
 *    d_max = 12h22m, past the 12h at which the comment above says the two
 *    populations MEET. worst legitimate 36h22m vs smallest true skip 35h38m —
 *    they have CROSSED, band width −45m, and MISSED_WINDOW_HOURS = 36 now sits
 *    inside the OVERLAP where it can be wrong in both directions at once.
 *
 * WHAT COUNTING FIXES, STATED PRECISELY RATHER THAN OVERSOLD
 * Delay changes WHEN a run appears, never HOW MANY appear. Over a span a daily
 * cron owes one run per window, so a deficit is a skip regardless of delay.
 *
 * ⚠️ d_max does NOT "drop out" — an earlier draft of this said so and it was
 * too strong. It stops bounding the DISCRIMINATION and starts bounding only
 * HOW RECENT a window can be judged: a window younger than the grace may still
 * be legitimately pending. Growing delays therefore shorten the evaluable
 * horizon; they can never collapse a distinction. That is a strictly weaker
 * dependency with no failure point, which is the actual win.
 */

/**
 * Grace before a window is judged. TWO-SIDED, and the upper bound was invisible
 * until ref-opus named it in review:
 *
 *     d_max  <  grace  <  CRON PERIOD
 *
 * LOWER: below d_max a legitimately-late run reads as a miss.
 * UPPER: at or above one cron period the run owed to the window AFTER the span
 *        lands inside the counted run range, inflating the count and hiding a
 *        real skip. Today this holds only because parseDailyCron admits daily
 *        crons and this value happens to be 14h — two constants interacting
 *        with nothing asserting the relation. `assertGraceIsSane` asserts it.
 */
const WINDOW_PENDING_GRACE_HOURS = Math.ceil(MEASURED_WORST_LEGITIMATE_DELAY_HOURS) + 2;

/** The only cron shape parseDailyCron admits; the upper bound on grace. */
const CRON_PERIOD_HOURS = 24;

/** Returns null when sane, else the reason. Exported so a test can assert it. */
function graceViolation(graceHours = WINDOW_PENDING_GRACE_HOURS) {
  if (!(graceHours > MEASURED_WORST_LEGITIMATE_DELAY_HOURS)) {
    return `grace ${graceHours}h must EXCEED the worst measured delay ${MEASURED_WORST_LEGITIMATE_DELAY_HOURS}h, or a late run reads as a miss`;
  }
  if (!(graceHours < CRON_PERIOD_HOURS)) {
    return `grace ${graceHours}h must be BELOW the cron period ${CRON_PERIOD_HOURS}h, or the next window's run is counted inside this span and hides a skip`;
  }
  return null;
}

/**
 * Parse the daily-cron shapes this repo actually uses: `M H * * *`.
 * Anything else returns null and the caller fails closed — a detector that
 * guesses at a cron it does not understand is worse than one that abstains.
 */
function parseDailyCron(expr) {
  if (typeof expr !== 'string') return null;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h, dom, mon, dow] = f;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(h)) return null;
  const minute = Number(m), hour = Number(h);
  if (minute > 59 || hour > 23) return null;
  return { minute, hour };
}

/**
 * Read the cron out of the workflow's own YAML (AC-2), so the detector cannot
 * silently desynchronise from the thing it watches. Deliberately a narrow
 * regex over the real file rather than a YAML dependency: the failure mode we
 * care about is the schedule CHANGING, and a null here fails closed.
 */
function cronFromWorkflow(yamlText) {
  if (typeof yamlText !== 'string') return null;
  const m = yamlText.match(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/m);
  return m ? m[1] : null;
}

/** Expected window instants (ms) in [fromMs, toMs], for a daily cron. */
function expectedWindows({ minute, hour }, fromMs, toMs) {
  const out = [];
  const d = new Date(fromMs);
  d.setUTCHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t < fromMs) t += 86_400_000;
  for (; t <= toMs; t += 86_400_000) out.push(t);
  return out;
}

/**
 * Did any scheduled window go unserved?
 *
 * Counts windows against schedule runs over the SAME closed span, ending at
 * `now − grace` on both sides. With grace > the worst observed delay, a run
 * owed to a counted window cannot start after the span ends, so the two counts
 * are comparable without attributing any individual run to any window — which
 * is exactly the attribution GitHub gives us no field to do.
 */
function classifyWindowCoverage({
  cronExpr,
  scheduleRunISOs,
  nowISO,
  horizonDays = 7,
  graceHours = WINDOW_PENDING_GRACE_HOURS,
}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) throw new Error(`classifyWindowCoverage: unparseable nowISO ${JSON.stringify(nowISO)}`);

  const cron = parseDailyCron(cronExpr);
  // FAIL CLOSED, twice over: an unreadable schedule and an unreadable run list
  // both mean "cannot answer", and neither may return FRESH.
  if (!cron) return { status: 'UNKNOWN', reason: 'unsupported-or-missing-cron', windows: null, runs: null };
  if (!Array.isArray(scheduleRunISOs)) return { status: 'UNKNOWN', reason: 'no-run-list', windows: null, runs: null };

  const starts = scheduleRunISOs.map(Date.parse);
  if (starts.some((t) => !Number.isFinite(t))) {
    return { status: 'UNKNOWN', reason: 'unparseable-run-timestamp', windows: null, runs: null };
  }
  if (starts.length === 0) return { status: 'FIRST_RUN', reason: 'no-schedule-runs-yet', windows: 0, runs: 0 };

  // ⚠️ THE SPAN IS ALIGNED TO WINDOW INSTANTS, not to clock time. Found in
  // review by ref-opus; the first version counted windows by their SCHEDULED
  // instant and runs by their START instant over the SAME clock interval, and
  // those differ by the queue delay d, so BOTH edges leaked, opposite ways:
  //
  //   leading:  window W < spanStart, run starts W+d >= spanStart
  //             -> run counted, window not -> runs INFLATED -> FALSE FRESH
  //   trailing: window W <= spanEnd, run starts W+d > spanEnd
  //             -> window counted, run not -> deficit -> FALSE MISSED
  //
  // They cancel only when d is CONSTANT — and delay variance is the entire
  // reason the gap method was abandoned. So the fix is not a bigger margin: it
  // is to make the two populations answer the same question.
  //
  //   windows counted in [W0, W_last]
  //   runs    counted in [W0, W_last + grace)
  //
  // W0-24h's run starts at W0-24h+d and is excluded because d < grace.
  // W_last+24h's run is excluded because grace < CRON PERIOD — the upper bound
  // graceViolation() asserts. Every in-span window's run is included.
  const graceMs = graceHours * 3_600_000;
  const bad = graceViolation(graceHours);
  if (bad) return { status: 'UNKNOWN', reason: `grace-out-of-bounds: ${bad}`, windows: null, runs: null };

  const spanEndClock = now - graceMs;
  // Windows before the workflow's first observed run were never owed. Without
  // this a freshly-added workflow reads as having missed every window in the
  // horizon — red on day one, which is the guard that gets deleted.
  const lowerBound = Math.max(now - horizonDays * 86_400_000, Math.min(...starts));
  const instants = expectedWindows(cron, lowerBound, spanEndClock);
  if (instants.length === 0) {
    return { status: 'FIRST_RUN', reason: 'no-evaluable-window-yet', windows: 0, runs: 0 };
  }
  const W0 = instants[0];
  const wLast = instants[instants.length - 1];

  const windows = instants.length;
  const runs = starts.filter((t) => t >= W0 && t < wLast + graceMs).length;

  if (runs >= windows) return { status: 'FRESH', reason: 'every-window-served', windows, runs };
  return { status: 'MISSED_WINDOW', reason: `deficit-${windows - runs}`, windows, runs };
}

/** Exit code for the COVERAGE verdict. UNKNOWN is NOT a pass — it means the
 *  detector could not answer, and an unanswerable check must never read green. */
function exitCodeFor(status) {
  if (status === 'FRESH' || status === 'FIRST_RUN') return 0;
  if (status === 'MISSED_WINDOW') return 1;
  if (status === 'UNKNOWN') return 2;
  throw new Error(`exitCodeFor: unknown status ${JSON.stringify(status)}`);
}

module.exports = {
  heartbeatLine,
  classifyWindowCoverage,
  parseDailyCron,
  cronFromWorkflow,
  expectedWindows,
  WINDOW_PENDING_GRACE_HOURS,
  CRON_PERIOD_HOURS,
  graceViolation,
  exitCodeFor,
  MEASURED_WORST_LEGITIMATE_DELAY_HOURS,
  MEASURED_WORST_LEGITIMATE_GAP_HOURS,
  TRUE_SKIP_GAP_HOURS,
};
