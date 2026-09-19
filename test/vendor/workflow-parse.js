/**
 * Shared, FAIL-CLOSED parsers for `.github/workflows/*.yml`.
 *
 * Vendored (CommonJS port — this repo's test suite is CommonJS, `node --test
 * test/*.test.js`, no `"type": "module"`) from `OpsAgentsAI/msapps-lead-pipeline`
 * `scripts/lib/workflow-parse.mjs` (card uHaeFibd), where it was extracted from
 * that repo's runner-routing contract. Used here by
 * `test/wif-pr-reachability.test.js` (card vpukxEgQ, following the same fix
 * already shipped today on kaflon/vPrDDPM3, kaflon-app/ORs73Kc6,
 * msapps-lead-pipeline/uHaeFibd and claudeservices-site/I4pW1Oh8).
 *
 * ⚠️ This is a COPY across repos, which is the thing the note below argues against
 * WITHIN a repo. It is deliberate: there is no shared package between these repos
 * today, and the alternative — re-deriving the matchers per repo — is strictly
 * worse. If a third repo needs it, that is the signal to publish it properly
 * rather than to vendor it a third time.
 *
 * ⚠️ Why extraction rather than a second copy: these matchers encode findings
 * that were expensive to learn — `permissions: write-all` is a SCALAR grant of
 * id-token that a block-mapping matcher never sees; a job-level `permissions:`
 * block WINS over the workflow's, so "the workflow has no id-token" is not an
 * answer about a job. A forked copy keeps whichever of those it was born with
 * and silently stops learning, which is how a guard starts certifying the shape
 * it was written to refuse.
 *
 * The repo has no YAML dependency on purpose (nothing else needs one), so these
 * are line-anchored regexes over the raw file. They assume the 2-space job /
 * 4-space job-key / 6-space job-permission indentation that every workflow here
 * uses, and `yamllint`-style reindentation would defeat them — which is why the
 * tests that consume these also assert the shapes they expect to find, so a
 * parser that suddenly matches NOTHING fails loudly instead of passing vacuously.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Drop FULL-LINE comments so prose cannot satisfy a pin; keep trailing comments
 *  (that is where markers like `# HOSTED BY DECISION` legitimately live). */
const strip = (raw) =>
  raw.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const workflowDir = (repoRoot) => path.join(repoRoot, '.github', 'workflows');

const workflowFiles = (repoRoot) =>
  fs.readdirSync(workflowDir(repoRoot)).filter((f) => /\.ya?ml$/.test(f)).sort();

const load = (repoRoot, file) =>
  strip(fs.readFileSync(path.join(workflowDir(repoRoot), file), 'utf8'));

/** Every top-level job as `{ name, text }`, text running to the next job head. */
const jobsOf = (code) => {
  const m = /^jobs:[ \t]*(?:#.*)?$/m.exec(code);
  if (!m) return [];
  const body = code.slice(m.index + m[0].length + 1);
  const re = /^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/gm;
  const heads = [];
  let h;
  while ((h = re.exec(body))) heads.push({ name: h[1], idx: h.index });
  return heads.map((x, i) => ({
    name: x.name,
    text: body.slice(x.idx, i + 1 < heads.length ? heads[i + 1].idx : undefined),
  }));
};

/** Workflow-level `id-token: write`, including the `write-all` scalar form. */
const wfIdToken = (code) =>
  /^permissions:[ \t]*write-all[ \t]*$/m.test(code) ||
  /^permissions:[^\n]*\n(?: {2}.*\n)*? {2}id-token: write/m.test(code);

/** Effective `id-token: write` for a job: a job-level block WINS over the workflow's. */
const jobIdToken = (job, code) =>
  /^ {4}permissions:/m.test(job.text)
    ? /^ {4}permissions:[ \t]*write-all[ \t]*$/m.test(job.text) ||
      /^ {4}permissions:[^\n]*\n(?: {6}.*\n)*? {6}id-token: write/m.test(job.text)
    : wfIdToken(code);

/** IDENTITY, not mentions: what GCP identity does this job ASSUME? */
const IDENTITY_LINE =
  /^\s*(?:service_account|workload_identity_provider|credentials_json):.*$|--(?:impersonate-service-account|account)[= ]\S+/gm;

const identityLines = (job) => job.text.match(IDENTITY_LINE) || [];

/** Does the job run a cloud-auth action at all? */
const usesCloudAuth = (job) =>
  /uses:\s*google-github-actions\/auth@/.test(job.text) ||
  /uses:\s*aws-actions\/configure-aws-credentials@/.test(job.text) ||
  /uses:\s*azure\/login@/.test(job.text);

/** The `on:` block of a workflow, as raw text (empty string if absent). */
const onBlock = (code) => {
  const m = /^on:[ \t]*(?:\n)/m.exec(code) || /^on:.*$/m.exec(code);
  if (!m) return '';
  const rest = code.slice(m.index + m[0].length);
  const end = /^[A-Za-z]/m.exec(rest);
  return rest.slice(0, end ? end.index : undefined);
};

/** Trigger names declared by a workflow, e.g. ['pull_request','workflow_dispatch']. */
const triggersOf = (code) => {
  const block = onBlock(code);
  const inline = /^on:[ \t]*\[(.+)\][ \t]*$/m.exec(code);
  if (inline) return inline[1].split(',').map((s) => s.trim());
  const flat = /^on:[ \t]*([a-z_]+)[ \t]*$/m.exec(code);
  if (flat) return [flat[1]];
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m2) => m2[1]);
};

/** Workflow names referenced by a `workflow_run:` trigger (the indirect-reach edge). */
const workflowRunParents = (code) => {
  const block = onBlock(code);
  const m = /^ {2}workflow_run:[\s\S]*?^ {4}workflows:[ \t]*\[(.+?)\]/m.exec(block);
  if (m) return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  const listed = /^ {2}workflow_run:[\s\S]*?^ {4}workflows:[ \t]*\n((?: {6}- .*\n)+)/m.exec(block);
  if (listed) return listed[1].split('\n').filter(Boolean).map((l) => l.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, ''));
  return [];
};

/** The `name:` a workflow declares (what a `workflow_run:` parent list refers to). */
const workflowName = (code) => (/^name:[ \t]*(.+?)[ \t]*$/m.exec(code) || [])[1] || null;

module.exports = {
  strip, workflowDir, workflowFiles, load, jobsOf, wfIdToken, jobIdToken,
  IDENTITY_LINE, identityLines, usesCloudAuth, onBlock, triggersOf,
  workflowRunParents, workflowName,
};
