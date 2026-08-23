'use strict';
// Rule #20 has bitten this repo once already, and the guard that caught it only
// catches ONE of the two ways it bites.
//
// `ci.yml` lints every workflow with actionlint+shellcheck, with a shellcheck
// presence check and a true-negative self-test. That guard exists because PR
// #57 hid a `#` comment inside a backslash continuation and TRUNCATED
// `gcloud run deploy` before --set-env-vars (card rFZrx6fL). It is a good
// guard and this file does not duplicate it.
//
// What it cannot see is the other half of rule #20: `--set-env-vars` REPLACES
// the whole env set, so a key that is simply MISSING from the list is deleted
// from the running service on the next deploy — with perfectly valid YAML, a
// perfectly valid shell line, and a green lint. deploy.yml fires on push:main,
// so its first execution is the staging deploy; there is no dry run.
//
// PROVENANCE OF THE PINNED LIST BELOW — measured, not copied from the workflow:
//
//   gcloud run services describe rapid-builder-proxy \
//     --project opsagent-staging --region us-central1 \
//     --format='value(spec.template.spec.containers[0].env)'
//
// run 2026-08-23T08:19Z returned exactly these 14 keys and no others, and no
// secret-backed (valueFrom) entries. So at pin time the workflow's REPLACE list
// and the live service agreed key-for-key. That agreement is what this file
// freezes: after this, dropping a key from deploy.yml is a visible, reviewed
// edit to the pin rather than a silent deletion in production.
//
// TIER NAMING (the names read backwards — say the tier, never the site name):
//   RETIRED     = deploy.yml          job deploy-staging     -> rapid-builder-proxy   + rapid-site-builder(-he)
//   APP-STAGING = deploy.yml          job deploy-app-staging -> rapid-builder-app-stg + rapid-builder-stg
//   PROD        = deploy-realapp.yml                         -> rapid-builder-app     + rapid-site-builder-app
//
// APP-STAGING was added by card rQunsPko. Note what that does to the file-wide
// assertions below: deploy.yml now contains TWO `gcloud run deploy` invocations,
// so a match-anywhere regex can attribute a flag to the wrong tier. Everything
// added for the new tier is therefore scoped to its JOB BLOCK first (see
// jobBlock). The pre-existing STAGING/PROD assertions are left exactly as they
// were — they still hold, because deploy.yml carries exactly one
// --set-env-vars and that one belongs to the retired tier, which is itself now
// an assertion rather than a coincidence.
//
// PROD deliberately uses --update-env-vars (MERGE). Its own header records that
// the line WAS --set-env-vars and had to be changed. Symmetry is the obvious
// "fix" a future reader will reach for, and it is the wrong one — so the merge
// semantics are pinned per tier here, in both directions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const STAGING_WF = path.join(WF, 'deploy.yml');
const PROD_WF = path.join(WF, 'deploy-realapp.yml');

// The canonical STAGING env set. See PROVENANCE above before editing.
const STAGING_ENV_KEYS = [
  'AGENT_ENGINE_RESOURCE',
  'ALLOWED_ORIGINS',
  'CANONICAL_APP_URL',
  'GA4_MEASUREMENT_ID',
  'IMAGE_MODEL',
  'IMAGE_PROJECT',
  'IMAGE_REGION',
  'PUBLIC_BASE_URL',
  'PUBLIC_MEDIA_BASE_URL',
  'PUBLISHED_SITES_BUCKET',
  'RETIRE_UNGATED',
  'SITE_IMAGES_BUCKET',
  'USER_UPLOADS_BUCKET',
  'WARM_KEY',
];

function read(file) {
  const src = fs.readFileSync(file, 'utf8');
  // Vacuity floor. A guard that passes because it read an empty or renamed file
  // is worse than no guard: it reports green on a repo it never inspected.
  assert.ok(src.length > 500, `${path.basename(file)} is suspiciously small — did the path move?`);
  assert.match(src, /gcloud run deploy/, `${path.basename(file)} no longer runs \`gcloud run deploy\``);
  return src;
}

// Pull the argument of a --set-env-vars / --update-env-vars flag, then read the
// KEY= names out of it. gcloud's ^|^ prefix declares | as the delimiter, so the
// values may contain commas (ALLOWED_ORIGINS does) — split on | only.
function envKeysOf(src, flag) {
  const m = src.match(new RegExp(`--${flag}\\s+"([^"]*)"`));
  assert.ok(m, `expected a --${flag} "..." argument`);
  return m[1]
    .split('|')
    .map((tok) => tok.replace(/^\^/, ''))
    .map((tok) => (tok.match(/^([A-Z][A-Z0-9_]*)=/) || [])[1])
    .filter(Boolean)
    .sort();
}

