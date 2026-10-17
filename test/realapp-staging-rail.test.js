'use strict';
// Card mIQXYnxd — a staging rail for the real-app line.
//
// Measured on origin/real-app d13b5ea (static read, 2026-10-17): no CI/CD path
// could stage a real-app commit. deploy.yml puts MAIN bytes on APP-STAGING
// (push:main), preview.yml only takes the main line and proxies to the retired
// surface, deploy-realapp.yml is PROD. .github/workflows/deploy-realapp-staging.yml
// is the rail; this suite pins what makes it safe and useful:
//
//   1. It can never reach PROD: no PROD service/site/domain/config anywhere in
//      the executable lines, every deploy targets the APP-STAGING service.
//   2. Dispatch-only, least-privilege permissions, every action pinned to a SHA.
//   3. The ref guard refuses a commit that is not on real-app (an unmerged
//      card/* tip) and a commit that is merely main — one shared decision.
//   4. Its env set cannot drift from deploy.yml's APP-STAGING job, and it MERGES.
//   5. It proves which commit it staged: BUILD_COMMIT -> /api/health `commit`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DEPLOY_REF_POLICY, refDeployVerdict } = require('../lib/deployRefPolicy');
const { readBuildCommit, BUILD_COMMIT_FILE } = require('../lib/buildInfo');

const REPO = path.join(__dirname, '..');
const FILE = 'deploy-realapp-staging.yml';
const RAW = fs.readFileSync(path.join(REPO, '.github', 'workflows', FILE), 'utf8');
const RAW_STAGING = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy.yml'), 'utf8');

/** Executable lines only: whole-line `#` comments and trailing ` # ...` comments go. */
const code = (raw) =>
  raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
const SRC = code(RAW);

/** One job's block out of a workflow (2-space job keys). */
function jobBlock(src, job) {
  const start = src.indexOf(`\n  ${job}:`);
  assert.ok(start > -1, `job ${job} not found`);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The env KEYS a --update-env-vars "^|^K=V|K=V" argument names. */
function envKeys(block) {
  const m = /--update-env-vars\s+"\^\|\^([^"]+)"/.exec(block);
  assert.ok(m, 'no --update-env-vars "^|^..." argument found');
  return m[1].split('|').map((kv) => kv.split('=')[0]).sort();
}

// ── 1. NEVER PROD ───────────────────────────────────────────────────────────

