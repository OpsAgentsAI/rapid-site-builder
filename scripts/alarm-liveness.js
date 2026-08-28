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
// smallest real skip. Card oPbduwRM — 36h did not, and the margin was 41 minutes.
//
// A daily cron does NOT produce 24h gaps. Two legitimate consecutive runs are
// `24h + (delay_2 - delay_1)`, where each delay is GitHub's queue delay for that
// window. This repo has MEASURED an 11h19m delay: run 33099305021, scheduled
// 06:17Z, started 2026-08-27T17:36:55Z. So:
//
//     run N    on time      06:17Z day 1
//     run N+1  11h19m late  17:36Z day 2
//     gap                   35h19m     <- legitimate, and 36h cleared it by 41 min
//
// A delay ~41 minutes worse than one this repo has already produced would have
// made the detector red with no window actually missed. This file's own header
// says noise is how the next alarm gets muted, and a guard that cries wolf about
// ITSELF is the fastest version of that.
//
// Raising it to 48h is the other failure: a genuinely skipped window lands at
// ~48h (24h gap + 24h skipped), so 48 would classify a real skip as FRESH and
// delete the detection this check exists for. The usable band is:
//
//     worst legitimate gap seen   ~35h19m
//       ...usable band...
//     smallest true skip          ~48h  (minus the next run's own delay)
//
// 40h takes ~4h40m of headroom over the measured worst case while staying ~8h
// below a true skip.
//
// ⚠️ THE BAND NARROWS AS DELAYS GROW, and this constant cannot be re-tuned out
// of that. A >12h delay on the run AFTER a skipped window pushes a true skip
// below 48h and the two populations overlap — at which point gap-vs-threshold
// stops discriminating at all, and the detector needs the EXPECTED WINDOW TIMES
// rather than just the previous run's timestamp. If you find yourself tuning
// this a second time, that is the signal to change the method, not the number.
const MISSED_WINDOW_HOURS = 40;

/** The worst legitimate gap this repo has actually produced, in hours. Evidence for the band above. */
const MEASURED_WORST_LEGITIMATE_GAP_HOURS = 35 + 19 / 60;
/** A genuinely skipped daily window: one 24h gap plus the 24h that was skipped. */
const TRUE_SKIP_GAP_HOURS = 48;

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
  exitCodeFor,
  MISSED_WINDOW_HOURS,
  MEASURED_WORST_LEGITIMATE_GAP_HOURS,
  TRUE_SKIP_GAP_HOURS,
};
