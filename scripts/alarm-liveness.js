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

// The threshold must sit STRICTLY BETWEEN the worst legitimate gap and the
// SMALLEST real skip. Card oPbduwRM. Both bounds move with the same measured
// quantity, so exactly one number below is measured and the rest are derived.
//
// A daily cron does NOT produce 24h gaps. Each run starts `delay` after its
// scheduled window, so a gap between two run STARTS carries two delays:
//
//     no skip    gap = 24h + d₂ − d₁
//     one skip   gap = 48h + d₂ − d₁
//
// 🔑 THE SIGN, because the first version of this file got it backwards and the
// error shipped: a delay on the run AFTER (d₂) INCREASES the gap; a delay on the
// run BEFORE (d₁) DECREASES it. So the two populations are bounded by:
//
//     worst LEGITIMATE gap   = 24h + d_max − 0      = 35h19m
//     smallest TRUE SKIP     = 48h + 0     − d_max  = 36h41m
//
// A true skip is therefore NOT ~48h. 48h is a true skip whose preceding run was
// ON TIME — the easiest one to catch, and the only one the old ceiling described.
//
//     usable band = 35h19m ‥ 36h41m      ← 1h22m wide
//       36h inside? YES, and it is the MIDPOINT (±41 min)
//       40h inside? NO — above the ceiling, so a real skip reads FRESH
//
// ⚠️ THE ±41 MINUTES IS INHERENT AT THIS DELAY VARIANCE — IT IS NOT A TUNING
// ERROR AND MUST NOT BE "FIXED" BY MOVING THIS NUMBER. It is exactly half the
// band width; no constant does better. PR #75 read that 41 minutes as slack to
// be widened, raised this to 40h, and turned a hard-to-reach false RED into an
// easy-to-reach false GREEN: any real skip whose preceding run was >8h late read
// FRESH, on a repo that has already produced an 11h19m delay. A false green
// defeats the parent card (oWtnNDT5), which exists to notice a DEAD alarm.
//
// ⚠️ THE BAND NARROWS AS DELAYS GROW, and this constant cannot be re-tuned out
// of that: at d_max = 12h the two populations meet and gap-vs-threshold stops
// discriminating at all. At that point the detector needs the EXPECTED WINDOW
// TIMES rather than the previous run's timestamp. If you find yourself tuning
// this a second time, that is the signal to change the method, not the number.
const MISSED_WINDOW_HOURS = 36;

/**
 * THE ONE MEASURED NUMBER. GitHub's worst queue delay this repo has actually
 * produced: run 33099305021, scheduled 06:17Z, started 2026-08-27T17:36:55Z.
 * Every bound below is derived from it, so raising it moves both edges of the
 * band together and the guards in the test file react on their own.
 */
const MEASURED_WORST_LEGITIMATE_DELAY_HOURS = 11 + 19 / 60;

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

/**
 * Did the alarm miss a window? Answered from its OWN previous run.
 *
 * ⚠️ SCOPE, STATED SO IT IS NOT OVER-READ: this catches an alarm that is
 * SKIPPING — which is the failure mode actually observed here (first window
 * skipped, second delivered 11h19m late). It CANNOT catch an alarm that is
 * completely dead, because a run that never happens runs no check. The card is
 * explicit that a second scheduled workflow must not be used for that (it would
 * share the failure mode), so the dead case is closed by the heartbeat being
 * READABLE, not by this returning red. Said plainly rather than implied.
 */
function classifyRunGap({ previousRunISO, nowISO, thresholdHours = MISSED_WINDOW_HOURS }) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) throw new Error(`classifyRunGap: unparseable nowISO ${JSON.stringify(nowISO)}`);
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error(`classifyRunGap: thresholdHours must be > 0, got ${JSON.stringify(thresholdHours)}`);
  }

  // No previous run is NOT a missed window — it is the first one. Reporting a
  // fresh install as "the alarm is broken" is the cry-wolf direction, and a
  // guard that is red on day one is the guard that gets deleted.
  if (previousRunISO === null || previousRunISO === undefined || previousRunISO === '') {
    return { status: 'FIRST_RUN', gapHours: null };
  }

  const prev = Date.parse(previousRunISO);
  if (!Number.isFinite(prev)) {
    // FAIL CLOSED. Returning FRESH on an unreadable timestamp is precisely the
    // defect this whole card is about, one level up: a check that cannot answer
    // must not answer "healthy".
    return { status: 'UNKNOWN', gapHours: null };
  }

  const gapHours = (now - prev) / 3_600_000;
  if (gapHours > thresholdHours) return { status: 'MISSED_WINDOW', gapHours };
  return { status: 'FRESH', gapHours };
}

/*
 * ── THE REPLACEMENT METHOD: COUNT WINDOWS, DO NOT MEASURE GAPS ──────────────
 * Card FC3k6ISc. `classifyRunGap` above is kept, exported and tested — a
 * working detector is not deleted to install an unproven one — but it has hit
 * the limit its own comment predicted, and two of the assumptions in the card
 * that proposed the replacement were WRONG. Both were measured 2026-08-30,
 * and recording them is the point:
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

/** Grace before a window is judged: it must exceed the worst delay ever seen,
 *  or a legitimately-late run reads as a miss. Derived, not chosen. */
const WINDOW_PENDING_GRACE_HOURS = Math.ceil(MEASURED_WORST_LEGITIMATE_DELAY_HOURS) + 2;

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

  const spanEnd = now - graceHours * 3_600_000;
  // Windows before the workflow's first observed run were never owed. Without
  // this a freshly-added workflow reads as having missed every window in the
  // horizon — red on day one, which is the guard that gets deleted.
  const spanStart = Math.max(now - horizonDays * 86_400_000, Math.min(...starts));
  if (spanEnd <= spanStart) {
    return { status: 'FIRST_RUN', reason: 'horizon-shorter-than-grace', windows: 0, runs: 0 };
  }

  const windows = expectedWindows(cron, spanStart, spanEnd).length;
  const runs = starts.filter((t) => t >= spanStart && t <= spanEnd).length;

  if (runs >= windows) return { status: 'FRESH', reason: 'every-window-served', windows, runs };
  return { status: 'MISSED_WINDOW', reason: `deficit-${windows - runs}`, windows, runs };
}

/** Exit code for the gap verdict. UNKNOWN is NOT a pass — see classifyRunGap. */
function exitCodeFor(status) {
  if (status === 'FRESH' || status === 'FIRST_RUN') return 0;
  if (status === 'MISSED_WINDOW') return 1;
  if (status === 'UNKNOWN') return 2;
  throw new Error(`exitCodeFor: unknown status ${JSON.stringify(status)}`);
}

module.exports = {
  heartbeatLine,
  classifyRunGap,
  classifyWindowCoverage,
  parseDailyCron,
  cronFromWorkflow,
  expectedWindows,
  WINDOW_PENDING_GRACE_HOURS,
  exitCodeFor,
  MISSED_WINDOW_HOURS,
  MEASURED_WORST_LEGITIMATE_DELAY_HOURS,
  MEASURED_WORST_LEGITIMATE_GAP_HOURS,
  TRUE_SKIP_GAP_HOURS,
};
