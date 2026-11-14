'use strict';
/*
 * Card OmZcY0q6 — no deploy uploads a source tree that contains a symlink.
 *
 * `gcloud run deploy --source .` zips the workspace and zipfile.write FOLLOWS
 * file symlinks, so a committed `web/innocent.json -> /home/runner/.config/
 * gcloud/credentials.db` ships the credential bytes under the innocent name,
 * and express.static(web) serves them. `gcloud meta list-files-for-upload`
 * lists the link under its innocent name, so an upload-set check cannot see it,
 * and `sed -i` on a symlinked web/index.html writes through to the target.
 *
 * Two halves:
 *   1. scripts/refuse-symlinks.sh, EXECUTED against scratch git repos whose
 *      symlinks are COMMITTED and then materialised by a fresh clone (what
 *      actions/checkout does): file link refused, directory link refused (an
 *      explicit decision: not followed by the zip today, refused anyway),
 *      dangling link refused, the known-positive control passes.
 *   2. every workflow job that uploads source runs that script, live (not in a
 *      comment, not softened), AFTER every checkout that shapes the uploaded
 *      tree and BEFORE the first `sed -i` on web/ and the first upload. The
 *      three deploy workflows the card names are pinned by name, and every
 *      other workflow is discovered by its upload verb, so a new rail cannot
 *      ship without the check either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { strip, jobsOf, workflowFiles } = require('./vendor/workflow-parse.js');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'refuse-symlinks.sh');
const WF = path.join(REPO, '.github', 'workflows');

// ── half 1: the script, executed ───────────────────────────────────────────

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A scratch repo with `files` (path -> content) and `links` (path -> link
 * text) COMMITTED, then cloned fresh, so every link under test is one git
 * recorded as mode 120000 and checkout re-created — not one the test made in
 * the directory it scans.
 */
function committedTree(files, links = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refuse-symlinks-'));
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  const git = (args, cwd = src) =>
    sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main',
      '-c', 'core.symlinks=true', ...args], cwd);
  git(['init', '-q']);
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true });
    fs.writeFileSync(path.join(src, p), body);
  }
  for (const [p, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true });
    fs.symlinkSync(target, path.join(src, p));
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'scratch']);
  for (const p of Object.keys(links)) {
    const mode = git(['ls-files', '-s', '--', p]).split(/\s+/)[0];
    assert.equal(mode, '120000', `${p} must be COMMITTED as a symlink (mode 120000), got ${mode}`);
  }
  const out = path.join(base, 'checkout');
  git(['clone', '-q', src, out], base);
  return { base, root: out };
}

/** Run the script exactly as the workflows do: `bash scripts/refuse-symlinks.sh`, cwd = repo root. */
function refuse(root, args = []) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
}

const SITE = { 'web/index.html': '<html>__API_BASE__</html>\n', 'server.js': '// app\n' };

test('known-positive control: a tree with no symlink passes (exit 0)', () => {
  const { root } = committedTree(SITE);
  const r = refuse(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no symlink under /);
  assert.doesNotMatch(r.stdout, /::error::/);
});

test('a committed FILE symlink is refused: non-zero, ::error:: names the path, target bytes never printed', () => {
  // The decoy stands in for /home/runner/.config/gcloud/credentials.db: a file
  // OUTSIDE the tree whose bytes must never reach output (or an upload).
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refuse-symlinks-decoy-'));
  const decoy = path.join(decoyDir, 'credentials.db');
  fs.writeFileSync(decoy, 'DECOY-CREDENTIAL-BYTES-not-a-real-secret\n');
  const { root } = committedTree(SITE, { 'web/innocent.json': decoy });
  // Pre-condition: the link really resolves, i.e. a zip walk WOULD read the decoy.
  assert.equal(fs.readFileSync(path.join(root, 'web', 'innocent.json'), 'utf8'),
    'DECOY-CREDENTIAL-BYTES-not-a-real-secret\n');
  const r = refuse(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^::error::symlink in the upload root: web\/innocent\.json -> /m);
  assert.match(r.stdout, /^::error::REFUSED: 1 symlink\(s\) in the upload root/m);
  assert.doesNotMatch(r.stdout + r.stderr, /DECOY-CREDENTIAL-BYTES/, 'the link target content is never printed');
});

