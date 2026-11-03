'use strict';
// Card yXnplL83 — the "Measure gap B" job in prod-serving-alarm.yml runs on the
// self-hosted [self-hosted, linux, x64, gcp] pool and shells out to
// `node scripts/check-prod-serving.js`. That pool image has NO node/npm
// (ci.yml's `test` job and divergence-alarm.yml's `check` job both already
// carry the same finding and both already carry `actions/setup-node`). This
// job did not, so every scheduled run failed before measuring anything:
// exit 127 "node: command not found", first seen run 36134275689 — a false
// "cannot tell" reported as silence (no red, no summary), not the real
// gap-B signal this workflow exists to carry.
//
// This test pins ONLY this one job in this one file, deliberately — the repo
// has other self-hosted jobs that shell out to `node -e` without a setup-node
// step (deploy-engine.yml, deploy-realapp.yml, preview.yml's ref-guard,
// deploy.yml's ref-guard), and asserting the class fleet-wide is a different,
// larger card, not this one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workflowFiles, load, jobsOf } = require('./vendor/workflow-parse.js');

const REPO = path.join(__dirname, '..');
const FILE = 'prod-serving-alarm.yml';

test('the workflow corpus still contains prod-serving-alarm.yml (no vacuous pass)', () => {
  assert.ok(
    workflowFiles(REPO).includes(FILE),
    `expected ${FILE} in .github/workflows — the corpus reader has stopped seeing it`,
  );
});

test('prod-serving-alarm.yml "check" job runs setup-node before its node invocation', () => {
  const code = load(REPO, FILE);
  const jobs = jobsOf(code);
  const check = jobs.find((j) => j.name === 'check');
  assert.ok(check, 'expected a "check" job in prod-serving-alarm.yml — job parser has drifted');

  assert.match(
    check.text,
    /run:\s*node\s+scripts\/check-prod-serving\.js/,
    'expected the gap-B measurement step to still shell out to node directly — test has drifted from the file',
  );
  assert.match(
    check.text,
    /uses:\s*actions\/setup-node@v4/,
    'the self-hosted pool has no node/npm preinstalled — this job must run actions/setup-node before invoking node, or every scheduled run fails exit 127 before measuring anything',
  );
});
