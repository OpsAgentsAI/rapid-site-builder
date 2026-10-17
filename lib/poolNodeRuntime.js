'use strict';
/**
 * Does every SELF-HOSTED-POOL job that shells out to `node` set Node up first?
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The pool image has NO node on PATH. `divergence-alarm.yml` already records the
 * probe in a comment — "gha-runner-1: `command -v node` -> MISSING" — and carries
 * an `actions/setup-node@v4` step because of it. Card 65pcQtze shipped
 * `prod-serving-alarm.yml` onto the same pool WITHOUT that step, and the alarm
 * red every run with `node: command not found` (exit 127): runs 35713932198
 * (dispatch, 2026-09-22 10:04Z) and 35725033827 (its own 06:47 cron, fired late
 * at 12:04Z). Both died at the measure step, before the script could produce any
 * verdict at all.
 *
 * ⚠️ 127 IS NOT THE SCRIPT'S RED. `check-prod-serving.js` uses exit 1 = STALE and
 * exit 2 = UNKNOWN, both deliberate. Exit 127 is the runner saying the program
 * never started — which renders in the Actions tab exactly like a measurement
 * that ran and failed. That is this card's own pathology: an alarm whose red
 * says nothing. A per-file fix would have left the CLASS intact, so the class is
 * what is guarded here.
 *
 * ── THE ORDER IS PART OF THE RULE ───────────────────────────────────────────
 * `actions/setup-node` mutates PATH for the steps that FOLLOW it. A setup-node
 * step placed after the `run:` that needs node satisfies "the job has setup-node"
 * and still exits 127. So the check is positional, not a set membership test.
 */
// ONE parser for `.github/workflows/*.yml` in this repo: the vendored one (#92).
// This file used to carry its own copy of strip / workflowFiles / load / jobsOf,
// and the copy drifted — its `jobs:` and job-head regexes rejected a TRAILING
// comment, so `  ref-guard:  # note` silently dropped that job out of this audit
// (ref3-rsb-1819 review of #94 at 35630042). The vendor's header says why a fork
// is the failure mode: it "silently stops learning". Only POOL-specific logic
// lives below; anything about the shape of a workflow file belongs there.
const { workflowFiles, load: loadWorkflow, jobsOf } = require('../test/vendor/workflow-parse.js');

/** Drop a trailing `# comment` from one YAML line (quote-naive; fine for runs-on values). */
const dropTrailingComment = (line) => line.replace(/[ \t]+#.*$/, '');

/**
 * Is this job pinned to the self-hosted GCP pool (the image with no node)?
 * Reads the job's `runs-on:` VALUE in every form GitHub accepts — scalar
 * (`runs-on: self-hosted`), flow list (`[self-hosted, linux, x64, gcp]`), block
 * list (`- self-hosted` lines) and the runner-group object (`labels: [...]`) —
 * and nothing else: a trailing comment or a step body that mentions
 * `self-hosted` must never make a hosted job "pool". Shared with
 * test/pool-job-timeout.test.js, so the two pool guards cannot disagree on
 * which jobs are pool jobs.
 */
const runsOnPool = (job) => {
  const lines = job.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)runs-on:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let value = dropTrailingComment(m[2]);
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k].trim() === '') continue;
      if (lines[k].length - lines[k].trimStart().length <= indent) break;
      if (/^\s*#/.test(lines[k])) continue;
      value += '\n' + dropTrailingComment(lines[k]);
    }
    return /(?:^|[\s[,'"])self-hosted(?=$|[\s\],'"])/m.test(value);
  }
  return false;
};

/**
 * Every `run:` step body in a job, with the LINE OFFSET of its `run:` key, so a
 * caller can compare positions against `uses:` steps, and `end` (exclusive), the
 * first line after the step body. Handles both the scalar form
 * (`run: node foo.js`) and the block form (`run: |` + an indented body).
 */
const runSteps = (job) => {
  const lines = job.text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    let body = m[2];
    let end = i + 1;
    if (body === '' || /^[|>][-+]?$/.test(body.trim())) {
      body = '';
      for (let k = i + 1; k < lines.length; k++, end = k) {
        if (lines[k].trim() === '') { body += '\n'; continue; }
        if (lines[k].length - lines[k].trimStart().length <= indent) break;
        body += lines[k] + '\n';
      }
    }
    out.push({ line: i, end, body });
  }
  return out;
};

