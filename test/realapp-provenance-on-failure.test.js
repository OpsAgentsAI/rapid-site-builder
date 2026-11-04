'use strict';
// Card usFFTOul: the PROD provenance step read only the ref guard's outcome, so
// a run whose Cloud Run, traffic or Hosting step FAILED after the guard passed
// still printed "commit : <sha>" and "Pin the URL above together with this
// commit." That is a receipt for a deploy that did not finish.
//
// These tests run the step's real bash body from the workflow file with each
// job status. Nothing here dispatches a workflow or touches a deploy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const WF = path.join(REPO, '.github', 'workflows', 'deploy-realapp.yml');
const STEP = 'Record what this PROD surface was deployed from';
const SHA = '9b5c26289589bc3135ec80d3d435590c409e5dc9';

/** The lines of one named step, from `- name:` up to the next step or the end. */
function stepLines(raw, name) {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => /^\s*- (name|uses):/.test(l));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The body of the step's `run: |` block, de-indented. */
function runBody(raw, name) {
  const lines = stepLines(raw, name);
  if (!lines) return null;
  const runIdx = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (runIdx === -1) return null;
  const indent = lines[runIdx].match(/^\s*/)[0].length + 2;
  const out = [];
  for (const l of lines.slice(runIdx + 1)) {
    if (l.trim() === '') { out.push(''); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join('\n');
}

const raw = fs.readFileSync(WF, 'utf8');
const body = runBody(raw, STEP);

function run(guard, jobStatus) {
  const r = spawnSync('bash', ['-e', '-c', body], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, GUARD: guard, JOB_STATUS: jobStatus, REF_NAME: 'real-app', SHA },
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

test('FLOOR: the step body was extracted, and a missing step reads null', () => {
  assert.ok(body && body.includes('real-app provenance'), `could not extract the run body of "${STEP}"`);
  assert.equal(runBody(raw, 'No Such Step Name'), null);
});

test('the step reads the job status from the workflow, not only the guard', () => {
  const step = stepLines(raw, STEP).join('\n');
  assert.match(step, /JOB_STATUS:\s*\$\{\{\s*job\.status\s*\}\}/);
  assert.match(step, /GUARD:\s*\$\{\{\s*steps\.refguard\.outcome\s*\}\}/);
  assert.match(step, /if:\s*always\(\)/, 'always() must stay: a failed run still needs its record');
});

test('known-positive: a run where every step succeeded prints the receipt', () => {
  const { out, status } = run('success', 'success');
  assert.equal(status, 0, out);
  assert.match(out, new RegExp(`commit\\s*: ${SHA}`));
  assert.match(out, /Pin the URL above together with this commit\./);
  assert.doesNotMatch(out, /RESULT\s*:/);
});

for (const jobStatus of ['failure', 'cancelled']) {
  test(`known-negative: guard passed, job ${jobStatus}: a distinct line and no receipt`, () => {
    const { out, status } = run('success', jobStatus);
    assert.equal(status, 0, `the record itself must not fail the step: ${out}`);
    assert.match(out, new RegExp(`RESULT\\s*: DEPLOY ${jobStatus.toUpperCase()}`));
    assert.match(out, new RegExp(`attempted : ${SHA}`), 'the commit tried is still worth recording');
    assert.doesNotMatch(out, /^commit\s*:/m, 'a commit line reads as a receipt');
    assert.doesNotMatch(out, /Pin the URL/);
    assert.doesNotMatch(out, /ancestry\s*:/);
  });
}

test('a refused run still reads as refused, whatever the job status', () => {
  for (const jobStatus of ['failure', 'success']) {
    const { out, status } = run('failure', jobStatus);
    assert.equal(status, 0, out);
    assert.match(out, /RESULT\s*: REFUSED or NOT RUN/);
    assert.doesNotMatch(out, /DEPLOY (FAILURE|CANCELLED)/);
    assert.doesNotMatch(out, /Pin the URL/);
  }
});