test('KNOWN-POSITIVE: the PROD names this suite forbids are real (they are in deploy-realapp.yml)', () => {
  const prod = code(fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-realapp.yml'), 'utf8'));
  assert.match(prod, /rapid-builder-app\b(?!-stg)/);
  assert.match(prod, /rapid-site-builder-app/);
  assert.match(prod, /builder\.opsagents\.agency/);
  assert.match(prod, /cloudbuild-realapp-hosting\.yaml/);
});

test('the staging rail names no PROD service, site, domain or hosting config', () => {
  assert.doesNotMatch(SRC, /rapid-builder-app\b(?!-stg)/, 'PROD Cloud Run service named');
  assert.doesNotMatch(SRC, /rapid-site-builder-app/, 'PROD Hosting site named');
  assert.doesNotMatch(SRC, /builder\.opsagents\.agency/, 'PROD domain named');
  assert.doesNotMatch(SRC, /cloudbuild-realapp-hosting\.yaml/, 'PROD hosting config used');
  assert.doesNotMatch(SRC, /cloudbuild-hosting\.yaml/, 'RETIRED hosting config used');
  assert.doesNotMatch(SRC, /rapid-builder-proxy/, 'RETIRED service named');
  assert.doesNotMatch(SRC, /gh\s+workflow\s+run|workflow_call|repository_dispatch/, 'must not chain into another workflow');
  assert.doesNotMatch(SRC, /RETIRE_UNGATED/, 'RETIRE_UNGATED would make this tier the retired surface');
});

test('every Cloud Run call targets the APP-STAGING service, and the site is APP-STAGING', () => {
  assert.match(SRC, /^\s+STG_SERVICE:\s*rapid-builder-app-stg\s*$/m);
  assert.match(SRC, /^\s+STG_HOSTING_SITE:\s*rapid-builder-stg\s*$/m);
  assert.match(SRC, /^\s+STG_APP_URL:\s*https:\/\/rapid-builder-stg\.web\.app\s*$/m);
  const calls = SRC.match(/gcloud run (deploy|services (update-traffic|describe|update))\s+\S+/g) || [];
  assert.ok(calls.length >= 3, `KNOWN-POSITIVE: Cloud Run calls found (${calls.length})`);
  for (const c of calls) assert.match(c, /"\$STG_SERVICE"$/, `not the staging service: ${c}`);
  assert.match(SRC, /--config=cloudbuild-staging-hosting\.yaml/);
  const cfg = fs.readFileSync(path.join(REPO, 'cloudbuild-staging-hosting.yaml'), 'utf8');
  assert.match(cfg, /--only hosting:rapid-builder-stg\b/, 'the hosting config must stay scoped to the staging site');
  assert.match(SRC, /--min-instances 0\b/);
  assert.doesNotMatch(SRC, /--min-instances [1-9]/, 'a QA tier holds no warm instance');
});

// ── 2. DISPATCH-ONLY, LEAST PRIVILEGE, PINNED ──────────────────────────────

test('dispatch is the ONLY trigger', () => {
  const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(SRC);
  assert.ok(on, 'on: block not found');
  const triggers = on[1].split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('least privilege: nothing at workflow level, the one job reads the repo and mints OIDC only', () => {
  assert.match(SRC, /^permissions: \{\}\s*$/m, 'workflow-level permissions must be empty');
  assert.doesNotMatch(SRC, /write-all|read-all/);
  const jobs = SRC.slice(SRC.indexOf('\njobs:'));
  const names = jobs.split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  assert.equal(names.length, 1, 'one job only');
  const perms = /\n {4}permissions:\n((?: {6}\S.*\n)+)/.exec(jobs);
  assert.ok(perms, 'job-level permissions block not found');
  const got = perms[1].trim().split('\n').map((l) => l.trim()).sort();
  assert.deepEqual(got, ['contents: read', 'id-token: write']);
});

test('every action is pinned to a full commit SHA (a tag can move under a deploy job)', () => {
  const uses = SRC.match(/uses:\s*\S+/g) || [];
  assert.ok(uses.length >= 3, 'KNOWN-POSITIVE: uses lines found');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `not pinned: ${u}`);
});

test('checkout leaves no git credential behind, and the sha input is validated before use', () => {
  assert.match(SRC, /persist-credentials:\s*false/);
  // TOCTOU: the checkout that the guard's node code runs from is the DISPATCHED
  // commit, never the requested sha.
  const co = /actions\/checkout@\S+\n\s+with:\n((?:\s{10}\S.*\n)+)/.exec(SRC);
  assert.ok(co, 'checkout with: block not found');
  assert.match(co[1], /ref:\s*\$\{\{\s*github\.sha\s*\}\}\s*$/m, 'checkout must be the dispatched commit');
  assert.doesNotMatch(co[1], /inputs\./, 'the requested sha must never be the tree the guard runs from');
  assert.match(SRC, /INPUT_SHA:\s*\$\{\{\s*inputs\.sha\s*\}\}/);
  assert.match(SRC, /\^\[0-9a-f\]\{40\}\$/, 'the input must be checked as a full SHA');
  const validate = SRC.indexOf('Validate the requested SHA');
  const checkout = SRC.search(/actions\/checkout@/);
  assert.ok(validate > -1 && validate < checkout, 'validation must run before the checkout that uses it');
  for (const run of SRC.split(/\n\s+run: \|/).slice(1)) {
    assert.doesNotMatch(run.split(/\n\s+- /)[0], /\$\{\{\s*(inputs\.|github\.event\.inputs\.)/, 'an input interpolated inline into a shell');
  }
});

test('APP-STAGING is written by ONE rail at a time: same concurrency group as deploy.yml', () => {
  const group = (s) => (/^concurrency:\n\s+(?:#.*\n\s+)*group:\s*(\S+)/m.exec(s) || [])[1];
  assert.equal(group(RAW_STAGING), 'deploy', 'KNOWN-POSITIVE: deploy.yml group read');
  assert.equal(group(RAW), group(RAW_STAGING));
  assert.match(SRC, /cancel-in-progress:\s*false/);
});

// ── 3. THE REF GUARD ────────────────────────────────────────────────────────

test('the policy row: real-app line only, and never merely main', () => {
  const row = DEPLOY_REF_POLICY[FILE];
  assert.ok(row, 'policy row missing');
  assert.equal(row.expectedRef, 'real-app');
  assert.deepEqual(row.mustNotBeAncestorOf, ['main']);
  assert.doesNotMatch(row.tier, /rapid-builder-app\b(?!-stg)|rapid-site-builder-app/, 'the tier text names APP-STAGING, not PROD');
});

test('verdicts: an unmerged card tip is refused, main is refused, cannot-measure is refused, real-app is allowed', () => {
  const p = DEPLOY_REF_POLICY[FILE];
  const ctx = (forbidden) => ({ workflow: FILE, expectedRef: p.expectedRef, tier: p.tier, dispatchedRef: 'x', forbidden });
  assert.equal(refDeployVerdict(1, ctx([{ ref: 'main', exitCode: 1 }])).verdict, 'refuse', 'card/* tip not on real-app');
  assert.equal(refDeployVerdict(0, ctx([{ ref: 'main', exitCode: 0 }])).verdict, 'refuse', 'main bytes are deploy.yml\'s job');
  assert.equal(refDeployVerdict(128, ctx([{ ref: 'main', exitCode: 1 }])).verdict, 'cannot-verify');
  assert.equal(refDeployVerdict(0, ctx([])).verdict, 'cannot-verify', 'a missing main probe is not a pass');
  assert.equal(refDeployVerdict(0, ctx([{ ref: 'main', exitCode: 1 }])).verdict, 'allow');
});

test('the guard step reads THIS row, runs before credentials, and the stamp follows it', () => {
  const guard = SRC.indexOf('Refuse a dispatch on any ref');
  const stamp = SRC.indexOf('Stamp the commit this build serves');
  const auth = SRC.search(/google-github-actions\/auth@/);
  const deploy = SRC.indexOf('gcloud run deploy');
  assert.ok(guard > -1 && stamp > guard && auth > stamp && deploy > auth, 'order: guard -> stamp -> auth -> deploy');
  assert.match(SRC, /DEPLOY_REF_POLICY\['deploy-realapp-staging\.yml'\]\.expectedRef/);
  assert.match(SRC, /DEPLOY_REF_POLICY\["deploy-realapp-staging\.yml"\]/);
  assert.match(SRC, /workflow: "deploy-realapp-staging\.yml"/);
});

const have = (ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: REPO }).status === 0;
const isAnc = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: REPO }).status;

test('on REAL git: the real-app tip would be staged, the main tip refused', (t) => {
  const ra = ['refs/remotes/origin/real-app', 'real-app'].find(have);
  const mn = ['refs/remotes/origin/main', 'main'].find(have);
  if (!ra || !mn) return t.skip('need both main and real-app (shallow clone?)');
  const p = DEPLOY_REF_POLICY[FILE];
  const v = (head) => refDeployVerdict(isAnc(head, ra), {
    workflow: FILE, expectedRef: p.expectedRef, tier: p.tier, dispatchedRef: head,
    forbidden: [{ ref: 'main', exitCode: isAnc(head, mn) }],
  });
  assert.equal(v(ra).verdict, 'allow', v(ra).message);
  assert.equal(v(mn).verdict, 'refuse', v(mn).message);
});

// ── 4. ENV PARITY + MERGE SEMANTICS ─────────────────────────────────────────

test('env keys equal deploy.yml APP-STAGING, key for key — and both MERGE (rule #20)', () => {
  const mine = SRC;
  const theirs = code(jobBlock(RAW_STAGING, 'deploy-app-staging'));
  assert.deepEqual(envKeys(mine), envKeys(theirs));
  assert.doesNotMatch(mine, /--set-env-vars/);
  const secrets = mine.match(/--set-secrets\s+"([^"]+)"/g) || [];
  assert.deepEqual(secrets, ['--set-secrets "SESSION_SECRET=rapid-builder-session-secret:latest"']);
  assert.match(mine, /PUBLIC_BASE_URL=https:\/\/rapid-builder-stg\.web\.app/);
  assert.match(mine, /ALLOWED_ORIGINS=https:\/\/rapid-builder-stg\.web\.app"/);
});

// ── 5. WHICH COMMIT IS STAGED ───────────────────────────────────────────────

test('the stamp writes BUILD_COMMIT from HEAD, and both smoke steps demand that commit back', () => {
  assert.match(SRC, /git rev-parse HEAD > BUILD_COMMIT/);
  const smokes = SRC.split('- name: ').filter((s) => /^Smoke test/.test(s));
  assert.equal(smokes.length, 2);
  for (const s of smokes) {
    assert.match(s, /SHA:\s*\$\{\{\s*steps\.stamp\.outputs\.sha\s*\}\}/);
    assert.match(s, /"commit\\":\\"\$SHA\\""/, 'smoke must grep the exact commit');
    assert.match(s, /'"auth":true'/, 'smoke must fail closed on auth');
  }
});

test('readBuildCommit: a full SHA reads back; anything else is null, never a guess', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  const f = path.join(dir, 'BUILD_COMMIT');
  const sha = 'a'.repeat(40);
  fs.writeFileSync(f, `${sha}\n`);
  assert.equal(readBuildCommit(f), sha);
  for (const bad of ['', 'main', 'A'.repeat(40), 'a'.repeat(39), `${sha}x`, 'a'.repeat(40) + '\nevil']) {
    fs.writeFileSync(f, bad);
    assert.equal(readBuildCommit(f), null, JSON.stringify(bad));
  }
  assert.equal(readBuildCommit(path.join(dir, 'absent')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BUILD_COMMIT is never committed, and nothing ignores it out of the gcloud upload', (t) => {
  assert.equal(path.basename(BUILD_COMMIT_FILE), 'BUILD_COMMIT');
  assert.equal(path.dirname(BUILD_COMMIT_FILE), REPO, 'must sit at the source root gcloud uploads');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'BUILD_COMMIT'], { cwd: REPO });
  if (tracked.error) return t.skip('git unavailable');
  assert.notEqual(tracked.status, 0, 'BUILD_COMMIT is tracked — every deploy would report that stale commit');
  // .gcloudignore includes .gitignore: an ignored BUILD_COMMIT never reaches the image.
  const ignored = spawnSync('git', ['check-ignore', '-q', 'BUILD_COMMIT'], { cwd: REPO });
  assert.equal(ignored.status, 1, 'BUILD_COMMIT is git-ignored, so .gcloudignore would drop it from the upload');
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, '.gcloudignore'), 'utf8'), /^BUILD_COMMIT/m);
});

