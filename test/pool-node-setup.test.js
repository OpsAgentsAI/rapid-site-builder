'use strict';
/**
 * CLASS GUARD — card 65pcQtze, third slice of the 2026-09-22 QA-FAIL handout.
 *
 * The finding was one file: `prod-serving-alarm.yml` shipped onto the self-hosted
 * pool without `actions/setup-node`, so it died at `node: command not found`
 * (exit 127) on both runs it has ever had and measured nothing. The class is
 * bigger than the file — this suite is what stops the next one.
 *
 * ⚠️ WHAT MAKES 127 WORTH ITS OWN GUARD. A workflow that reds because its script
 * measured something bad and a workflow that reds because its interpreter is
 * missing are the SAME RED in the Actions tab. `check-prod-serving.js` exits
 * 1 = STALE, 2 = UNKNOWN, both deliberate; 127 means the program never started.
 * The alarm this card is about exists precisely because a red that says nothing
 * is a red nobody re-reads.
 *
 * ⚠️ THE ALLOWLIST BELOW IS DEBT, NOT AN EXEMPTION, AND IT CAN ONLY SHRINK.
 * It is empty: the four deploy-workflow ref guards it once pinned were fixed
 * by card XzS42jof. Three separate assertions keep the pin honest: a NEW unguarded job
 * fails, an allowlisted job that got FIXED fails (remove the entry), and an
 * allowlisted job that no longer EXISTS fails. An allowlist that cannot rot is
 * the only kind worth having.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  auditRepo, auditJob, jobsOf, loadWorkflow, nodeRunSteps, runsOnPool, key,
} = require('../lib/poolNodeRuntime');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * file:job -> why it is still unguarded. Empty since card XzS42jof put
 * setup-node in the four deploy-workflow ref guards. Nothing may be added
 * without a card that owns its discharge.
 */
const KNOWN_UNGUARDED = {};

/** Write a throwaway repo skeleton holding exactly these workflow files. */
const fixtureRepo = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-node-'));
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return root;
};

const poolJob = (steps) => `name: fixture\non:\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: [self-hosted, linux, x64, gcp]\n    steps:\n${steps}\n`;

// ── The live tree ───────────────────────────────────────────────────────────

test('the census is not vacuous — it finds node-running jobs, and some are compliant', () => {
  const rows = auditRepo(REPO_ROOT);
  assert.ok(rows.length >= 8, `census collapsed to ${rows.length} rows — the matcher stopped matching`);
  assert.ok(rows.some((r) => r.guarded), 'no compliant job found at all: the setup-node matcher is broken');
  assert.ok(rows.every((r) => r.pool), 'a non-pool job appeared; update this assertion rather than the rule');
});

test('every pool job that runs node sets node up first — except pinned, carded debt', () => {
  const unguarded = auditRepo(REPO_ROOT).filter((r) => !r.guarded).map(key);
  const unexpected = unguarded.filter((k) => !(k in KNOWN_UNGUARDED));
  assert.deepStrictEqual(
    unexpected, [],
    `NEW pool job(s) run node with no actions/setup-node before the first call:\n` +
    unexpected.map((k) => `  - ${k}`).join('\n') +
    `\nThe pool image has no node on PATH; these will exit 127 before the script runs.`,
  );
});

test('the allowlist can only shrink — a fixed job must be removed from it', () => {
  const rows = auditRepo(REPO_ROOT);
  const stillUnguarded = new Set(rows.filter((r) => !r.guarded).map(key));
  const nowFixed = Object.keys(KNOWN_UNGUARDED).filter((k) => !stillUnguarded.has(k));
  const present = new Set(rows.map(key));
  const gone = nowFixed.filter((k) => present.has(k));
  const vanished = nowFixed.filter((k) => !present.has(k));
  assert.deepStrictEqual(gone, [], `allowlisted job(s) are now compliant — delete these entries:\n${gone.join('\n')}`);
  assert.deepStrictEqual(vanished, [], `allowlisted job(s) no longer exist — delete these entries:\n${vanished.join('\n')}`);
});

test("this card's own fix is pinned by name, not merely by the aggregate", () => {
  const row = auditRepo(REPO_ROOT).find((r) => key(r) === 'prod-serving-alarm.yml:check');
  assert.ok(row, 'prod-serving-alarm.yml:check vanished from the census');
  assert.strictEqual(row.setupNodeBeforeFirstUse, true, 'the gap-B alarm lost its setup-node step');
});

