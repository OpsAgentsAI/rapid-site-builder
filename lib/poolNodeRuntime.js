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
 * WHICH RUNNER does this job land on? One of:
 *   'pool'    — a `self-hosted` label, in any form GitHub accepts: scalar
 *               (`runs-on: self-hosted`), flow list (`[self-hosted, linux, x64, gcp]`),
 *               block list (`- self-hosted` lines) or the runner-group object's
 *               `labels: [...]`.
 *   'group'   — a runner-group object (`group: …`) with NO `self-hosted` label.
 *               A group is an org/enterprise runner group; this repo's pool is one,
 *               and the value alone cannot say which image the group serves.
 *   'unknown' — the value is (or contains) an expression, `${{ … }}`: the label
 *               is decided at RUN time (`${{ inputs.runner }}`, a matrix), so no
 *               static reading of the file can call it hosted.
 *   'hosted'  — anything else (`ubuntu-latest`, …), and a job with no `runs-on`.
 * Only the `runs-on:` VALUE is read: a trailing comment or a step body that
 * mentions `self-hosted` (or `${{`) never changes the class.
 */
const runnerClass = (job) => {
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
    if (/(?:^|[\s[,'"])self-hosted(?=$|[\s\],'"])/m.test(value)) return 'pool';
    if (/\$\{\{/.test(value)) return 'unknown';
    if (/^\s*(?:-[ \t]+)?group:/m.test(value) || /[{,][ \t]*group:/.test(value)) return 'group';
    return 'hosted';
  }
  return 'hosted';
};

/**
 * Is this job (possibly) on the self-hosted GCP pool (the image with no node)?
 * FAIL-CLOSED (card QRm63h1O): only a runner we can READ as hosted is hosted. An
 * expression `runs-on` ('unknown') and a group-only runner ('group') both count
 * as pool, because scoring them hosted is what turns a node-less pool job green.
 * A hosted job wrongly treated as pool only costs one setup-node step; the
 * reverse costs an alarm that exits 127 and measures nothing. Shared with
 * test/pool-job-timeout.test.js, so the two pool guards cannot disagree on
 * which jobs are pool jobs.
 */
const runsOnPool = (job) => runnerClass(job) !== 'hosted';

/**
 * A block-scalar header: `|` or `>`, an optional chomping indicator (`-`/`+`) and
 * an optional indentation indicator (`1`-`9`) in either order — `|2`, `|-2`, `>+1`
 * are all legal YAML — optionally followed by a comment.
 */
const BLOCK_SCALAR_HEADER = /^[|>](?:[1-9][-+]?|[-+][1-9]?)?(?:[ \t]+#.*)?$/;

/**
 * The text a QUOTED flow scalar stands for: `"node x.js"` / `'node x.js'` mean
 * `node x.js`. Double quotes honour the escapes a shell line can carry (`\n`,
 * `\t`, `\"`, `\\`); single quotes only `''`. Anything else is returned as-is.
 */
const unquoteScalar = (raw) => {
  const t = raw.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/.exec(t);
  if (dq) {
    return dq[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
  }
  const sq = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(t);
  if (sq) return sq[1].replace(/''/g, "'");
  return raw;
};

/** `key: value` — the first body line of a `run:` that is a MAPPING (`defaults: run: shell:`), not a script. */
const RUN_DEFAULTS_KEY = /^\s*(?:shell|working-directory):/;

/**
 * Every `run:` step body in a job, with the LINE OFFSET of its `run:` key, so a
 * caller can compare positions against `uses:` steps, and `end` (exclusive), the
 * first line after the step body. Handles the plain scalar form
 * (`run: node foo.js`), the QUOTED scalar form (`run: "node foo.js"`, which may
 * continue over more-indented lines until its closing quote) and the block form
 * (`run: |` / `run: >-` / `run: |2` + an indented body). A job-level
 * `defaults: run:` mapping is not a step and is skipped.
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
    if (body === '' || BLOCK_SCALAR_HEADER.test(body.trim())) {
      const block = body !== '';
      body = '';
      for (let k = i + 1; k < lines.length; k++, end = k) {
        if (lines[k].trim() === '') { body += '\n'; continue; }
        if (lines[k].length - lines[k].trimStart().length <= indent) break;
        body += lines[k] + '\n';
      }
      if (!block && RUN_DEFAULTS_KEY.test(body.split('\n').find((l) => l.trim() !== '') || '')) continue;
    } else if (/^["']/.test(body)) {
      // A quoted scalar may fold over the following, more-indented lines.
      const q = body[0];
      const closed = (s) => (q === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/).test(s);
      for (let k = i + 1; !closed(body) && k < lines.length; k++) {
        if (lines[k].trim() !== '' && lines[k].length - lines[k].trimStart().length <= indent) break;
        body += lines[k].trim() === '' ? '\n' : ' ' + lines[k].trim();
        end = k + 1;
      }
      body = unquoteScalar(body);
    }
    out.push({ line: i, end, body });
  }
  return out;
};

/**
 * A program that needs node, in COMMAND POSITION — start of the body, or after a
 * separator (`;`, `&&`, `||`, `|`, newline, a subshell paren, a backtick, a brace
 * group's `{ `), optionally behind inline `VAR=value` assignments
 * (`RC="$rc" node -e ...`), behind a command substitution opener
 * (`EXPECTED=$(node -p ...)`), behind a shell keyword or wrapper that still RUNS
 * the next word (`if`, `then`, `do`, `exec`, `time`, `xargs`, `env`, …), behind
 * `timeout [opts] DURATION` and behind `bash -c "` / `sh -c '`.
 *
 * The programs: `node`, `npm`, `npx`, `yarn`, `pnpm` (both package managers are
 * node programs), and a `.js` / `.mjs` / `.cjs` SCRIPT run by path
 * (`./scripts/x.js`) — its `#!/usr/bin/env node` shebang needs node on PATH.
 *
 * Deliberately NOT a bare /\bnode\b/: `node-version: 20`, `node_modules/` and the
 * word "node" in a step name all match that, and a matcher that fires on its own
 * fix is a matcher that can never go green.
 */
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+`;
const RUNS_NEXT_WORD = String.raw`(?:if|then|else|elif|do|while|until|exec|time|command|nohup|xargs|sudo|env|!)(?:[ \t]+-[A-Za-z0-9-]+)*[ \t]+`;
// `timeout [-s SIG|-k DUR|--opt[=v]]... DURATION cmd` — the duration is a number with an optional unit.
const TIMEOUT = String.raw`timeout(?:[ \t]+-[sk][ \t]+\S+|[ \t]+-[A-Za-z-]+(?:=\S+)?)*[ \t]+[0-9.]+[smhd]?[ \t]+`;
const SHELL_DASH_C = String.raw`(?:ba|da|z)?sh[ \t]+-c[ \t]+["']?`;
const PATH_WORD = String.raw`[^\s;&|()<>'"\x60{}$]`;
const JS_SCRIPT_BY_PATH = String.raw`${PATH_WORD}*/${PATH_WORD}*\.[cm]?js`;
const NODE_IN_COMMAND_POSITION = new RegExp(
  String.raw`(?:^|[\n;&|(\x60]|&&|\|\||\$\(|(?<!\$)\{(?=[ \t]))[ \t]*` +
  `(?:${ASSIGNMENT}|${RUNS_NEXT_WORD}|${TIMEOUT}|${SHELL_DASH_C})*` +
  String.raw`(node|npm|npx|yarn|pnpm|${JS_SCRIPT_BY_PATH})(?=[ \t]|$)`,
  'm',
);

/** The value of a `shell:` key invokes node — `shell: node {0}` runs the step body WITH node. */
const SHELL_IS_NODE = /^\s*(?:- )?shell:[ \t]*['"]?(?:node|npm|npx|yarn|pnpm)(?=[ \t'"]|$)/;

/** Index of the nearest preceding line LESS indented than line `i` (its YAML parent), or -1. */
const parentLine = (lines, i) => {
  const ind = (l) => l.length - l.trimStart().length;
  for (let k = i - 1; k >= 0; k--) {
    if (lines[k].trim() !== '' && ind(lines[k]) < ind(lines[i])) return k;
  }
  return -1;
};

/** Is `shell: node …` declared as the WORKFLOW-level default (`defaults: run: shell:`)? */
const workflowDefaultShellIsNode = (code) =>
  /^defaults:[ \t]*(?:#.*)?\n(?:[ \t]*\n| {2,}.*\n)*? {2}run:[ \t]*(?:#.*)?\n(?:[ \t]*\n| {4,}.*\n)*? {4}shell:[ \t]*['"]?(?:node|npm|npx|yarn|pnpm)(?=[ \t'"]|$)/m
    .test(code.endsWith('\n') ? code : code + '\n');

/**
 * Every place in a job where node is invoked, as `{ line }` (sorted): each
 * `run:` step whose body runs a node program, each step whose `shell:` is node
 * (`shell: node {0}`), and — when the job's `defaults: run: shell:` (or, via
 * `opts.defaultShellIsNode`, the workflow's) is node — every `run:` step.
 */
const nodeRunSteps = (job, opts = {}) => {
  const lines = job.text.split('\n');
  const runs = runSteps(job);
  const inRunBody = (i) => runs.some((s) => i > s.line && i < s.end);
  let everyRunIsNode = Boolean(opts.defaultShellIsNode);
  const shellSteps = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SHELL_IS_NODE.test(lines[i]) || inRunBody(i)) continue;
    const p = parentLine(lines, i);
    if (p >= 0 && /^\s*run:[ \t]*(?:#.*)?$/.test(lines[p])) everyRunIsNode = true; // job `defaults: run: shell:`
    else shellSteps.push({ line: i, end: i + 1, body: lines[i] });
  }
  const hits = everyRunIsNode ? runs.slice() : runs.filter((s) => NODE_IN_COMMAND_POSITION.test(s.body));
  // Each entry is an invocation SITE: a step whose body runs node AND whose shell is node counts twice.
  return hits.concat(shellSteps).sort((a, b) => a.line - b.line);
};

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
const auditJob = (file, job, opts = {}) => {
  const nodeSteps = nodeRunSteps(job, opts);
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
    const opts = { defaultShellIsNode: workflowDefaultShellIsNode(code) };
    for (const job of jobsOf(code)) {
      const row = auditJob(file, job, opts);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => (a.file + a.job).localeCompare(b.file + b.job));
};

const key = (row) => `${row.file}:${row.job}`;

module.exports = {
  workflowFiles, loadWorkflow, jobsOf, runsOnPool, runnerClass,
  runSteps, nodeRunSteps, setupNodeLines, auditJob, auditRepo, key,
  NODE_IN_COMMAND_POSITION, workflowDefaultShellIsNode,
};