test('DECISION: a committed DIRECTORY symlink is refused too (not followed by the zip today; refused anyway)', () => {
  const { root } = committedTree({ ...SITE, 'lib/a.js': '//\n' }, { 'web/lib': '../lib' });
  assert.ok(fs.lstatSync(path.join(root, 'web', 'lib')).isSymbolicLink());
  assert.ok(fs.statSync(path.join(root, 'web', 'lib')).isDirectory(), 'the link resolves to a directory');
  const r = refuse(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^::error::symlink in the upload root: web\/lib -> \.\.\/lib$/m);
});

test('a dangling symlink, and several at once, are all named', () => {
  const { root } = committedTree(SITE, {
    'web/gone.json': '/nonexistent/refuse-symlinks/target',
    'web/index2.html': 'index.html',
  });
  const r = refuse(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^::error::symlink in the upload root: web\/gone\.json -> /m);
  assert.match(r.stdout, /^::error::symlink in the upload root: web\/index2\.html -> index\.html$/m);
  assert.match(r.stdout, /REFUSED: 2 symlink\(s\)/);
});

test('a symlink inside .git is not part of the upload root and does not refuse', () => {
  const { root } = committedTree(SITE);
  fs.symlinkSync('/nonexistent', path.join(root, '.git', 'scratch-link'));
  const r = refuse(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the ROOT argument scans that directory; a ROOT that is not a directory exits 2 (fail closed)', () => {
  const { base, root } = committedTree(SITE, { 'web/x.json': '/etc/hosts' });
  const viaArg = spawnSync('bash', [SCRIPT, root], { cwd: base, encoding: 'utf8' });
  assert.equal(viaArg.status, 1, viaArg.stdout + viaArg.stderr);
  assert.match(viaArg.stdout, /web\/x\.json/);
  const missing = spawnSync('bash', [SCRIPT, path.join(base, 'no-such-dir')], { cwd: base, encoding: 'utf8' });
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /::error::refuse-symlinks: .* is not a directory/);
});

// ── half 2: every uploading workflow job runs it, in the right place ───────

const UPLOAD = /--source[ =]|\bgcloud\s+builds\s+submit\b/;
const SED_WEB = /\bsed\s+-i\b.*\bweb\//;
const CHECKOUT = /uses:\s*actions\/checkout@|\bgit\s+(?:-C\s+\S+\s+)?checkout\b/;
const INVOKE = /^\s*(?:run:\s*)?bash\s+(?:scripts\/refuse-symlinks\.sh|"?\$\{?RUNNER_TEMP\}?\/refuse-symlinks\.sh"?)\b/;

/** Steps of a job as `{ start, lines }`, with live (comment-stripped) text. */
function stepsOf(jobText) {
  const lines = jobText.split('\n');
  const steps = [];
  lines.forEach((l, i) => {
    if (/^ {6}- /.test(l)) steps.push({ start: i, lines: [] });
    if (steps.length) steps[steps.length - 1].lines.push(l);
  });
  return { lines, steps };
}

/**
 * The order verdict for one job. `null` when the job uploads nothing;
 * otherwise `{ ok, why }`. Operates on comment-stripped text, so a
 * commented-out invocation is no invocation.
 */
function verdict(jobText) {
  const { lines, steps } = stepsOf(jobText);
  const upload = lines.findIndex((l) => UPLOAD.test(l));
  if (upload === -1) return null;
  const sed = lines.findIndex((l) => SED_WEB.test(l));
  const inv = lines.findIndex((l) => /refuse-symlinks\.sh/.test(l));
  if (inv === -1) return { ok: false, why: 'uploads source but never runs scripts/refuse-symlinks.sh' };
  if (!INVOKE.test(lines[inv])) return { ok: false, why: `the check is not a plain \`bash …refuse-symlinks.sh\` call: ${lines[inv].trim()}` };
  if (/\|\||;\s*true\b|\bset\s+\+e\b/.test(lines[inv])) return { ok: false, why: `the check's exit status is swallowed: ${lines[inv].trim()}` };
  const step = steps.filter((s) => s.start <= inv).pop();
  const stepText = step.lines.join('\n');
  if (/^\s+continue-on-error:\s*true/m.test(stepText)) return { ok: false, why: 'the check step has continue-on-error: true' };
  if (/^ {8}if:/m.test(stepText)) return { ok: false, why: 'the check step is conditional (`if:`); it must run on every run that uploads' };
  if (inv > upload) return { ok: false, why: `the check (line ${inv}) runs AFTER the first upload (line ${upload})` };
  if (sed !== -1 && inv > sed) return { ok: false, why: `the check (line ${inv}) runs AFTER \`sed -i\` on web/ (line ${sed}), which writes through a link` };
  const lateCheckout = lines.findIndex((l, i) => i > inv && i < upload && CHECKOUT.test(l));
  if (lateCheckout !== -1) return { ok: false, why: `a checkout (line ${lateCheckout}) re-shapes the tree AFTER the check and before the upload` };
  return { ok: true, why: 'check runs after the last checkout and before any sed -i on web/ and any upload' };
}

