'use strict';
/*
 * Card 8itdTRtX — the deploy rails must be SCHEDULABLE.
 *
 * This repo is public. Every org runner group has allows_public_repositories=false,
 * so GitHub never routes a public repo's job to the self-hosted pool: PROD dispatch
 * 36812000483 (deploy-realapp.yml, 2026-10-01) sat queued with no runner until it was
 * cancelled. Nothing was red — a job that never starts fails no check. The CTO ruling:
 * do not flip the flag (it keeps fork-PR code off the pool that holds prod
 * identities); run the deploy jobs on GitHub-hosted runners instead.
 *
 * So this pins, per job, that deploy-realapp.yml and deploy.yml run on ubuntu-latest,
 * and that moving runners did not loosen the two things that made the pool pin look
 * "safer": the trigger set and the ref guard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');

/** `runs-on:` values of every job, read off LIVE lines only (comments never count). */
function runsOn(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s+runs-on:\s*(.+?)\s*(?:#.*)?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Top-level keys under `on:` (the trigger set). */
function triggers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(start, -1, 'workflow has an `on:` block');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(/^  ([a-z_]+):/);
    if (m) out.push(m[1]);
  }
  return out;
}

const EXPECT = { 'deploy-realapp.yml': 1, 'deploy.yml': 3 };

for (const [file, jobs] of Object.entries(EXPECT)) {
  test(`${file}: every job runs on ubuntu-latest — a pool-pinned job in a public repo is never scheduled`, () => {
    const got = runsOn(read(file));
    assert.equal(got.length, jobs, `${file} should have ${jobs} runs-on line(s), found ${got.length} — a new job must be added here deliberately`);
    for (const v of got) assert.equal(v, 'ubuntu-latest', `${file} has a job on "${v}"`);
  });
}

test('RED-FIRST: the parser sees the pre-fix pool pin, and ignores a commented one', () => {
  const OLD = 'jobs:\n  deploy:\n    runs-on: [self-hosted, linux, x64, gcp]\n';
  assert.deepEqual(runsOn(OLD), ['[self-hosted, linux, x64, gcp]']);
  assert.deepEqual(runsOn('jobs:\n  deploy:\n    # runs-on: ubuntu-latest\n    runs-on: [self-hosted, linux, x64, gcp]\n'), ['[self-hosted, linux, x64, gcp]']);
  assert.deepEqual(runsOn('    runs-on: ubuntu-latest  # card 8itdTRtX\n'), ['ubuntu-latest']);
});

test('the runner move did not widen who can start a deploy: no pull_request* trigger on either rail', () => {
  assert.deepEqual(triggers(read('deploy-realapp.yml')), ['workflow_dispatch'], 'PROD stays dispatch-only');
  const staging = triggers(read('deploy.yml'));
  assert.ok(staging.includes('push'), 'deploy.yml still deploys staging on push');
  for (const t of staging) assert.ok(!/^pull_request/.test(t), `deploy.yml must not be PR-triggered (found ${t}) — a hosted runner with WIF must never run fork code`);
});

test('the PROD ref guard still runs BEFORE the WIF auth step on the hosted runner', () => {
  const lines = read('deploy-realapp.yml').split('\n').filter((l) => !/^\s*#/.test(l));
  // Two spellings of the same step: main's copy is "Refuse any ref that is not on the
  // real-app line" (LEBxGF5d), real-app's is "Refuse a dispatch on any ref that is not
  // on the deploy line" (22I0yUum / eKfog19I). The ancestry merge (0M55jnpF) carries
  // real-app's; deploy-ref-policy.test.js already accepts both. Pin the ORDER, not the name.
  const guard = lines.findIndex((l) => /- name: Refuse (any|a dispatch on any) ref that is not on the (real-app|deploy) line/.test(l));
  const auth = lines.findIndex((l) => /uses: google-github-actions\/auth@/.test(l));
  assert.ok(guard !== -1 && auth !== -1, 'both steps exist');
  assert.ok(guard < auth, 'the ref guard must precede credential minting');
});
