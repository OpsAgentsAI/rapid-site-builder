# Runbook — Connect-your-domain (custom domains)

Card `DYE9159z` (slice A of the custom-domains epic). Lets a **paid-tier**,
signed-in owner point a domain they own at one of their published RSB sites,
with Firebase Hosting providing **auto-TLS** once DNS verifies.

## What this slice ships

- `POST /api/domains/connect` — initiate a custom-domain attach for an owned site.
- `GET  /api/domains/status` — poll attach / ownership / host / TLS state.
- Firebase Hosting **customDomains** REST API integration (`lib/domains.js`).
- **Guided copy-paste DNS** on `/board`: the exact records to add at the
  registrar, with a live "Check status" poll. *(This is the always-works core.)*
- Cert (TLS) state surfaced on the board — Firebase provisions and renews the
  certificate; we never mint TLS ourselves.

## What is deferred (next sub-slices)

- **Automated Cloud DNS records** (path 2a): if we ever control the user's DNS
  zone in Google Cloud DNS, auto-write the A/AAAA/TXT records via the Cloud DNS
  API instead of asking the user to copy-paste. Not wired here — the guided
  copy-paste path covers every registrar and needs no zone access. When built,
  it slots in behind a `CLOUD_DNS_ZONE`-style flag in `lib/domains.js` and reuses
  the same `requiredDnsUpdates.desired[]` record list.
- **Billing-driven paid gate**: today the paid tier is a uid allowlist
  (`PAID_TIER_UIDS`); the epic's billing lookup will replace `domains.isPaid()`.
  The route contract (403 for non-paid) does not change.

## Gate chain (server-enforced on every call)

1. Custom domains configured (`FIREBASE_HOSTING_SITE` set) — else `503`.
2. Sign-in configured + valid `__session` — else `503` / `401`. A domain always
   has an owner; the anonymous publish path can never reach these routes.
3. Paid tier (`domains.isPaid(uid)`) — else `403 { upgrade: true }`.
4. Ownership: `session.uid === site meta ownerUid` — else `404` (same response
   as "no such site", so another owner's site is never revealed).

## Configuration (env vars)

| Var | Meaning |
|---|---|
| `FIREBASE_HOSTING_SITE` | The Hosting **site id** custom domains attach to (e.g. the app's own site). Unset → feature disabled (fail-closed). |
| `FIREBASE_HOSTING_PROJECT` | Project the Hosting site lives in. Falls back to `FIREBASE_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT`. |
| `PAID_TIER_UIDS` | Comma-separated Firebase uids on the paid plan. Empty → nobody is paid (fail-closed). |
| `PAID_TIER_OPEN` | `1` treats every signed-in user as paid — demos / self-host only; never on the hosted product. |

The runtime service account needs the **Firebase Hosting Admin** role (or
`firebasehosting.sites.update` on the site) so the metadata/gcloud-minted access
token can call `customDomains.create` / `.get`.

## The connect flow

1. Owner opens `/board`, sees the **🌐 Connect your own domain** panel (paid,
   owned sites only) and enters `shop.example.com`.
2. `POST /api/domains/connect` calls Hosting
   `POST v1beta1/projects/{project}/sites/{site}/customDomains?customDomainId={host}`
   (empty body — all state fields are read-only, server-set).
3. Hosting returns a `CustomDomain` carrying `requiredDnsUpdates.desired[]`.
   The board lists those records (Type / Host / Value) for copy-paste.
4. Owner adds the records at their registrar and presses **Check status**
   (`GET /api/domains/status` →
   `GET v1beta1/projects/{project}/sites/{site}/customDomains/{host}`).
5. When `ownershipState == OWNERSHIP_ACTIVE` and `hostState == HOST_ACTIVE`,
   Hosting provisions the cert; when `cert.state == CERT_ACTIVE` the board shows
   **Live and secure**.

### State enums (verbatim from the Hosting v1beta1 discovery doc)

- `hostState`: `HOST_UNHOSTED` · `HOST_UNREACHABLE` · `HOST_MISMATCH` · `HOST_CONFLICT` · `HOST_ACTIVE`
- `ownershipState`: `OWNERSHIP_MISSING` · `OWNERSHIP_UNREACHABLE` · `OWNERSHIP_MISMATCH` · `OWNERSHIP_CONFLICT` · `OWNERSHIP_PENDING` · `OWNERSHIP_ACTIVE`
- `cert.state`: `CERT_PREPARING` · `CERT_VALIDATING` · `CERT_PROPAGATING` · `CERT_ACTIVE` · `CERT_EXPIRING_SOON` · `CERT_EXPIRED`

## Per-registrar DNS guidance

The record **values** always come from Hosting's `requiredDnsUpdates` — copy them
exactly; only the UI for entering them differs.

| Registrar | Where | Root vs subdomain notes |
|---|---|---|
| **Cloudflare** | DNS → Records → Add record | Set the proxy status to **DNS only** (grey cloud) for the A/AAAA records, otherwise Cloudflare's proxy hides Hosting's IP and verification stalls. |
| **Namecheap** | Advanced DNS → Add New Record | Use `@` for the root host; a bare subdomain (e.g. `shop`) for the Host field. |
| **GoDaddy** | DNS → Manage Zones → Add | `@` = root. GoDaddy appends the domain automatically — enter just the subdomain label, not the FQDN. |
| **Google Domains / Cloud DNS** | DNS → Manage custom records | For a Cloud DNS zone we control, the future auto-DNS sub-slice writes these for you. |
| **Route 53** | Hosted zone → Create record | TXT values must be quoted; the console adds quotes for you. |

**Root (apex) domains** need `A` (and often `AAAA`) records — a CNAME at the apex
is not valid DNS. **Subdomains** may be given a CNAME by some registrars, but use
exactly the record **types Hosting returns**; do not substitute a CNAME for an A
record it asked for.

## ⚠️ Console-only gotcha — auth redirect URI

If the connected domain should also serve **Firebase Auth** sign-in
(`__/auth/handler`), the authorized-domain / OAuth redirect-URI edit is
**console-only** — it cannot be automated via the REST API. **Do not try to
script it.** For RSB this is a non-issue: sign-in stays on the project's default
`authDomain` (`<project>.firebaseapp.com` / `.web.app`), and the custom domain
serves the published *site content* only. If a future slice wants auth on the
custom domain, an operator adds it in the Firebase console
(Authentication → Settings → Authorized domains) by hand.

## Verify (downstream QA — not done in the build pipe)

A live attach + DNS + cert verify is a manual QA step (it needs a real owned
domain and real registrar DNS). This pipe stops at code review; nothing calls the
live Firebase Hosting API during build or CI (all tests mock it).

```bash
# health flag
curl -s https://<service>/api/health | jq .customDomains   # true when configured

# with a paid session cookie + an owned site:
curl -s -X POST https://<host>/api/domains/connect \
  -H 'content-type: application/json' -b "__session=<cookie>" \
  -d '{"siteId":"<8hex>","domain":"shop.example.com"}' | jq .
# then poll:
curl -s "https://<host>/api/domains/status?siteId=<8hex>" -b "__session=<cookie>" | jq .
```

## API shape source

Verified against the Firebase Hosting **v1beta1 discovery document**
(`https://firebasehosting.googleapis.com/$discovery/rest?version=v1beta1`):
`customDomains.create` / `.get` paths, the `CustomDomain` resource
(`hostState`, `ownershipState`, `cert.state`, `requiredDnsUpdates.desired[].records[]`
with `type` / `rdata` / `requiredAction`). See the header comment in
`lib/domains.js`.
