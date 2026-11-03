'use strict';
/**
 * ⚠️ THE DECISION MOVED. This file is now a RE-EXPORT, not an implementation.
 *
 * Card LEBxGF5d (PR #67) shipped the three-way deploy-ref verdict here, for
 * `deploy-realapp.yml`. Card eKfog19I then measured that the same hole is open
 * on `deploy.yml` and `deploy-engine.yml` — 3 of 3 — so the decision now lives
 * in lib/deployRefPolicy.js with the ref it compares against as an argument,
 * and each workflow's expected ref declared once in DEPLOY_REF_POLICY.
 *
 * This file stays so that `deploy-realapp.yml`'s call site and card LEBxGF5d's
 * fifteen tests keep working BYTE-IDENTICALLY: nothing about the PROD guard
 * changed, and a rename would have put a shared decision's blast radius on a
 * card that is already merged and green.
 *
 * 🚫 Do NOT add logic here. A second copy of the ancestry decision is exactly
 * what card eKfog19I exists to prevent, and a test asserts this file declares
 * no function of its own.
 */
const {
  DEPLOY_REF_POLICY,
  EXPECTED_REF,
  refDeployVerdict,
  forbiddenRefsFor,
  parseForbiddenProbes,
} = require('./deployRefPolicy');

module.exports = {
  DEPLOY_REF_POLICY,
  EXPECTED_REF,
  refDeployVerdict,
  forbiddenRefsFor,
  parseForbiddenProbes,
};
