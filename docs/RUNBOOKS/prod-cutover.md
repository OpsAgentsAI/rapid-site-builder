# Production cutover — builder.opsagents.agency (card ns341yIF)

The auth-ON surface (`real-app` branch → Cloud Run `rapid-builder-app` → Firebase
Hosting site `rapid-site-builder-app`) is the canonical product. This runbook
records what the 2026-07-17 cutover created, what watches it, and what remains
operator-only. The hackathon demo surfaces stay live until retirement is
separately verified (no decommission before the replacement is verified).

## Front door

| Piece | Value |
|---|---|
| Canonical domain | `https://builder.opsagents.agency` |
| Hosting site | `rapid-site-builder-app` (project `opsagent-staging`) |
| Origin service | Cloud Run `rapid-builder-app`, `us-central1` (Hosting rewrite `**`) |
| Fallback / previous URL | `https://rapid-site-builder-app.web.app` (stays valid) |

## DNS (Cloud DNS zone `opsagents-agency`, project `opsagent-prod`)

Created 2026-07-17:

```
builder.opsagents.agency.  CNAME  300  rapid-site-builder-app.web.app.
```

The Firebase Hosting `customDomain` (`builder.opsagents.agency` on site
`rapid-site-builder-app`) was created via the Hosting REST API; its
`requiredDnsUpdates` asked for exactly that CNAME. Certificate provisioning is
automatic once Hosting observes the CNAME (typically minutes → up to ~24h).
Check status:

```
GET https://firebasehosting.googleapis.com/v1beta1/projects/opsagent-staging/sites/rapid-site-builder-app/customDomains/builder.opsagents.agency
# healthy end-state: hostState=HOST_ACTIVE, ownershipState=OWNERSHIP_ACTIVE, certState=CERT_ACTIVE
```

## Auth — do NOT touch

`FIREBASE_AUTH_DOMAIN` stays `opsagent-staging.firebaseapp.com`. Pointing it at
the custom domain requires a redirect-URI edit on the auto-provisioned Google
OAuth client that is **console-only** (no API) and 404s sign-in until done —
verified 2026-06-30. Sign-in redirects through `firebaseapp.com` and lands back
on the app; this is correct and intentional.

Never PATCH Identity Platform `authorizedDomains` with an empty or partial
list — the PATCH **replaces** the whole shared array (wipe trap). Adding
`builder.opsagents.agency` to the authorized-domains list is a console
read-modify-write (operator step below).

## Monitoring (project `opsagent-staging`)

| Resource | Name |
|---|---|
| Uptime check | `rsb-app-health` (`uptimeCheckConfigs/rsb-app-health-sbaDoJ3eZAM`) — HTTPS GET `rapid-site-builder-app.web.app/api/health`, every 5 min |
| Alert policy | "RSB app health — uptime failure" (`alertPolicies/17390205511968936217`) — fires after ~10 min of failing checks |
| Notification channel | email → michal@opsagents.agency (`notificationChannels/6977929500789877269`) |

The check targets the stable `web.app` host (never TLS-blocked by the custom
domain's cert lifecycle). `/api/health` also asserts `agentEngine`, buckets,
and `auth:true` — a deploy that silently loses auth env flips the check red.

## Abuse caps (this PR)

| Route | Cap | Env override |
|---|---|---|
| `POST /api/build` | 12/hour per IP (pre-existing) | `BUILDS_PER_HOUR_PER_IP` |
| `POST /api/uploads/sign` | 30/hour per IP + build-budget peek (pre-existing) | `UPLOADS_PER_HOUR_PER_IP` |
| `POST /api/publish` | **10/day per uid** (new; per-IP fallback when auth is off) | `PUBLISHES_PER_DAY_PER_UID` |

In-memory, per-instance (max-instances 20 → worst-case cap is N× the number;
acceptable for v1, same trade-off the build limiter already made).

## GA4

Property exists (account OpsAgents · property Rapid Site Builder) but the
**measurement ID is pending** — Michal is mid-wizard. `web/index.html` carries
no gtag snippet yet. When the ID lands: add the standard raw `gtag.js` snippet
(canonical baseline: raw gtag, not Firebase Analytics) + `exception` event
tracking. Never invent an ID.

## Deploy

`deploy-realapp.yml` (workflow_dispatch only) now ships
`PUBLIC_BASE_URL=https://builder.opsagents.agency` and a two-origin
`ALLOWED_ORIGINS` (custom domain + web.app) using gcloud's `^|^` env delimiter
(a bare comma inside the value would parse as a new env pair). The live service
had `ALLOWED_ORIGINS` merged forward via `--update-env-vars` at cutover time,
so builds from the new domain work before the next dispatch. Rule #20: only
`--update-env-vars` / `--update-secrets` outside this workflow's canonical
full-list deploy.

## What remains manual (operator, ~30s each)

1. **Authorized domain for sign-in:** Firebase console → Authentication →
   Settings → Authorized domains → add `builder.opsagents.agency`
   (console read-modify-write; never an API PATCH).
2. **GA4 measurement ID:** finish the GA4 wizard, then wire the gtag snippet.
3. **One real Google sign-in QA** on `https://builder.opsagents.agency` once
   TLS is ACTIVE (the "verify it's you" wall can't be driven headlessly).
4. **Dispatch `deploy-realapp.yml`** after this PR merges so the canonical env
   (PUBLIC_BASE_URL + 2-origin CORS) ships from the workflow.

## Rollback

- DNS: delete the `builder.opsagents.agency` CNAME (traffic returns to the
  web.app URL, which never stopped working).
- App: re-dispatch `deploy-realapp.yml` from the previous `real-app` commit —
  the workflow carries the full canonical env, so a redeploy is self-healing.
- Publish cap misbehaving: set `PUBLISHES_PER_DAY_PER_UID` high via
  `--update-env-vars` (merge-safe) without a code change.
