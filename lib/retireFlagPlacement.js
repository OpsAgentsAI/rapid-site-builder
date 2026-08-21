'use strict';
// ── Where RETIRE_UNGATED is allowed to live (card 6kf27M5o) ───────────────────
//
// The live check in canonicalLive.js can only fire AFTER a bad deploy has
// already reached production. This one fires on the pull request, which is the
// cheaper place to catch it — the two are deliberately not alternatives.
//
// The rule is a placement rule, not a spelling rule:
//   deploy.yml          (rapid-builder-proxy, the RETIRED hackathon surface)  MUST set it
//   deploy-realapp.yml  (rapid-builder-app,   the CANONICAL product)          MUST NOT
//
// ⚠️ Scoped to the --set-env-vars VALUE, never to the file text. Both files
// explain this rule in prose, and a file-wide ban would red the very comment
// that documents it — whereupon the obvious repair is to delete the comment.
// A key that ships is inside the env literal; an explanation is not.

/** Every `--set-env-vars "<literal>"` value in a workflow file. */
function envVarLiterals(text) {
  const out = [];
  const re = /--set-env-vars\s+"([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Keys declared by one --set-env-vars literal, honouring gcloud's ^|^ delimiter form. */
function envKeys(literal) {
  let body = literal;
  let sep = ',';
  const custom = /^\^(.+?)\^/.exec(literal);
  if (custom) { sep = custom[1]; body = literal.slice(custom[0].length); }
  return body
    .split(sep)
    .map((pair) => pair.split('=')[0].trim())
    .filter(Boolean);
}

function placementFindings(filesByName, { flag = 'RETIRE_UNGATED' } = {}) {
  const findings = [];
  const names = Object.keys(filesByName || {});
  // Vacuity: an empty file map satisfies every rule below by having nothing to
  // check, which is indistinguishable from a clean repo.
  if (names.length < 2) {
    return { broken: true, findings: [`SCAN LOOKS BROKEN, NOT CLEAN: ${names.length} workflow file(s) read, expected at least 2`] };
  }

  const has = (name) => envVarLiterals(filesByName[name] ?? '').some((lit) => envKeys(lit).includes(flag));

  for (const [name, spec] of [['deploy.yml', true], ['deploy-realapp.yml', false]]) {
    if (!(name in filesByName)) {
      findings.push(`SCAN LOOKS BROKEN, NOT CLEAN: ${name} was not read`);
      continue;
    }
    const present = has(name);
    if (spec && !present) {
      findings.push(
        `${name} no longer sets ${flag} in its --set-env-vars literal — the retired hackathon ` +
        `surface will start answering anonymous /api/build again and burning engine spend (card KjHpbn3J).`
      );
    }
    if (!spec && present) {
      findings.push(
        `${name} sets ${flag} in its --set-env-vars literal. That workflow deploys the CANONICAL ` +
        `product: the flag would 410 its own /api/build and 301 / to CANONICAL_APP_URL, which for ` +
        `this service is itself. Every client demo deck closes with that URL.`
      );
    }
  }
  return { broken: findings.some((f) => f.startsWith('SCAN LOOKS BROKEN')), findings };
}

module.exports = { placementFindings, envVarLiterals, envKeys };