test('/api/health reports commit (null without a stamp) and the Cloud Run revision field', async () => {
  const { app } = require('../server');
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('commit' in body, 'health must carry commit');
    assert.ok('revision' in body, 'health must carry revision');
    assert.equal(body.commit, readBuildCommit(), 'health reports exactly what buildInfo read');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── 6. TOCTOU: a requested SHA cannot approve itself ────────────────────────
//
// Security review of the first head (83d0d33): the workflow checked out
// `inputs.sha` and then ran the guard's node code FROM THAT TREE, so a commit
// whose own lib/deployRefPolicy.js always allows would pass its own guard.
// These tests execute the guard step's real shell, extracted from the
// workflow, against a scratch repository.

/** The `run: |` body of the step named `name`, dedented. */
function stepRun(raw, name) {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  assert.ok(at > -1, `step ${name} not found`);
  const r = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const body = [];
  for (let i = r + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (!/^ {10}/.test(lines[i])) break;
    body.push(lines[i].slice(10));
  }
  return body.join('\n');
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Scratch repo: main=base; real-app = base -> c1 -> c2; evil = c1 -> tampered policy. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-guard-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(REPO, 'lib', 'deployRefPolicy.js'), path.join(dir, 'lib', 'deployRefPolicy.js'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'c1');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'c2');
  const c2 = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '--detach', c1);
  const evilSrc = fs.readFileSync(path.join(dir, 'lib', 'deployRefPolicy.js'), 'utf8') +
    "\nmodule.exports.refDeployVerdict = () => ({ allow: true, verdict: 'allow', message: 'TAMPERED: always allow' });\n";
  fs.writeFileSync(path.join(dir, 'lib', 'deployRefPolicy.js'), evilSrc);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'evil: self-approving policy');
  const evil = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'update-ref', 'refs/remotes/origin/real-app', c2);
  return { dir, base, c1, c2, evil };
}

