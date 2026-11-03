/**
 * Card i2xV0dn0 — no workflow step may write a FIXED path under /tmp.
 *
 * `gha-runner-1` hosts runner users `runner1..runner5` sharing ONE `/tmp`. A step that
 * writes `/tmp/health.json` creates it owned by whichever runner user drew the job first,
 * mode 644 — and every other user then gets `tee: Permission denied`. Measured 2026-09-21
 * on run 35596712293: both deploy jobs red at the smoke step while `gcloud run deploy`
 * had already SUCCEEDED, so Cloud Run had the new code and Firebase Hosting did not.
 *
 * Three things make this worse than an ordinary red, and they are why this guard exists
 * rather than a one-line fix:
 *
 *  1. It is a LOTTERY on the runner draw. The same commit passes or fails depending on
 *     which user picks it up, so a later green reads as a fix when nothing changed.
 *  2. `curl ... | tee FILE` takes TEE's exit status. Under `bash -e` the step aborts
 *     there — BEFORE the greps — so the fail-closed `"auth":true` assertion that the
 *     step is proud of never executed either.
 *  3. Nothing exercised the rail between the pool migration and 2026-09-21, so it sat
 *     armed for weeks.
 *
 * The fix is to hold the payload in a shell variable: no path, nothing to own, nothing to
 * collide, nothing to clean up. `$RUNNER_TEMP` and `mktemp` are the allowed escapes for a
 * step that genuinely needs a file — both are per-job.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const WF_DIR = path.join(__dirname, '..', '.github', 'workflows')

/** A write to a LITERAL /tmp path. `$RUNNER_TEMP`/`mktemp` are per-job and allowed. */
const FIXED_TMP = /(?:>>?|\btee\b(?:\s+-a)?|\bcurl\b[^\n]*?\s-o|\bmv\b|\bcp\b)\s+["']?\/tmp\/[\w.-]+/

function workflowFiles() {
  return fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
}

function offendingLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*#/.test(line))
    .filter(({ line }) => FIXED_TMP.test(line))
}

test('VACUITY GUARD — workflows exist and really contain shell steps', () => {
  // A scanner that matched nothing would certify whatever it failed to read. Both floors
  // are deliberate: the directory could be renamed, or the read could return empty.
  const files = workflowFiles()
  assert.ok(files.length >= 3, `found only ${files.length} workflow file(s) — the scan is reading the wrong directory`)
  const withRun = files.filter((f) => /run:\s*\|/.test(fs.readFileSync(path.join(WF_DIR, f), 'utf8')))
  assert.ok(withRun.length >= 2, `only ${withRun.length} workflow(s) contain a shell step — nothing to police`)
})

test('VACUITY GUARD — the detector fires on the exact shape that broke run 35596712293', () => {
  // Pinned verbatim. If this stops matching, the guard below is decorative.
  assert.ok(offendingLines('          curl -sf "$URL/api/health" | tee /tmp/health.json').length === 1)
  assert.ok(offendingLines('          echo hi > /tmp/out.txt').length === 1)
  assert.ok(offendingLines('          curl -s -o /tmp/body.json "$URL"').length === 1)
})

test('the allowed per-job escapes are NOT flagged', () => {
  // These are the shapes a step should use when it genuinely needs a file.
  assert.equal(offendingLines('          body=$(mktemp "${RUNNER_TEMP:-/tmp}/probe.XXXXXX")').length, 0)
  assert.equal(offendingLines('          curl -s -o "$RUNNER_TEMP/body.json" "$URL"').length, 0)
  assert.equal(offendingLines('          # curl -sf "$URL" | tee /tmp/health.json  (retired, see card i2xV0dn0)').length, 0)
})

test('NO workflow writes a fixed path under /tmp', () => {
  const findings = []
  for (const f of workflowFiles()) {
    for (const { line, n } of offendingLines(fs.readFileSync(path.join(WF_DIR, f), 'utf8'))) {
      findings.push(`${f}:${n}  ${line.trim()}`)
    }
  }
  assert.deepEqual(
    findings,
    [],
    'a step writes a FIXED /tmp path on a SHARED runner — whichever runner user wrote it ' +
      'first owns it at mode 644 and every other user gets Permission denied, so the step ' +
      'passes or fails on the runner draw (card i2xV0dn0). Hold the payload in a shell ' +
      'variable, or use $RUNNER_TEMP / mktemp if a file is genuinely needed.\n  ' +
      findings.join('\n  '),
  )
})

test('every smoke step that greps a health payload sets pipefail', () => {
  // Without pipefail, `curl -sf ... | tee f` reports TEE's status, so a curl failure
  // surfaces later as a confusing grep miss instead of as the curl failure it is.
  const bad = []
  for (const f of workflowFiles()) {
    const text = fs.readFileSync(path.join(WF_DIR, f), 'utf8')
    for (const block of text.split(/- name: /).slice(1)) {
      if (!/api\/health/.test(block)) continue
      if (!/grep -q/.test(block)) continue
      if (!/set -[a-z]*o?\s*pipefail|set -euo pipefail/.test(block)) {
        bad.push(`${f}: "${block.split('\n')[0].trim()}"`)
      }
    }
  }
  assert.deepEqual(bad, [], `health-smoke step(s) without pipefail:\n  ${bad.join('\n  ')}`)
})