/**
 * `node` / `npm` / `npx` in COMMAND POSITION — start of the body, or after a
 * separator (`;`, `&&`, `||`, `|`, newline, a subshell paren, a backtick),
 * optionally behind inline `VAR=value` assignments (`RC="$rc" node -e ...`),
 * behind a command substitution opener (`EXPECTED=$(node -p ...)`), behind a
 * shell keyword or wrapper that still RUNS the next word (`if`, `then`, `do`,
 * `exec`, `time`, `xargs`, `env`, …) and behind `bash -c "` / `sh -c '`.
 *
 * Deliberately NOT a bare /\bnode\b/: `node-version: 20`, `node_modules/` and the
 * word "node" in a step name all match that, and a matcher that fires on its own
 * fix is a matcher that can never go green.
 */
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+`;
const RUNS_NEXT_WORD = String.raw`(?:if|then|else|elif|do|while|until|exec|time|command|nohup|xargs|sudo|env|!)(?:[ \t]+-[A-Za-z0-9-]+)*[ \t]+`;
const SHELL_DASH_C = String.raw`(?:ba|da|z)?sh[ \t]+-c[ \t]+["']?`;
const NODE_IN_COMMAND_POSITION = new RegExp(
  String.raw`(?:^|[\n;&|(\x60]|&&|\|\||\$\()[ \t]*` +
  `(?:${ASSIGNMENT}|${RUNS_NEXT_WORD}|${SHELL_DASH_C})*` +
  String.raw`(node|npm|npx)(?=[ \t]|$)`,
  'm',
);

const nodeRunSteps = (job) => runSteps(job).filter((s) => NODE_IN_COMMAND_POSITION.test(s.body));

/**
 * Line offsets of every `actions/setup-node@…` STEP in the job: a `uses:` key,
 * never the same text inside a `run:` body (an `echo` or a heredoc that mentions
 * setup-node sets nothing up).
 */
const setupNodeLines = (job) => {
  const lines = job.text.split('\n');
  const inRunBody = (i) => runSteps(job).some((s) => i > s.line && i < s.end);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:- )?uses:\s*['"]?actions\/setup-node@/.test(lines[i]) && !inRunBody(i)) out.push(i);
  }
  return out;
};

/**
 * One row per pool job that runs node. `guarded` is true only when a setup-node
 * step appears BEFORE the first such `run:`.
 */
const auditJob = (file, job) => {
  const nodeSteps = nodeRunSteps(job);
  if (!nodeSteps.length) return null;
  const firstNodeLine = nodeSteps[0].line;
  const setups = setupNodeLines(job);
  const before = setups.filter((l) => l < firstNodeLine);
  return {
    file,
    job: job.name,
    pool: runsOnPool(job),
    nodeRunCount: nodeSteps.length,
    setupNodeCount: setups.length,
    setupNodeBeforeFirstUse: before.length > 0,
    guarded: !runsOnPool(job) || before.length > 0,
  };
};

/** The whole repo, one row per job that invokes node. Sorted, so it is diffable. */
const auditRepo = (repoRoot) => {
  const rows = [];
  for (const file of workflowFiles(repoRoot)) {
    const code = loadWorkflow(repoRoot, file);
    for (const job of jobsOf(code)) {
      const row = auditJob(file, job);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => (a.file + a.job).localeCompare(b.file + b.job));
};

const key = (row) => `${row.file}:${row.job}`;

module.exports = {
  workflowFiles, loadWorkflow, jobsOf, runsOnPool,
  runSteps, nodeRunSteps, setupNodeLines, auditJob, auditRepo, key,
  NODE_IN_COMMAND_POSITION,
};
