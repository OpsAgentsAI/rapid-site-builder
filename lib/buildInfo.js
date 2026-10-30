'use strict';
/**
 * WHICH COMMIT THIS DEPLOYMENT SERVES (card mIQXYnxd).
 *
 * The refinement gate's staging leg has to record `staging_sha == merge_sha`,
 * and a stable URL says nothing about which commit is behind it. So the
 * staging rail (.github/workflows/deploy-realapp-staging.yml) writes the full
 * commit SHA it checked out into a `BUILD_COMMIT` file at the repo root,
 * AFTER its ref guard passes and BEFORE `gcloud run deploy --source .`. The
 * file travels into the image with the source; /api/health reports it.
 *
 * Why a FILE and not an env var: `--update-env-vars` MERGES (rule #20), so an
 * env var set by one rail survives a later deploy from a rail that does not set
 * it. deploy.yml also deploys APP-STAGING (main bytes, push:main) and would
 * leave the previous real-app SHA on the service — a health check reporting a
 * commit that is no longer served. A file is rebuilt with every image: a build
 * that did not write it reports `null`, which is the honest answer.
 *
 * The file is never committed (a test pins that). It is not in .gitignore on
 * purpose either: .gcloudignore includes .gitignore, so ignoring it there would
 * also drop it from the upload.
 *
 * Anything that is not exactly 40 lowercase hex characters reads as `null`, so
 * a stray or truncated file can never be reported as a commit.
 */
const fs = require('fs');
const path = require('path');

const BUILD_COMMIT_FILE = path.join(__dirname, '..', 'BUILD_COMMIT');

function readBuildCommit(file = BUILD_COMMIT_FILE) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = { BUILD_COMMIT_FILE, readBuildCommit, BUILD_COMMIT: readBuildCommit() };
