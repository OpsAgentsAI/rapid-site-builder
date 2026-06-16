# Real-App Surface (auth-ON) — login gate on Publish

Card: VI673sym. Michal's guardrail (2026-06-16): the login gate ships on a
**separate branch + separate URL** so the hackathon submission URL stays
ungated/unrated and unchanged.

## Two surfaces, one codebase

| Surface | Branch | Deploy | Cloud Run | URL | Auth |
|---|---|---|---|---|---|
| Hackathon (submission) | `main` | `deploy.yml` (push→main) | `rapid-builder-proxy` | rapid-site-builder.web.app | **OFF** (dormant, fail-closed) |
| Real app | `real-app` | `deploy-realapp.yml` (manual dispatch) | `rapid-builder-app` | rapid-site-builder-app.web.app | **ON** |

The login-gate code (`lib/auth.js`, the `/api/auth-config` + publish gate in
`server.js`) is already merged to `main` and **dormant** there — it only
activates when `FIREBASE_PROJECT_ID` + `FIREBASE_API_KEY` + `SESSION_SECRET`
are all set (`AUTH_ENABLED` in `lib/auth.js`). `main` never sets them, so the
hackathon URL stays anonymous. This branch's `deploy-realapp.yml` sets all
three, so Publish is gated there.

## Go-live (in order)

1. **Confirm the URL.** Default is `rapid-site-builder-app.web.app`. To use a
   different one, change `HOSTING_SITE` / `APP_URL` / `FIREBASE_AUTH_DOMAIN` /
   `PUBLIC_BASE_URL` / `ALLOWED_ORIGINS` in `deploy-realapp.yml` + the
   `rapid-site-builder-app` site block in `firebase.json` (one place each).
2. **One-time devops (~1 min):**
   - `firebase hosting:sites:create rapid-site-builder-app --project <PROJECT_ID>`
   - Add `rapid-site-builder-app.web.app` as an authorizedDomain for Google
     sign-in on the Identity Platform project (`opsagent-staging`).
   - Confirm the Cloud Run runtime SA holds `secretmanager.secretAccessor` on
     `rapid-builder-session-secret`.
3. **Deploy:** Actions → "Deploy Real App (auth-ON, separate surface)" →
   Run workflow on branch `real-app`. The smoke test asserts
   `/api/health` → `"auth":true` (fail-closed: a deploy that lost the auth env
   fails the gate instead of silently publishing ungated).
4. **Operator QA (irreducible):** one real Google sign-in at
   `rapid-site-builder-app.web.app` → Publish → confirm the site carries
   `ownerUid` and `/api/my-sites` is scoped per user cross-device. The Google
   "verify it's you" wall can't be driven headlessly, so this is a human step.

## Why dispatch-only

`deploy-realapp.yml` has no `push` trigger on purpose: pushing the `real-app`
branch must never auto-stand-up a new prod surface. Standing it up is a
deliberate product launch, gated on step 1's URL confirmation.
