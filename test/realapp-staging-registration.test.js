'use strict';
/*
 * Card Ese6i9Ke — main's copy of deploy-realapp-staging.yml can never deploy
 * main bytes or touch any tier.
 *
 * GitHub registers (and accepts `gh workflow run` for) a workflow_dispatch-only
 * workflow only when a file of that path exists on the default branch. The rail
 * itself lives on `real-app` (card mIQXYnxd), so main carries a REGISTRATION
 * STUB at the same path. A dispatch runs the dispatched ref's copy: on real-app
 * the rail runs; on main, or any branch cut from main, the stub runs. This file
 * pins that the stub refuses every ref before it could reach a credential.
 *
 * BRANCH-AWARE ON PURPOSE. When main is next merged into real-app this test
 * arrives there too, next to real-app's full rail. Which branch it is on is
 * read from lib/deployRefPolicy.js, not guessed from the workflow text:
 *   - no `deploy-realapp-staging.yml` policy row (main today) -> the file MUST
 *     be the stub, and every stub invariant below applies;
 *   - a row (real-app) -> the file is the rail, and that row must refuse the
 *     main line. Either way, main's bytes are refused.
 * A byte-identical copy of the rail on main fails here (no row on main), and so
 * does it in test/deploy-ref-policy.test.js (a dispatchable deploy workflow
 * without a policy row).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { strip, jobsOf, triggersOf, onBlock, workflowName, wfIdToken, jobIdToken, usesCloudAuth } =
  require('./vendor/workflow-parse.js');
const { DEPLOY_REF_POLICY } = require('../lib/deployRefPolicy');

const REPO = path.join(__dirname, '..');
const FILE = 'deploy-realapp-staging.yml';
const RAW = fs.readFileSync(path.join(REPO, '.github', 'workflows', FILE), 'utf8');
const CODE = strip(RAW);
const ROW = DEPLOY_REF_POLICY[FILE];
const IS_STUB_BRANCH = !ROW;

// Same verb list test/deploy-ref-policy.test.js discovers deploy workflows by,
// plus the credential and env-mutation surfaces a deploy needs.
const DEPLOY_VERBS =
  /gcloud run deploy|gcloud builds submit|firebase deploy|deploy_agent_engine\.py|hosting:channel:deploy/;

/** The `run:` block of a step, de-indented, as bash would receive it. */
function runBlock(stepText) {
  const lines = stepText.split('\n');
  const i = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.ok(i >= 0, 'step has no `run: |` block');
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    if (!/^ {10}/.test(l)) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

/** Steps of a job as raw text chunks, split on `      - ` heads. */
function stepsOf(jobText) {
  const m = /^ {4}steps:[ \t]*$/m.exec(jobText);
  if (!m) return [];
  const body = jobText.slice(m.index + m[0].length + 1);
  return body.split(/^(?= {6}- )/m).filter((s) => /^ {6}- /.test(s));
}

/** Run the refusal exactly as the runner would: bash -e, env from the step. */
function execRefusal(refName) {
  const job = jobsOf(CODE)[0];
  const script = runBlock(stepsOf(job.text)[0]);
  return spawnSync('bash', ['-e', '-c', script], {
    env: { PATH: process.env.PATH, REF_NAME: refName },
    encoding: 'utf8',
  });
}

test('the file exists on this branch (main registers it for dispatch — AC1)', () => {
  assert.ok(RAW.length > 0);
  assert.equal(workflowName(CODE), 'Stage Real App (APP-STAGING, dispatch-only)');
  assert.deepEqual(triggersOf(CODE), ['workflow_dispatch'], 'dispatch-only, on every branch');
});

test('it accepts the same `sha` input as real-app\'s rail, so `-f sha=` reaches the guard', () => {
  assert.match(onBlock(CODE), /^ {4}inputs:\n {6}sha:\n/m);
});

// ── main: the registration stub ────────────────────────────────────────────

test('STUB: no checkout, no action, no credential, no secret, no deploy verb', { skip: !IS_STUB_BRANCH && 'real-app: the rail is policed by test/realapp-staging-rail.test.js' }, () => {
  assert.doesNotMatch(CODE, /^\s*-?\s*uses:/m, 'the stub runs no action at all (no checkout, no auth)');
  assert.doesNotMatch(CODE, /\$\{\{\s*(secrets|vars)\./, 'the stub reads no secret or variable');
  assert.doesNotMatch(CODE, DEPLOY_VERBS, 'the stub carries no deploy verb');
  assert.doesNotMatch(CODE, /\bgcloud\b|\bfirebase\b|\bcurl\b|\bgit\b|\bnode\b|\bnpm\b/, 'the stub calls no tool that could reach a tier');
  assert.doesNotMatch(CODE, /--set-|--update-/, 'no Cloud Run env/secret flag of any kind');
  assert.doesNotMatch(CODE, /id-token/, 'no OIDC token can be minted');
  assert.doesNotMatch(CODE, /^\s*concurrency:/m,
    'no concurrency group: joining `deploy` would let a refused stub run cancel a queued deploy.yml run');
});

test('STUB: workflow permissions are empty and no job widens them', { skip: !IS_STUB_BRANCH }, () => {
  assert.match(CODE, /^permissions:[ \t]*\{\}[ \t]*$/m);
  const jobs = jobsOf(CODE);
  assert.equal(jobs.length, 1, 'exactly one job');
  for (const job of jobs) {
    assert.doesNotMatch(job.text, /^ {4}permissions:/m, `${job.name} declares its own permissions`);
    assert.equal(jobIdToken(job, CODE), false);
    assert.equal(usesCloudAuth(job), false);
  }
  assert.equal(wfIdToken(CODE), false);
});

test('STUB: one job, one step, hosted, bounded', { skip: !IS_STUB_BRANCH }, () => {
  const [job] = jobsOf(CODE);
  assert.match(job.text, /^ {4}runs-on:[ \t]*ubuntu-latest[ \t]*$/m);
  assert.match(job.text, /^ {4}timeout-minutes:[ \t]*\d+[ \t]*$/m);
  assert.doesNotMatch(job.text, /^ {4}if:/m, 'the job has no condition that could skip the refusal');
  const steps = stepsOf(job.text);
  assert.equal(steps.length, 1, 'exactly one step: the refusal');
  assert.doesNotMatch(steps[0], /^ {8}if:/m, 'the refusal step is unconditional');
  assert.doesNotMatch(steps[0], /continue-on-error/, 'the refusal cannot be downgraded to a warning');
});

test('STUB: executed, the refusal exits non-zero on main, real-app and a card branch (AC3/AC4)', { skip: !IS_STUB_BRANCH }, () => {
  for (const ref of ['main', 'real-app', 'card/x-unmerged', '']) {
    const r = execRefusal(ref);
    assert.notEqual(r.status, 0, `ref "${ref}": the stub must refuse`);
    assert.match(r.stdout, /::error::REFUSED/, `ref "${ref}": the refusal must say REFUSED`);
    assert.match(r.stdout, /--ref real-app/, `ref "${ref}": the refusal names the ref that runs the rail`);
  }
  // A stub running ON real-app means a merge overwrote the rail: say so.
  assert.match(execRefusal('real-app').stdout, /overwrote real-app's rail/);
  assert.doesNotMatch(execRefusal('main').stdout, /overwrote real-app's rail/);
});

test('STUB: the ref name reaches the shell through env, never inline `${{ }}`', { skip: !IS_STUB_BRANCH }, () => {
  const [job] = jobsOf(CODE);
  assert.doesNotMatch(runBlock(stepsOf(job.text)[0]), /\$\{\{/);
});

test('STUB: the stub is not discovered as a dispatchable deploy workflow (needs no policy row)', { skip: !IS_STUB_BRANCH }, () => {
  // Pinned against lib/deployRefPolicy.js directly: main has no row for this
  // file, and a row would be stale on main (test/deploy-ref-policy.test.js).
  assert.equal(DEPLOY_REF_POLICY[FILE], undefined);
});

test('STUB: real-app still carries the rail this stub registers (when origin/real-app is fetched)', { skip: !IS_STUB_BRANCH }, (t) => {
  let theirs;
  try {
    theirs = execFileSync('git', ['show', `origin/real-app:.github/workflows/${FILE}`], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    t.skip('origin/real-app is not fetched here (shallow or offline checkout)');
    return;
  }
  const code = strip(theirs);
  assert.equal(workflowName(code), workflowName(CODE), 'both copies register under one name');
  assert.deepEqual(triggersOf(code), ['workflow_dispatch']);
  assert.match(onBlock(code), /^ {4}inputs:\n {6}sha:\n/m, 'the input this stub mirrors still exists on the rail');
  assert.match(code, /DEPLOY_REF_POLICY\['deploy-realapp-staging\.yml'\]/,
    'the rail on real-app reads its own policy row — its deploy-line guard');
  assert.notEqual(theirs, RAW, 'real-app must carry the rail, not this stub');
});

// ── real-app (after a main -> real-app merge): the rail ─────────────────────

test('RAIL: on the branch that has a policy row, the row refuses the main line', { skip: IS_STUB_BRANCH && 'main: no policy row, the stub tests above apply' }, () => {
  assert.equal(ROW.expectedRef, 'real-app');
  assert.ok(ROW.mustNotBeAncestorOf.includes('main'), 'main bytes must be refused by the rail');
  assert.match(CODE, /DEPLOY_REF_POLICY\['deploy-realapp-staging\.yml'\]/, 'the rail reads its policy row');
});
