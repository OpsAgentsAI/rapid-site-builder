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
const fs = require('node:fs');
const path = require('node:path');

/** Full-line comments only. Prose must never satisfy — or defeat — a matcher. */
const stripComments = (raw) =>
  raw.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const workflowFiles = (repoRoot) => {
  const dir = path.join(repoRoot, '.github', 'workflows');
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
};

const loadWorkflow = (repoRoot, file) =>
  stripComments(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8'));

/** Top-level jobs as `{ name, text }`, each running to the next job head. */
const jobsOf = (code) => {
  const m = /^jobs:[ \t]*$/m.exec(code);
  if (!m) return [];
  const body = code.slice(m.index + m[0].length + 1);
  const re = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm;
  const heads = [];
  let h;
  while ((h = re.exec(body))) heads.push({ name: h[1], idx: h.index });
  return heads.map((x, i) => ({
    name: x.name,
    text: body.slice(x.idx, i + 1 < heads.length ? heads[i + 1].idx : undefined),
  }));
};

/** Is this job pinned to the self-hosted GCP pool (the image with no node)? */
const runsOnPool = (job) => /^\s*runs-on:\s*\[[^\]]*self-hosted/m.test(job.text);

/**
 * Every `run:` step body in a job, with the LINE OFFSET of its `run:` key, so a
 * caller can compare positions against `uses:` steps. Handles both the scalar
 * form (`run: node foo.js`) and the block form (`run: |` + an indented body).
 */
const runSteps = (job) => {
  const lines = job.text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    let body = m[2];
    if (body === '' || /^[|>][-+]?$/.test(body.trim())) {
      body = '';
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') { body += '\n'; continue; }
        if (lines[k].length - lines[k].trimStart().length <= indent) break;
        body += lines[k] + '\n';
      }
    }
    out.push({ line: i, body });
  }
  return out;
};

/**
 * `node` / `npm` / `npx` in COMMAND POSITION — start of the body, or after a
 * separator (`;`, `&&`, `||`, `|`, newline, a subshell paren), optionally behind
 * inline `VAR=value` assignments (`RC="$rc" node -e ...`) and behind a command
 * substitution opener (`EXPECTED=$(node -p ...)`).
 *
 * Deliberately NOT a bare /\bnode\b/: `node-version: 20`, `node_modules/` and the
 * word "node" in a step name all match that, and a matcher that fires on its own
 * fix is a matcher that can never go green.
 */
const NODE_IN_COMMAND_POSITION =
  /(?:^|[\n;&|(]|&&|\|\||\$\()[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)*(node|npm|npx)(?=[ \t]|$)/m;

const nodeRunSteps = (job) => runSteps(job).filter((s) => NODE_IN_COMMAND_POSITION.test(s.body));

/** Line offsets of every `actions/setup-node@…` step in the job. */
const setupNodeLines = (job) => {
  const lines = job.text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/uses:\s*actions\/setup-node@/.test(lines[i])) out.push(i);
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
  stripComments, workflowFiles, loadWorkflow, jobsOf, runsOnPool,
  runSteps, nodeRunSteps, setupNodeLines, auditJob, auditRepo, key,
  NODE_IN_COMMAND_POSITION,
};
