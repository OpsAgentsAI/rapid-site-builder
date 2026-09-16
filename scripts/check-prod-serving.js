#!/usr/bin/env node
'use strict';
/**
 * Runs lib/prodServing.js against the REAL deploy history and reports GAP B.
 * Card 65pcQtze. Driven by .github/workflows/prod-serving-alarm.yml.
 *
 * Deliberately a SEPARATE script and a SEPARATE workflow from the divergence
 * alarm (card 65pcQtze AC-2): folding gap B into gap A's red reproduces exactly
 * the state that hid a 29-day prod gap — one red that means two things and
 * therefore means neither.
 *
 * Reads only the GitHub REST API with the job token — no prod fetch, no engine
 * call, no secret. It never touches /api/build or /api/publish.
 *
 * Exit 0 = CURRENT or WITHIN_BUDGET · 1 = STALE · 2 = UNKNOWN (could not measure).
 *
 *   node scripts/check-prod-serving.js [--budget-days N]
 *   env: GITHUB_REPOSITORY (owner/name), GH_TOKEN or GITHUB_TOKEN
 */

const fs = require('node:fs');
const { DEFAULT_BUDGET_DAYS, classifyProdServing, exitCodeFor } = require('../lib/prodServing');

const WORKFLOW = 'deploy-realapp.yml';
const TARGET = 'real-app';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

async function gh(repo, token, path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function measure(repo, token) {
  // Last SUCCESSFUL run only: a failed dispatch did not change what prod serves.
  const runs = await gh(repo, token, `actions/workflows/${WORKFLOW}/runs?status=success&per_page=1`);
  const run = (runs.workflow_runs || [])[0] || null;
  const deployedSha = run ? run.head_sha : null;

  const head = await gh(repo, token, `branches/${TARGET}`);
  const headSha = head?.commit?.sha || null;

  let undeployed = null;
  if (deployedSha && headSha && deployedSha !== headSha) {
    const cmp = await gh(repo, token, `compare/${deployedSha}...${headSha}`);
    // compare caps its commit list at 250; ahead_by is the true count. Refuse to
    // judge on a truncated list rather than under-count the undeployed work.
    if (Array.isArray(cmp.commits) && cmp.commits.length < Number(cmp.ahead_by)) {
      throw new Error(`compare returned ${cmp.commits.length} of ${cmp.ahead_by} commits — truncated, refusing to judge`);
    }
    undeployed = [];
    for (const c of cmp.commits || []) {
      // The compare payload's commits carry no file list; read each one.
      const detail = await gh(repo, token, `commits/${c.sha}`);
      undeployed.push({
        sha: c.sha,
        dateISO: c.commit?.committer?.date || null,
        files: (detail.files || []).map((f) => f.filename),
      });
    }
  }
  return { deployedSha, headSha, undeployed, runAt: run ? run.run_started_at || run.created_at : null };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const budgetRaw = arg('budget-days');
  const budgetDays = budgetRaw === undefined ? DEFAULT_BUDGET_DAYS : Number(budgetRaw);

  let m;
  try {
    if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN/GITHUB_TOKEN are required');
    m = await measure(repo, token);
  } catch (e) {
    m = { deployedSha: null, headSha: null, undeployed: null, error: e.message };
  }

  const r = classifyProdServing({ ...m, nowISO: new Date().toISOString(), budgetDays });
  const lines = [
    `### Prod-serving alarm — GAP B (real-app -> what production serves)`,
    '',
    `- **status:** \`${r.status}\``,
    `- **deployed head** (last successful \`${WORKFLOW}\`): \`${m.deployedSha ? m.deployedSha.slice(0, 8) : 'none'}\`${m.runAt ? ` at ${m.runAt}` : ''}`,
    `- **real-app head:** \`${m.headSha ? m.headSha.slice(0, 8) : 'unresolved'}\``,
    `- **undeployed product commits:** ${r.productCommits.length}${r.ageDays !== null ? ` · oldest waiting **${r.ageDays} day(s)**` : ''} · budget ${r.budgetDays} day(s)`,
    `- ${r.reason}`,
  ];
  if (m.error) lines.push(`- ⚠️ measurement error: ${m.error}`);
  lines.push('', '_This is NOT the divergence alarm. Gap A (main -> real-app) is reported separately by divergence-alarm.yml._');
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  if (r.status === 'STALE') console.log(`::error::Production is STALE: ${r.reason}.`);
  if (r.status === 'UNKNOWN') console.log(`::error::Cannot tell whether production is current: ${r.reason}.`);
  process.exit(exitCodeFor(r.status));
}

main();