test('STAGING deploy names every env key — --set-env-vars REPLACES (rule #20)', () => {
  const src = read(STAGING_WF);

  const setCount = (src.match(/--set-env-vars\s+"/g) || []).length;
  assert.equal(setCount, 1, 'expected exactly one --set-env-vars argument in the staging deploy');

  const keys = envKeysOf(src, 'set-env-vars');
  assert.deepEqual(
    keys,
    [...STAGING_ENV_KEYS].sort(),
    'the staging --set-env-vars list no longer matches the pinned canonical set. ' +
      'Because --set-env-vars REPLACES, any key dropped here is DELETED from ' +
      'rapid-builder-proxy on the next push to main. Re-measure the live service ' +
      '(see PROVENANCE at the top of this file) and update the pin deliberately.',
  );
});

test('PROD deploy MERGES — --update-env-vars, and never --set-env-vars', () => {
  const src = read(PROD_WF);

  assert.doesNotMatch(
    src,
    /--set-env-vars\s+"/,
    'the prod deploy must not use --set-env-vars: it REPLACES, and this line was ' +
      'already switched to --update-env-vars once after a wipe. Making the two ' +
      'tiers symmetric is the wrong fix.',
  );

  const keys = envKeysOf(src, 'update-env-vars');
  assert.ok(keys.length > 0, 'the prod --update-env-vars list is empty');
  // MERGE semantics mean the prod list is allowed to be a partial set, so its
  // contents are deliberately NOT pinned — only the semantics are.
});

test('the two tiers stay distinguishable — each targets its own service + site', () => {
  const staging = read(STAGING_WF);
  const prod = read(PROD_WF);

  assert.match(staging, /SERVICE:\s*rapid-builder-proxy\b/);
  assert.match(staging, /HOSTING_SITE:\s*rapid-site-builder\s*$/m);
  assert.match(prod, /SERVICE:\s*rapid-builder-app\b/);
  assert.match(prod, /HOSTING_SITE:\s*rapid-site-builder-app\s*$/m);
});

// ── APP-STAGING (card rQunsPko) ─────────────────────────────────────────────

/**
 * The `gcloud run deploy` INVOCATION inside a job, as one logical line.
 *
 * ⚠️ Scoping to the job is not enough, and a probe proved it on this very file:
 * `--min-instances 1` was mutated into the deploy line and the assertion stayed
 * GREEN, because the job's own explanatory comment contains the words
 * `--min-instances 0`. An assertion a COMMENT can satisfy is not an assertion.
 *
 * Comment-stripping alone would fix that one instance. Reading the invocation
 * fixes the class: whole `#` lines go, then the backslash continuations are
 * joined the way bash splices them, so every flag assertion below is about the
 * command that actually runs. The paired control at the bottom of this file
 * proves the difference rather than asserting it.
 */
function runDeploy(block) {
  const code = block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const at = code.indexOf('gcloud run deploy');
  assert.ok(at >= 0, 'no `gcloud run deploy` in this job');
  const lines = code.slice(at).split('\n');
  const parts = [];
  for (const line of lines) {
    const t = line.trim();
    parts.push(t.replace(/\\$/, ''));
    if (!t.endsWith('\\')) break;
  }
  const cmd = parts.join(' ');
  // Vacuity floor: a joiner that stops at the first line yields a `gcloud run
  // deploy <service>` stub on which every "must not contain" assertion passes.
  assert.ok(cmd.length > 300, `the gcloud run deploy invocation joined to ${cmd.length} chars — the joiner is broken, not the workflow`);
  return cmd;
}

/**
 * Slice one job out of a workflow. deploy.yml now runs two tiers, and asserting
 * "the file contains X" cannot tell you WHICH tier X belongs to — the same
 * per-file-vs-per-invocation trap that let a scheduler guard pass on a script
 * whose update branch was missing the flag its create branch had.
 */
function jobBlock(src, jobId) {
  const start = src.indexOf(`\n  ${jobId}:\n`);
  assert.ok(start >= 0, `deploy.yml has no job "${jobId}"`);
  const rest = src.slice(start + 1);
  // The next line at exactly two-space indent that is not a comment ends the job.
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  // Vacuity floor: a slicer that silently returns almost nothing makes every
  // assertion below pass on an empty string.
  assert.ok(block.length > 400, `the "${jobId}" block sliced to ${block.length} chars — the slicer is broken, not the workflow`);
  return block;
}

const APP_STAGING_ENV_KEYS = [
  'AGENT_ENGINE_RESOURCE',
  'ALLOWED_ORIGINS',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'IMAGE_MODEL',
  'IMAGE_PROJECT',
  'IMAGE_REGION',
  'PUBLIC_BASE_URL',
  'PUBLIC_MEDIA_BASE_URL',
  'PUBLISHED_SITES_BUCKET',
  'SITE_IMAGES_BUCKET',
  'USER_UPLOADS_BUCKET',
  'WARM_KEY',
];

test('the single --set-env-vars in deploy.yml belongs to the RETIRED tier, not APP-STAGING', () => {
  // The pinned-list test above matches the FIRST --set-env-vars in the file. That
  // is correct only while there is exactly one and it is the retired tier's.
  // Without this, giving APP-STAGING a --set-env-vars would either be silently
  // attributed to the retired tier or fail with a confusing message about a
  // list that was never edited.
  const src = read(STAGING_WF);
  const retired = jobBlock(src, 'deploy-staging');
  const appStaging = jobBlock(src, 'deploy-app-staging');

  assert.match(runDeploy(retired), /--set-env-vars\s+"/, 'the retired tier lost its --set-env-vars line');
  assert.doesNotMatch(
    runDeploy(appStaging),
    /--set-env-vars\s+"/,
    'APP-STAGING must MERGE (--update-env-vars), never REPLACE. It shares a Cloud ' +
      'Run service with keys edited operationally; --set-env-vars would delete them ' +
      'on the next push to main (rule #20 — it already bit PROD once).',
  );
});

test('APP-STAGING names every env key it needs, and auth cannot silently switch off', () => {
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');
  assert.deepEqual(
    envKeysOf(runDeploy(block), 'update-env-vars'),
    [...APP_STAGING_ENV_KEYS].sort(),
    'the APP-STAGING --update-env-vars list changed. The three that flip auth on ' +
      '(FIREBASE_PROJECT_ID, FIREBASE_API_KEY, plus SESSION_SECRET via --set-secrets) ' +
      'are load-bearing: lib/auth.js computes AUTH_ENABLED from exactly those, so ' +
      'dropping one stands up an UNGATED tier whose deploy still reports success.',
  );
});

test('APP-STAGING takes SESSION_SECRET from Secret Manager, never as an env literal', () => {
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');
  const cmd = runDeploy(block);
  assert.match(
    cmd,
    /--set-secrets\s+"SESSION_SECRET=rapid-builder-session-secret:latest"/,
    'APP-STAGING must bind SESSION_SECRET via --set-secrets.',
  );
  assert.doesNotMatch(
    cmd,
    /\|SESSION_SECRET=/,
    'SESSION_SECRET must never appear in the --update-env-vars list — that would ' +
      'put the session-signing key in the workflow file and in `gcloud run services describe`.',
  );
});

test('APP-STAGING never sets RETIRE_UNGATED — that flag is what makes a surface retired', () => {
  // The one-token failure the retired tier's own comment warns about, arriving
  // from the other direction: setting it HERE produces a "QA tier" that 410s the
  // engine and 301s every page, i.e. one that cannot exercise anything it exists
  // to test, with every check in this workflow still green.
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');
  assert.doesNotMatch(runDeploy(block), /RETIRE_UNGATED=/, 'APP-STAGING must not set RETIRE_UNGATED');
});

test('APP-STAGING holds no warm instance, and promotes traffic', () => {
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');
  assert.match(runDeploy(block), /--min-instances 0\b/, 'a QA tier must not pay for a warm instance (PROD uses 1)');
  assert.doesNotMatch(runDeploy(block), /--min-instances [1-9]/, 'APP-STAGING must not hold a warm instance');
  // Standing Cloud Run trap: `deploy` does not move traffic when a revision pin
  // exists, so a service can accumulate Ready revisions that never serve while
  // every deploy reports green. Both sibling tiers promote explicitly; so must this.
  assert.match(
    block,
    /gcloud run services update-traffic "\$STG_SERVICE" --to-latest/,
    'APP-STAGING must promote traffic explicitly after deploy',
  );
});

test('the THREE tiers stay distinguishable — each targets its own service + site', () => {
  const src = read(STAGING_WF);
  const retired = jobBlock(src, 'deploy-staging');
  const appStaging = jobBlock(src, 'deploy-app-staging');

  assert.match(appStaging, /STG_SERVICE:\s*rapid-builder-app-stg\s*$/m);
  assert.match(appStaging, /STG_HOSTING_SITE:\s*rapid-builder-stg\s*$/m);
  assert.match(appStaging, /--config=cloudbuild-staging-hosting\.yaml/);

  // Each hosting deploy must be SCOPED to its own site, or one tier's Cloud
  // Build overwrites another tier's UI with assets baked to the wrong API base.
  assert.match(retired, /--config=cloudbuild-hosting\.yaml/);
  assert.doesNotMatch(retired, /cloudbuild-staging-hosting\.yaml/);

  const cfg = fs.readFileSync(path.join(__dirname, '..', 'cloudbuild-staging-hosting.yaml'), 'utf8');
  assert.match(cfg, /--only hosting:rapid-builder-stg\b/, 'the APP-STAGING hosting deploy must be scoped to its own site');
  assert.doesNotMatch(
    cfg,
    /--only hosting\s*\\?\s*\n?\s*--project/,
    'an unscoped `--only hosting` here would redeploy PROD and the retired sites too',
  );
  assert.match(cfg, /hosting:sites:create rapid-builder-stg/, 'the site must be created idempotently in-workflow');
});

test('PAIRED CONTROL: the flag assertions read the COMMAND, not the comments', () => {
  // Probe P5 mutated `--min-instances 0` to `1` in the deploy line and the
  // suite stayed green: the job's own comment explaining the choice contains
  // the literal `--min-instances 0`. This pins the fix in both directions
  // rather than trusting that it worked.
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');

  // (a) the comment really does carry the flag text — otherwise this control
  //     passes for the wrong reason and stops protecting anything.
  const commentsOnly = block.split('\n').filter((l) => /^\s*#/.test(l)).join('\n');
  assert.match(
    commentsOnly, /--min-instances 0/,
    'the explanatory comment no longer names the flag — this control is now vacuous; ' +
      'either restore the comment or delete this test deliberately.',
  );

  // (b) and the invocation reader does NOT see it.
  const cmd = runDeploy(block);
  const mutated = cmd.replace('--min-instances 0', '--min-instances 1');
  assert.notStrictEqual(mutated, cmd, 'the flag is not in the invocation at all');
  assert.doesNotMatch(mutated, /--min-instances 0/, 'the invocation still carries the flag after mutation — comments leaked in');
});

test('APP-STAGING fails CLOSED — both smoke steps still assert auth is on', () => {
  // Probe P12 deleted the `"auth":true` grep from the hosting smoke step and the
  // whole suite stayed green. Nothing here executes a workflow step, so this is
  // an assertion that we WROTE the guard, not that it runs — weaker than the
  // flag assertions above, and said plainly rather than dressed up. It is still
  // worth having: without it, AC-4's fail-closed check is one silent deletion
  // away, and the failure it exists for (a deploy that lost FIREBASE_API_KEY or
  // SESSION_SECRET stands up an UNGATED "QA" tier and reports success) is
  // exactly the shape this repo keeps producing.
  const block = jobBlock(read(STAGING_WF), 'deploy-app-staging');

  // Anchor on the two health payloads so a renamed file cannot make this vacuous.
  for (const f of ['/tmp/health-stg.json', '/tmp/health-stg-hosting.json']) {
    assert.ok(block.includes(f), `the APP-STAGING job no longer writes ${f} — this guard is now vacuous`);
    for (const flag of ['"auth":true', '"agentEngine":true']) {
      assert.ok(
        block.includes(`grep -q '${flag}' ${f}`),
        `the APP-STAGING job must assert ${flag} against ${f}. One of the two smoke ` +
          `steps is the Cloud Run URL and the other is the live host; both matter, ` +
          `because Hosting can serve a stale rewrite target.`,
      );
    }
  }

  // And `/` must be asserted 200 against the live host — a 301 there means the
  // tier picked up the retirement redirects, which is the one outcome that would
  // make this whole card pointless while every check stayed green.
  assert.match(
    block,
    /code=\$\(curl -s -o \/dev\/null -w '%\{http_code\}'[^\n]*"\$STG_APP_URL\/"\)/,
    'the APP-STAGING job must probe "/" on the live host and require 200',
  );
});
