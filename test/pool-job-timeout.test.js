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

/** Jobs of one workflow: {name, pool, timeout}. Reads LIVE lines only (comments never count). */
function parseJobs(text) {
  const jobs = [];
  let inJobs = false;
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // left the jobs: block
    const j = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (j) { cur = { name: j[1], pool: false, timeout: null }; jobs.push(cur); continue; }
    if (!cur) continue;
    if (/^    runs-on:.*self-hosted/.test(line)) cur.pool = true;
    const t = line.match(/^    timeout-minutes:\s*(\d+)\s*(?:#.*)?$/);
    if (t) cur.timeout = Number(t[1]);
  }
  return jobs;
}

test('KNOWN-POSITIVE: the pre-fix deploy-engine shape reads as an unbounded pool job', () => {
  const pre = 'jobs:\n  deploy-engine:\n    runs-on: [self-hosted, linux, x64, gcp]\n    steps:\n      - run: x\n';
  assert.deepEqual(parseJobs(pre), [{ name: 'deploy-engine', pool: true, timeout: null }]);
});

test('a comment that mentions timeout-minutes does not count as one', () => {
  const t = 'jobs:\n  a:\n    runs-on: [self-hosted]\n    # timeout-minutes: 5\n';
  assert.equal(parseJobs(t)[0].timeout, null);
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
