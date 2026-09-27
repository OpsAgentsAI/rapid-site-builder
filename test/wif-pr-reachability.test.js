'use strict';
// 09PBYCJY rule 2 — NO `pull_request`-reachable job may mint a cloud identity,
// on ANY runner. Card vpukxEgQ.
//
// WHAT WENT WRONG HERE, recorded so the shape stays refused: `preview.yml` had
// ONE `preview` job, `id-token: write` at WORKFLOW level, triggering on
// `pull_request`, authenticating via `secrets.WIF_PROVIDER`/
// `secrets.WIF_SERVICE_ACCOUNT`, and it had NO job-level event or fork guard
// at all (`jobIf: null`, confirmed live via the census).
//
// ⚠️ The one real mitigation here was incidental, not designed: the identity
// came from `secrets.*`, so a fork PR gets neither value and auth fails there.
// That backstop does NOT cover the same-repo path — a same-repo PR minted the
// staging deploy identity with no gate of any kind.
//
// This test FAILS CLOSED in both directions: a job it cannot classify is a
// violation, AND it asserts its corpus is non-empty and that it can still see
// a known WIF job. A regex guard whose parser silently stops matching
// otherwise passes vacuously — worse than no guard, because it occupies the
// slot.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  workflowFiles, load, jobsOf, jobIdToken, usesCloudAuth,
  triggersOf, workflowRunParents, workflowName, strip,
} = require('./vendor/workflow-parse.js');

const REPO = path.join(__dirname, '..');
const files = workflowFiles(REPO);
const codeOf = Object.fromEntries(files.map((f) => [f, load(REPO, f)]));
const nameToFile = Object.fromEntries(
  files.map((f) => [workflowName(codeOf[f]), f]).filter(([n]) => n),
);

// Transitive: a `workflow_run` hop off a PR-triggered workflow is still PR-reachable.
const prReachable = (() => {
  const s = new Set(files.filter((f) => {
    const t = triggersOf(codeOf[f]);
    return t.includes('pull_request') || t.includes('pull_request_target');
  }));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of files) {
      if (s.has(f)) continue;
      if (workflowRunParents(codeOf[f]).some((p) => s.has(nameToFile[p]))) { s.add(f); grew = true; }
    }
  }
  return s;
})();

test('the workflow corpus is actually being read (no vacuous pass)', () => {
  assert.ok(files.length >= 2, `expected this repo's workflows, found ${files.length}`);
  assert.ok(prReachable.size >= 1, 'no PR-reachable workflow found — the trigger parser has stopped matching');
  // If the parser can no longer see the ONE known WIF job in the repo, every
  // assertion below is meaningless and must not read as a pass.
  const c = codeOf['preview.yml'];
  const seen = jobsOf(c).filter((j) => jobIdToken(j, c) && usesCloudAuth(j));
  assert.equal(seen.length, 1, 'parser can no longer see the WIF job in preview.yml');
});

test('no pull_request-reachable job mints a cloud identity (09PBYCJY rule 2)', () => {
  const violations = [];
  for (const f of files) {
    if (!prReachable.has(f)) continue;
    for (const job of jobsOf(codeOf[f])) {
      if (jobIdToken(job, codeOf[f]) || usesCloudAuth(job)) {
        violations.push(`${f} · ${job.name}: reachable from pull_request and holds id-token/cloud-auth`);
      }
    }
  }
  assert.deepEqual(violations, [], `09PBYCJY rule 2 violations:\n  ${violations.join('\n  ')}`);
});

test('ci.yml is the identity-free PR lane, and runs this guard', () => {
  const code = codeOf['ci.yml'];
  assert.ok(triggersOf(code).includes('pull_request'), 'it should still be the PR lane');
  assert.ok(!/^permissions:[\s\S]*?^ {2}id-token:/m.test(code),
    'workflow-level `id-token: write` appeared here — that would defeat the split');

  const guard = jobsOf(code).find((j) => j.name === 'wif-pr-reachability');
  assert.ok(guard, '`wif-pr-reachability` job is gone — pull_request would have no identity-free enforcement');
  assert.equal(jobIdToken(guard, code), false, '`wif-pr-reachability` must hold no id-token');
  assert.equal(usesCloudAuth(guard), false, '`wif-pr-reachability` must not authenticate');
  assert.match(guard.text, /node --test test\/wif-pr-reachability\.test\.js/,
    '`wif-pr-reachability` no longer runs this guard — nothing would enforce rule 2 on a PR');

  const unitTest = jobsOf(code).find((j) => j.name === 'test');
  assert.ok(unitTest, '`test` job (the real npm test suite) is gone');
  assert.equal(jobIdToken(unitTest, code), false, '`test` must hold no id-token');
});

test('preview.yml has NO pull_request trigger, and holds the deploy behind a verified dispatch', () => {
  // ⚠️ This is the STRUCTURAL control, and it is why the deploy is not simply
  // gated by an `if:` inside a pull_request-triggered file. On a same-repo
  // `pull_request`, GitHub evaluates the workflow file FROM THE PR HEAD, so a PR
  // adding (or never carrying) that guard runs the deploy job as itself, with the
  // staging identity. A gate a PR can edit is not a gate against a PR.
  const code = codeOf['preview.yml'];
  const t = triggersOf(code);
  assert.ok(!t.includes('pull_request') && !t.includes('pull_request_target'),
    `preview.yml gained a PR trigger (${t.join(',')}) — that re-opens card vpukxEgQ`);
  assert.deepEqual(t, ['workflow_dispatch'], 'preview.yml must be dispatch-only');

  const deploy = jobsOf(code).find((j) => j.name === 'deploy');
  assert.ok(deploy, '`deploy` job is gone');
  assert.match(deploy.text, /^ {4}permissions:/m, '`deploy` must declare its own permissions block');
  assert.equal(jobIdToken(deploy, code), true, '`deploy` needs id-token to authenticate');
  assert.ok(!/^permissions:[\s\S]*?^ {2}id-token:/m.test(code),
    'id-token must be job-level here too, so a future job in this file does not inherit it');
});

