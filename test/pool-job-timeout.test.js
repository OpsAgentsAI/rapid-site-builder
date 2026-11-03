'use strict';
/*
 * Card mwHId6GR (finding from I1Q07i8w, rapid-site-builder#91 review 5247485194):
 * a job on the self-hosted pool must declare timeout-minutes. Without one the job can
 * hold a shared runner, and the WIF identity it authenticated, for GitHub's 6 h default.
 *
 * Known-positive: parseJobs() applied to the pre-fix deploy-engine.yml shape reports the
 * job as unbounded. Every workflow file is checked, so a NEW pool job cannot slip in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');

// ONE parser and ONE pool predicate for the whole repo (65pcQtze rework): the job
// split is the vendored workflow parser (#92) and "is this a pool job" is the same
// runsOnPool that test/pool-node-setup.test.js audits with. This file used to carry
// its own line walker whose `jobs:` / job-head regexes rejected a trailing comment,
// so a pool job written `  deploy:  # note` was never checked for a timeout.
const { strip, jobsOf } = require('./vendor/workflow-parse.js');
const { runsOnPool } = require('../lib/poolNodeRuntime');

/** Jobs of one workflow: {name, pool, timeout}. Reads LIVE lines only (comments never count). */
function parseJobs(text) {
  return jobsOf(strip(text)).map((job) => {
    const t = /^    timeout-minutes:[ \t]*(\d+)[ \t]*(?:#.*)?$/m.exec(job.text);
    return { name: job.name, pool: runsOnPool(job), timeout: t ? Number(t[1]) : null };
  });
}

test('KNOWN-POSITIVE: the pre-fix deploy-engine shape reads as an unbounded pool job', () => {
  const pre = 'jobs:\n  deploy-engine:\n    runs-on: [self-hosted, linux, x64, gcp]\n    steps:\n      - run: x\n';
  assert.deepEqual(parseJobs(pre), [{ name: 'deploy-engine', pool: true, timeout: null }]);
});

test('a comment that mentions timeout-minutes does not count as one', () => {
  const t = 'jobs:\n  a:\n    runs-on: [self-hosted]\n    # timeout-minutes: 5\n';
  assert.equal(parseJobs(t)[0].timeout, null);
});

test('REGRESSION: a trailing comment on `jobs:` or a job head does not hide a pool job', () => {
  const t = 'jobs:  # all\n  deploy:  # note\n    runs-on: [self-hosted, linux, x64, gcp]\n    steps:\n      - run: x\n';
  assert.deepEqual(parseJobs(t), [{ name: 'deploy', pool: true, timeout: null }]);
  // CONTROL: a hosted job whose comment mentions the pool is not a pool job.
  const hosted = 'jobs:\n  deploy:\n    runs-on: ubuntu-latest  # was self-hosted\n';
  assert.deepEqual(parseJobs(hosted), [{ name: 'deploy', pool: false, timeout: null }]);
});

test('every self-hosted pool job in every workflow declares a sane timeout-minutes', () => {
  const files = fs.readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));
  const seen = [];
  for (const f of files) {
    for (const j of parseJobs(fs.readFileSync(path.join(WF, f), 'utf8'))) {
      if (!j.pool) continue;
      seen.push(`${f}:${j.name}`);
      assert.ok(j.timeout !== null, `${f} job ${j.name} runs on the pool with no timeout-minutes`);
      assert.ok(j.timeout > 0 && j.timeout <= 60, `${f} job ${j.name} timeout-minutes ${j.timeout} outside 1..60`);
    }
  }
  // liveness control: the walk must actually have seen the pool jobs this card is about
  assert.ok(seen.includes('deploy-engine.yml:deploy-engine'), seen.join(','));
  assert.ok(seen.includes('preview.yml:deploy'), seen.join(','));
});