test('the four deploy ref guards (card XzS42jof) set node up before their first node call', () => {
  const rows = auditRepo(REPO_ROOT);
  for (const k of ['deploy-realapp.yml:deploy', 'deploy-engine.yml:deploy-engine', 'deploy.yml:ref-guard', 'preview.yml:ref-guard']) {
    const row = rows.find((r) => key(r) === k);
    assert.ok(row, `${k} vanished from the census`);
    assert.strictEqual(row.setupNodeBeforeFirstUse, true, `${k} runs node before setup-node — its first dispatch exits 127`);
  }
});

// ── The matcher, on synthetic fixtures with controls ────────────────────────

test('ORDER is part of the rule: setup-node AFTER the node call does not count', () => {
  const after = fixtureRepo({ 'a.yml': poolJob(
    `      - name: measure\n        run: node scripts/x.js\n\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20`) });
  const before = fixtureRepo({ 'a.yml': poolJob(
    `      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n\n      - name: measure\n        run: node scripts/x.js`) });
  // CONTROL: the two fixtures differ ONLY in step order.
  assert.strictEqual(auditRepo(after)[0].setupNodeCount, 1, 'fixture lost its setup-node step');
  assert.strictEqual(auditRepo(after)[0].guarded, false, 'a trailing setup-node was accepted — PATH is only mutated for LATER steps');
  assert.strictEqual(auditRepo(before)[0].guarded, true, 'the control (correct order) did not pass — the matcher is broken, not the fixture');
});

test('`node-version:` and `node_modules` do NOT count as running node', () => {
  const root = fixtureRepo({ 'a.yml': poolJob(
    `      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n\n      - name: prune\n        run: rm -rf node_modules`) });
  assert.deepStrictEqual(auditRepo(root), [], 'a bare `node` substring was read as a node invocation');
});

test('command position is what counts — assignments and substitutions included', () => {
  const cases = {
    'plain.yml': 'node scripts/x.js',
    'subst.yml': 'EXPECTED=$(node -p "require(\'./lib/p\').R")',
    'inlineenv.yml': 'RC="$rc" node -e \'process.exit(0)\'',
    'chained.yml': 'git fetch origin && npm ci',
    'npx.yml': 'npx --yes some-tool',
  };
  for (const [file, cmd] of Object.entries(cases)) {
    const root = fixtureRepo({ [file]: poolJob(`      - name: s\n        run: |\n          ${cmd}`) });
    assert.strictEqual(auditRepo(root).length, 1, `${file}: "${cmd}" was not seen as a node invocation`);
    assert.strictEqual(auditRepo(root)[0].guarded, false, `${file}: missing setup-node was not flagged`);
  }
  // CONTROL: a command that merely MENTIONS node in an argument is not a call.
  const arg = fixtureRepo({ 'arg.yml': poolJob(`      - name: s\n        run: |\n          echo "install node first"`) });
  assert.deepStrictEqual(auditRepo(arg), [], 'a node mention inside an argument was read as an invocation');
});

test('the rule is scoped to the pool — a GitHub-hosted job needs no setup-node', () => {
  const hosted = 'name: f\non:\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: s\n        run: node scripts/x.js\n';
  const root = fixtureRepo({ 'a.yml': hosted });
  const rows = auditRepo(root);
  assert.strictEqual(rows.length, 1, 'the hosted job vanished from the census');
  assert.strictEqual(rows[0].pool, false, 'ubuntu-latest was classified as the pool');
  assert.strictEqual(rows[0].guarded, true, 'a hosted job was required to carry setup-node');
});

test('the live-tree parser sees real jobs, not an empty set (fail-loud, not vacuous)', () => {
  const code = loadWorkflow(REPO_ROOT, 'prod-serving-alarm.yml');
  const jobs = jobsOf(code);
  assert.strictEqual(jobs.length, 1, `expected 1 job in prod-serving-alarm.yml, got ${jobs.length}`);
  assert.strictEqual(runsOnPool(jobs[0]), true, 'the gap-B alarm is no longer on the pool');
  assert.strictEqual(nodeRunSteps(jobs[0]).length, 1, 'the measure step no longer reads as a node invocation');
  assert.ok(auditJob('prod-serving-alarm.yml', jobs[0]).guarded);
});
