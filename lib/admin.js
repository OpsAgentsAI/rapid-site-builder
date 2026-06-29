'use strict';
// Admin gate for the cross-tenant "all published sites" view (card fp7wXxjb,
// MSApps mandatory-baseline #1). Two ways to be admin, both env-driven so a
// public clone exposes neither and ships locked-down by default:
//
//   1. a signed-in session whose email is in ADMIN_EMAILS (the Google sign-in
//      allowlist — the primary, browser path), or
//   2. a request carrying `x-admin-key` matching ADMIN_KEY (a WARM_KEY-style
//      header for curl/automation).
//
// Non-admins get 404 (never 403) at the call site, so the admin surface's
// existence is never confirmed to an unauthorized caller.

const DEFAULT_ADMINS = 'michal@opsagents.agency,michal@msapps.mobi';

function adminEmails(env) {
  return String((env || process.env).ADMIN_EMAILS || DEFAULT_ADMINS)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmail(email, env) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && adminEmails(env).includes(e);
}

// Length-guarded, constant-time compare: an unset ADMIN_KEY never matches, and
// equal-length keys are compared without an early-exit timing oracle.
function adminKeyOk(provided, env) {
  const expected = String((env || process.env).ADMIN_KEY || '');
  const got = String(provided == null ? '' : provided);
  if (!expected) return false;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// A session may act as admin ONLY when it carries a VERIFIED email that is on
// the allowlist. email_verified must be strictly `true`: a matching email
// string is not enough, because a Firebase token can present an allowlisted
// email with email_verified:false (e.g. the Email/Password provider). Sessions
// minted before email_verified was plumbed lack the field and are unverified.
function sessionIsAdmin(session, env) {
  return !!(session && session.email_verified === true && isAdminEmail(session.email, env));
}

module.exports = { isAdminEmail, adminKeyOk, adminEmails, DEFAULT_ADMINS, sessionIsAdmin };