const read = (f) => strip(fs.readFileSync(path.join(WF, f), 'utf8'));
const uploadingJobs = (f) => jobsOf(read(f)).map((j) => ({ job: j.name, v: verdict(j.text) })).filter((x) => x.v);

test('RED-FIRST: the order verdict refuses each broken shape and accepts the fixed one', () => {
  const head = '  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n';
  const up = '      - name: Deploy\n        run: |\n          sed -i "s#a#b#g" web/index.html\n          gcloud run deploy svc \\\n            --source . \\\n            --quiet\n';
  const check = '      - name: Refuse a source tree that contains a symlink\n        run: bash scripts/refuse-symlinks.sh\n';
  assert.match(verdict(head + up).why, /never runs/, 'pre-fix shape: no check');
  assert.match(verdict(strip(head + check.replace(/^/gm, '#') + up)).why, /never runs/, 'a commented-out check is no check');
  assert.match(verdict(head + up + check).why, /AFTER `sed -i`|AFTER the first upload/, 'check after the bake/upload');
  assert.match(verdict(head + check.replace('symlinks.sh', 'symlinks.sh || true') + up).why, /swallowed/);
  assert.match(verdict(head + check + '        continue-on-error: true\n' + up).why, /continue-on-error/);
  assert.match(verdict(head + check + '      - run: git checkout --detach "$TARGET"\n' + up).why, /re-shapes the tree/);
  assert.equal(verdict(head + check + up).ok, true, 'fixed shape');
  assert.equal(verdict(head + '      - run: echo no upload here\n'), null, 'a job that uploads nothing is not judged');
});

const NAMED = { 'deploy.yml': 2, 'deploy-realapp.yml': 1 };

for (const [file, n] of Object.entries(NAMED)) {
  test(`${file}: each of its ${n} uploading job(s) runs the symlink refusal before sed -i and the upload`, () => {
    const jobs = uploadingJobs(file);
    assert.equal(jobs.length, n, `${file}: expected ${n} uploading job(s), found ${jobs.map((j) => j.job).join(', ') || 'none'} — a parser that finds nothing must not pass`);
    for (const { job, v } of jobs) assert.ok(v.ok, `${file} job ${job}: ${v.why}`);
  });
}

test('deploy-realapp-staging.yml: if this copy uploads (real-app\'s rail), every uploading job runs the refusal; and its header may claim "credentials never reach the upload" only next to the check', () => {
  const raw = fs.readFileSync(path.join(WF, 'deploy-realapp-staging.yml'), 'utf8');
  const jobs = uploadingJobs('deploy-realapp-staging.yml');
  // main carries a registration stub (card Ese6i9Ke) that uploads nothing; the
  // rail lives on real-app. This test arrives there with the next main ->
  // real-app merge and then holds the rail to the same rule.
  for (const { job, v } of jobs) assert.ok(v.ok, `deploy-realapp-staging.yml job ${job}: ${v.why}`);
  if (/CREDENTIALS NEVER REACH THE UPLOAD/i.test(raw)) {
    assert.match(raw, /refuse-symlinks\.sh/,
      'the header claims credentials never reach the upload, but the file never names the symlink check that makes that true (a committed file symlink to a credential file passes the upload-set check under its innocent name)');
  }
  if (jobs.length === 0) {
    assert.doesNotMatch(strip(raw), /gcloud|--source|builds submit/, 'no upload verb hides from the UPLOAD matcher');
  }
});

test('every workflow that uploads source runs the refusal first (discovered by verb, so a new rail cannot skip it)', () => {
  const all = workflowFiles(REPO);
  assert.ok(all.includes('deploy.yml') && all.includes('preview.yml'), 'workflow discovery found the deploy rails');
  const bad = [];
  let judged = 0;
  for (const f of all) {
    for (const { job, v } of uploadingJobs(f)) {
      judged++;
      if (!v.ok) bad.push(`${f} job ${job}: ${v.why}`);
    }
  }
  assert.ok(judged >= 4, `expected at least deploy.yml x2, deploy-realapp.yml and preview.yml to be judged, got ${judged}`);
  assert.deepEqual(bad, []);
});
