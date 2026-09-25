# Runbook — real `X-Content-Type-Options: nosniff` on the public media bucket

Card `7KlXAiW0` (follow-up to the merged magic-bytes hardening in PR #17).

## Why this layer exists

User media and hero-cache images are served from a **public GCS bucket** (the
`SITE_IMAGES_BUCKET` value). A direct `storage.googleapis.com/<bucket>/<object>`
response can **never** carry a real `X-Content-Type-Options: nosniff` header:
custom object metadata only surfaces as `x-goog-meta-x-content-type-options`,
which browsers ignore.

The stored-XSS vector is already closed without this layer — the fail-closed
magic-bytes gate plus a pinned real `Content-Type` (see `lib/uploads.js`) means
an explicitly-typed `image/*` body is never sniffed into HTML. This runbook is
**defense-in-depth**: a fronting layer that adds the real header.

## Architecture

```
browser ──HTTPS──▶ global external HTTPS LB (media.<your-domain>)
                     └─ Cloud CDN backend bucket ─▶ SITE_IMAGES_BUCKET (unchanged, stays public)
                        · injects  X-Content-Type-Options: nosniff  on every response
```

App side: `lib/publicMedia.js` reads `PUBLIC_MEDIA_BASE_URL`. When it is a valid
`https://` origin, every **newly minted** public media URL (user uploads in
`lib/uploads.js`, hero cache in `lib/images.js`) uses that origin instead of the
direct storage URL. Unset/empty/malformed → direct URLs, feature off. Publish-time
URL re-validation (`sanitizeUserMedia`) accepts **both** forms, so pages published
before the flip keep working, and rollback cannot strand in-flight builds.

## Operator apply (one-time, ~10 min + DNS/cert wait)

Nothing here runs from CI — LB resources cost real money (a global forwarding
rule bills hourly regardless of traffic, plus CDN egress) and the apply is a
deliberate operator step.

```bash
PROJECT_ID=<gcp-project-that-owns-the-bucket> \
MEDIA_BUCKET=<the SITE_IMAGES_BUCKET value> \
MEDIA_DOMAIN=media.<your-domain> \
./scripts/setup_media_cdn.sh
```

The script is idempotent (create-if-missing; the backend bucket converges on
reruns) and creates, in order: backend bucket (`--enable-cdn`,
`--custom-response-header='X-Content-Type-Options: nosniff'`), URL map,
Google-managed SSL cert, target HTTPS proxy, global static IP, forwarding rule.
All names are prefixed `rsb-media-` (override with `PREFIX=`).

Then:

1. **DNS** — A record `MEDIA_DOMAIN → <printed IP>`.
2. **Cert** — wait for `ACTIVE`:
   ```bash
   gcloud compute ssl-certificates describe rsb-media-cert --global \
     --project <PROJECT_ID> --format='value(managed.status)'
   ```
   The managed cert stays `PROVISIONING` until DNS resolves to the LB IP.
3. **Verify the header** on any existing object of the bucket:
   ```bash
   curl -sI "https://<MEDIA_DOMAIN>/<object-path>" | grep -i x-content-type-options
   # expected: x-content-type-options: nosniff
   ```
4. **Flip the app** — the env var is secret-sourced so the value never lands in
   the public repo (same doctrine as `cloudrun-env.md`):
   ```bash
   gh secret set PUBLIC_MEDIA_BASE_URL --repo OpsAgentsAI/rapid-site-builder \
     --body "https://<MEDIA_DOMAIN>"
   gh workflow run deploy.yml --repo OpsAgentsAI/rapid-site-builder
   gh workflow run deploy-realapp.yml --repo OpsAgentsAI/rapid-site-builder
   ```
5. **Confirm** both services report the flip and a fresh build mints fronted URLs:
   ```bash
   curl -s https://<service-domain>/api/health | grep publicMediaBase
   # expected: "publicMediaBase":true
   ```
   Then run one build with an uploaded photo and check the media URL host is
   `MEDIA_DOMAIN` and its response carries the header (step 3 curl against it).

## AC verification map

| AC | How it's met |
|---|---|
| served public user-media URL returns a real nosniff response header | LB backend-bucket `--custom-response-header`; verified by the step-3/step-5 curls |
| existing published pages keep loading media | bucket stays public → old direct `storage.googleapis.com` URLs untouched; `sanitizeUserMedia` accepts both hosts |
| documented in the uploads runbook | this file (linked from `lib/uploads.js` and `cloudrun-env.md`) |

## Gotchas & operations

- **Bucket must STAY public.** Legacy published pages embed direct
  `storage.googleapis.com` URLs. Locking the bucket down to LB-only access
  breaks them; that migration (rewriting stored pages) is explicitly out of
  scope here and needs its own card.
- **Legacy direct URLs never get the header.** Accepted: they still carry the
  pinned `Content-Type`, and the magic-bytes gate is the load-bearing control.
  Only newly minted URLs go through the LB.
- **`--custom-response-header` REPLACES the list on update** — same
  replace-vs-merge trap as Cloud Run `--set-env-vars` (workspace rule #20). Any
  future extra header must be passed alongside the nosniff one on every
  `backend-buckets update`.
- **CDN staleness:** user-media object names are unique per publish
  (`user/<token>/<n>.<ext>`) so they are immutable and cache-safe. Hero-cache
  keys (`<category>/<style>/hero-1.png`) CAN be re-seeded; after a re-seed,
  invalidate:
  ```bash
  gcloud compute url-maps invalidate-cdn-cache rsb-media-lb \
    --path "/<category>/<style>/hero-1.png" --global --project <PROJECT_ID>
  ```
- **Rollback:** set the `PUBLIC_MEDIA_BASE_URL` secret to an empty string and
  rerun both deploy workflows — new URLs revert to direct storage form (old
  fronted URLs keep serving as long as the LB stays up). Tearing the LB down is
  a separate deliberate step and must wait until no live page references
  `MEDIA_DOMAIN`.
- **Env source of truth:** `PUBLIC_MEDIA_BASE_URL` follows the
  [`cloudrun-env.md`](./cloudrun-env.md) doctrine — GH repo secret, applied by
  the canonical `--set-env-vars` list in both deploy workflows. A manual
  `--update-env-vars` flip evaporates on the next push to a deploy branch.
