'use strict';
// Card ApypZ3Te — the PROD rail reports the commit it deployed.
//
// Measured 2026-11-01: staging /api/health carried `commit`, prod did not, after
// a prod run at the same SHA, because deploy-realapp.yml wrote no BUILD_COMMIT.
// This suite pins the write, the refusal to upload without it, and the read-back,
// by executing the workflow's real shell against stubs. Nothing here calls gcloud
// or the network, and nothing dispatches the workflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readBuildCommit } = require('../lib/buildInfo');
const { stepRun } = require('./helpers/workflowStep');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const RAW = fs.readFileSync(path.join(WF, 'deploy-realapp.yml'), 'utf8');
const RAW_STAGING = fs.readFileSync(path.join(WF, 'deploy-realapp-staging.yml'), 'utf8');
/** Executable lines only: the header prose must never satisfy a pin. */
const SRC = RAW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const STAMP = 'Stamp the commit this build serves';
const UPLOAD = 'Refuse an upload without BUILD_COMMIT';
const HOSTING_SMOKE = 'Smoke test Hosting';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-stamp-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  return { root, bin, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function stub(bin, name, body) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function runStep(name, cwd, env) {
  const r = spawnSync('bash', ['-e', '-c', stepRun(RAW, name)], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, log: r.stdout + r.stderr };
}

// ── THE WRITE ───────────────────────────────────────────────────────────────

test('the stamp step writes HEAD to BUILD_COMMIT, in the form /api/health reads back', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git unavailable');
  const sb = sandbox();
  try {
    const git = (...a) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: sb.root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'c1');
    const head = git('rev-parse', 'HEAD');
    const output = path.join(sb.root, 'gh-output');
    const r = runStep(STAMP, sb.root, { GITHUB_OUTPUT: output });
    assert.equal(r.status, 0, r.log);
    assert.equal(fs.readFileSync(path.join(sb.root, 'BUILD_COMMIT'), 'utf8').trim(), head);
    assert.equal(readBuildCommit(path.join(sb.root, 'BUILD_COMMIT')), head);
    assert.equal(fs.readFileSync(output, 'utf8').trim(), `sha=${head}`, 'the smoke steps read this output');
  } finally { sb.done(); }
});

test('the stamp comes from the checkout, and the rail takes no input that could override it', () => {
  assert.match(SRC, /- name: Stamp the commit this build serves\n\s+id: stamp\n/);
  assert.match(stepRun(RAW, STAMP), /^git rev-parse HEAD > BUILD_COMMIT$/m);
  assert.doesNotMatch(SRC, /^\s+inputs:/m, 'a dispatch input could stamp a commit the build did not come from');
  assert.equal((SRC.match(/> BUILD_COMMIT/g) || []).length, 1, 'one write, one source');
});

test('order: guard -> stamp -> auth -> setup-gcloud -> upload check -> first upload', () => {
  const at = (re) => SRC.search(re);
  const steps = {
    guard: at(/id: refguard/),
    stamp: at(/id: stamp/),
    auth: at(/google-github-actions\/auth@/),
    setup: at(/google-github-actions\/setup-gcloud@/),
    check: at(/- name: Refuse an upload without BUILD_COMMIT/),
    deploy: at(/gcloud run deploy "\$SERVICE"/),
    submit: at(/gcloud builds submit \./),
  };
  const seq = Object.values(steps);
  assert.ok(seq.every((v) => v > -1), `every step found: ${JSON.stringify(steps)}`);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b), `out of order: ${JSON.stringify(steps)}`);
});

test('no `if:` on the stamp or the upload check: neither can be skipped into a stampless deploy', () => {
  for (const name of [STAMP, UPLOAD]) {
    const from = SRC.indexOf(`- name: ${name}`);
    assert.ok(from > -1, `step ${name} not found`);
    const block = SRC.slice(from, SRC.indexOf('\n      - ', from + 1));
    assert.doesNotMatch(block, /^\s+if:/m, name);
    assert.doesNotMatch(block, /continue-on-error/, name);
  }
});

// ── THE REFUSAL ─────────────────────────────────────────────────────────────

/** The upload check against a stub `gcloud` whose dry run prints `files`, or exits `exit`. */
function uploadCheck(files, exit = 0) {
  const sb = sandbox();
  try {
    const list = path.join(sb.root, 'list.txt');
    fs.writeFileSync(list, files.join('\n') + '\n');
    const calls = path.join(sb.root, 'calls.txt');
    stub(sb.bin, 'gcloud', `echo "$*" >> ${JSON.stringify(calls)}\n[ "$1 $2" = "meta list-files-for-upload" ] || { echo "unexpected gcloud $*" >&2; exit 2; }\ncat ${JSON.stringify(list)}\nexit ${exit}`);
    const r = runStep(UPLOAD, sb.root, { PATH: `${sb.bin}:${process.env.PATH}`, RUNNER_TEMP: sb.root });
    return { ...r, calls: fs.readFileSync(calls, 'utf8').trim().split('\n') };
  } finally { sb.done(); }
}

