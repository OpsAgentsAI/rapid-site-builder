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
//   STAGING = deploy.yml       -> rapid-builder-proxy + rapid-site-builder
//   PROD    = deploy-realapp.yml -> rapid-builder-app + rapid-site-builder-app
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