test('preview.yml verify-pr is a VERIFIED dispatch gate, and holds no identity', () => {
  const code = codeOf['preview.yml'];
  const verify = jobsOf(code).find((j) => j.name === 'verify-pr');
  assert.ok(verify, 'verify-pr is gone — nothing checks the PR before the identity job runs');
  assert.equal(jobIdToken(verify, code), false, 'verify-pr must hold NO id-token');
  assert.equal(usesCloudAuth(verify), false, 'verify-pr must not authenticate');

  // The refusals ARE the mechanism. `strip()` removes full-line comments first,
  // so prose describing a check cannot satisfy these. Gate names measured LIVE
  // via `gh api .../check-runs` on a real main-targeted PR head — "test" (ci.yml's
  // job KEY) and "Lint workflow files" (ci.yml's `workflows` job, name: override).
  for (const [re, what] of [
    [/\$STATE"\s*=\s*"open"/, 'the PR is open'],
    [/\$HEAD_REPO"\s*=\s*"\$GITHUB_REPOSITORY"/, 'the head is same-repo (not a fork)'],
    [/\$HEAD_SHA"\s*=\s*"\$WANT_SHA"/, 'the live head still equals the dispatched sha'],
    [/for NEED in "test" "Lint workflow files"; do/, 'BOTH PR gates must be checked'],
    [/\$CONC"\s*=\s*"success"/, 'the named gate is green on that sha'],
  ]) assert.match(verify.text, re, `verify-pr no longer refuses on: ${what}`);

  const deploy = jobsOf(code).find((j) => j.name === 'deploy');
  assert.match(deploy.text, /ref: \$\{\{ needs\.verify-pr\.outputs\.head_sha \}\}/,
    'the deploy job must check out the VERIFIED sha, never the moving branch');
});

test('deploy.yml (staging) and deploy-realapp.yml (prod) are unchanged: no pull_request trigger', () => {
  for (const f of ['deploy.yml', 'deploy-realapp.yml']) {
    const t = triggersOf(codeOf[f]);
    assert.ok(!t.includes('pull_request') && !t.includes('pull_request_target'),
      `${f} gained a pull_request trigger — that is a much bigger problem than this card`);
  }
});

// G3 trap: `firebase hosting:channel:deploy` without `--no-authorized-domains`
// PATCHes opsagent-staging's Identity Platform `authorizedDomains` on every
// deploy (QR5Q8Hyk / training-console#18, kaflon/vPrDDPM3, claudeservices-site/
// I4pW1Oh8 all closed the same class). This repo submits the deploy via Cloud
// Build (cloudbuild-preview.yaml), so the guard reads that file, not the workflow.
function authDomainSyncs(code) {
  const joined = code.replace(/\\\n\s*/g, ' ');
  const found = [];
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    // Skip echo'd PROSE mentioning the command name (e.g. a log-message string) —
    // this file logs "== Firebase hosting:channel:deploy ... ==" for humans, which
    // is not an invocation and must not count as one.
    if (/^echo\b/.test(line)) continue;
    if (/hosting:channel:(deploy|create|delete)\b/.test(line) && !/--no-authorized-domains\b/.test(line)) {
      found.push(line);
    }
    if (/identitytoolkit|authorizedDomains/i.test(line)) found.push(line);
  }
  return found;
}

test('cloudbuild-preview.yaml: no channel deploy syncs Firebase Auth authorizedDomains', () => {
  const fs = require('node:fs');
  const text = strip(fs.readFileSync(path.join(REPO, 'cloudbuild-preview.yaml'), 'utf8'));
  assert.deepEqual(authDomainSyncs(text), []);
});

test('RED-FIRST: a channel deploy missing --no-authorized-domains is a violation', () => {
  const missing = 'npx -y firebase-tools@15.21.0 hosting:channel:deploy "pr-${_PR_NUMBER}" --only rapid-site-builder --project opsagent-staging --expires 7d --json --non-interactive';
  assert.equal(authDomainSyncs(missing).length, 1, 'fixture must trip the guard — this is the exact pre-fix line');
});

test('RED-FIRST: the pre-fix shape is detected as a violation', () => {
  // The exact shape on main before this card: one job, workflow-level id-token,
  // pull_request only, NO if: guard at all, secrets-sourced provider and SA.
  const OLD = strip(`
name: PR Preview
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
  id-token: write
  pull-requests: write
jobs:
  preview:
    runs-on: [self-hosted, linux, x64, gcp]
    steps:
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: \${{ secrets.WIF_PROVIDER }}
          service_account: \${{ secrets.WIF_SERVICE_ACCOUNT }}
`);
  assert.ok(triggersOf(OLD).includes('pull_request'), 'fixture must be PR-triggered');
  const preview = jobsOf(OLD).find((j) => j.name === 'preview');
  assert.equal(jobIdToken(preview, OLD), true, 'fixture: preview inherits the workflow-level id-token — the defect');
  assert.equal(usesCloudAuth(preview), true, 'fixture: preview authenticates');
});