function runGuard(repo, dispatched, inputSha) {
  git(repo.dir, 'checkout', '-q', '--detach', dispatched);
  const out = path.join(repo.dir, '.gh-output');
  fs.writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', stepRun(RAW, 'Refuse a dispatch on any ref')], {
    cwd: repo.dir, encoding: 'utf8',
    env: { ...process.env, REF_NAME: 'real-app', INPUT_SHA: inputSha, GITHUB_OUTPUT: out },
  });
  return { status: r.status, log: r.stdout + r.stderr, output: fs.readFileSync(out, 'utf8') };
}

test('KNOWN-POSITIVE: the tampered policy really approves anything when it is the one loaded', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const repo = scratchRepo();
  try {
    // The FIRST head's guard ran from the requested SHA's tree: that is HEAD=evil here.
    const r = runGuard(repo, repo.evil, '');
    assert.equal(r.status, 0, 'control: running the guard FROM the tampered tree passes — the hole the fix closes');
    assert.match(r.log, /TAMPERED/);
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('TOCTOU: a requested SHA carrying a self-approving deployRefPolicy.js is REFUSED', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const repo = scratchRepo();
  try {
    // Dispatched on the real-app tip (the trusted tree), asking to stage evil.
    const r = runGuard(repo, repo.c2, repo.evil);
    assert.notEqual(r.status, 0, `tampered SHA was approved:\n${r.log}`);
    assert.doesNotMatch(r.log, /TAMPERED/, 'the requested SHA\'s policy code must never run');
    assert.match(r.log, /REFUSED|CANNOT VERIFY/);
    assert.equal(r.output, '', 'no target is handed to the build step on a refusal');
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('the guard approves a real-app commit, and refuses main, an unknown SHA and a card-branch dispatch', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const repo = scratchRepo();
  try {
    const older = runGuard(repo, repo.c2, repo.c1);
    assert.equal(older.status, 0, older.log);
    assert.equal(older.output.trim(), `target=${repo.c1}`);
    const tip = runGuard(repo, repo.c2, '');
    assert.equal(tip.status, 0, tip.log);
    assert.equal(tip.output.trim(), `target=${repo.c2}`);
    assert.notEqual(runGuard(repo, repo.c2, repo.base).status, 0, 'main bytes must be refused');
    assert.notEqual(runGuard(repo, repo.c2, 'f'.repeat(40)).status, 0, 'a SHA git does not have must be refused');
    // Dispatched from a branch that is not on real-app (its own tree is the
    // honest copy here): the dispatched-tree check refuses it.
    git(repo.dir, 'checkout', '-q', '--detach', repo.c1);
    fs.writeFileSync(path.join(repo.dir, 'c.txt'), '3'); git(repo.dir, 'add', 'c.txt'); git(repo.dir, 'commit', '-qm', 'card branch');
    const card = git(repo.dir, 'rev-parse', 'HEAD');
    assert.notEqual(runGuard(repo, card, repo.c1).status, 0, 'a dispatch from an unmerged branch must be refused');
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('the build checks out the APPROVED target only after the guard, and runs no repo code from it', () => {
  const guard = SRC.indexOf('Refuse a dispatch on any ref');
  const co = SRC.indexOf('Check out the approved commit for the build');
  const stamp = SRC.indexOf('Stamp the commit this build serves');
  assert.ok(guard > -1 && co > guard && stamp > co, 'order: guard -> checkout target -> stamp');
  const step = SRC.slice(co, stamp);
  assert.match(step, /TARGET:\s*\$\{\{\s*steps\.refguard\.outputs\.target\s*\}\}/);
  assert.match(step, /git checkout --quiet --detach "\$TARGET"/);
  const after = SRC.slice(co);
  assert.doesNotMatch(after, /\bnode\s+(-e|-p|\S+\.m?js)|npm (run|test|ci)|require\(/, 'no repo code may run from the requested tree');
});