const CLEAN = ['server.js', 'lib/buildInfo.js', 'web/index.html', 'Dockerfile'];

test('the upload check passes when the dry run lists BUILD_COMMIT at the upload root', () => {
  for (const entry of ['BUILD_COMMIT', './BUILD_COMMIT']) {
    const r = uploadCheck([entry, ...CLEAN]);
    assert.equal(r.status, 0, r.log);
    assert.match(r.log, /BUILD_COMMIT present/);
  }
});

test('the upload check refuses a set with no stamp, or only a lookalike', () => {
  for (const files of [CLEAN, [...CLEAN, 'web/BUILD_COMMIT'], [...CLEAN, 'BUILD_COMMIT.bak'], [...CLEAN, 'XBUILD_COMMIT']]) {
    const r = uploadCheck(files);
    assert.notEqual(r.status, 0, `must refuse: ${files.join(' ')}`);
    assert.match(r.log, /BUILD_COMMIT is not in the upload set/);
  }
});

test('a dry run that fails stops the job: "could not list" is never a pass', () => {
  assert.notEqual(uploadCheck(['BUILD_COMMIT', ...CLEAN], 1).status, 0);
});

test('the check only reads: its one gcloud call is the dry run', () => {
  assert.deepEqual(uploadCheck(['BUILD_COMMIT', ...CLEAN]).calls, ['meta list-files-for-upload .']);
});

// ── THE READ-BACK ───────────────────────────────────────────────────────────

test('both smoke steps take the SHA from the stamp and grep for that exact commit', () => {
  const smokes = SRC.split('- name: ').filter((s) => /^Smoke test/.test(s));
  assert.equal(smokes.length, 2);
  for (const s of smokes) {
    assert.match(s, /SHA:\s*\$\{\{\s*steps\.stamp\.outputs\.sha\s*\}\}/);
    assert.match(s, /grep -q "\\"commit\\":\\"\$SHA\\""/);
  }
});

/** The Hosting smoke with `curl` stubbed: the custom domain answers `health`. */
function hostingSmoke(health, sha) {
  const sb = sandbox();
  try {
    const body = path.join(sb.root, 'body.json');
    fs.writeFileSync(body, health);
    stub(sb.bin, 'sleep', 'exit 0');
    stub(sb.bin, 'curl', `out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\n[ "$out" = /dev/null ] || cp ${JSON.stringify(body)} "$out"\necho 200`);
    return runStep(HOSTING_SMOKE, sb.root, {
      PATH: `${sb.bin}:${process.env.PATH}`,
      RUNNER_TEMP: sb.root,
      SHA: sha,
      APP_URL: 'https://app.example.invalid',
      HOSTING_URL: 'https://hosting.example.invalid',
    });
  } finally { sb.done(); }
}

test('the custom-domain probe passes only when prod reports this run\'s SHA', () => {
  const sha = 'a'.repeat(40);
  const ok = hostingSmoke(JSON.stringify({ ok: true, commit: sha }), sha);
  assert.equal(ok.status, 0, ok.log);
  for (const health of [{ ok: true, commit: null }, { ok: true, commit: 'b'.repeat(40) }, { ok: true }]) {
    const r = hostingSmoke(JSON.stringify(health), sha);
    assert.notEqual(r.status, 0, `must refuse: ${JSON.stringify(health)}`);
    assert.match(r.log, /did not report commit/);
  }
});

test('an empty SHA cannot satisfy the probe through a blank commit field', () => {
  assert.notEqual(hostingSmoke(JSON.stringify({ ok: true, commit: 'a'.repeat(40) }), '').status, 0);
});

// ── SAME WAY AS THE STAGING RAIL ────────────────────────────────────────────

test('the two rails stamp and check with the same lines, so they cannot drift apart', () => {
  const stampLine = 'git rev-parse HEAD > BUILD_COMMIT';
  const checkLine = "if ! grep -qxE '(\\./)?BUILD_COMMIT' \"$RUNNER_TEMP/upload-set.txt\"; then";
  assert.ok(stepRun(RAW_STAGING, STAMP).split('\n').includes(stampLine), 'KNOWN-POSITIVE: staging stamp line');
  assert.ok(stepRun(RAW, STAMP).split('\n').includes(stampLine));
  assert.ok(stepRun(RAW_STAGING, 'Refuse an upload set that carries credentials').split('\n').includes(checkLine), 'KNOWN-POSITIVE: staging check line');
  assert.ok(stepRun(RAW, UPLOAD).split('\n').includes(checkLine));
});
