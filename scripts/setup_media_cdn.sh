#!/usr/bin/env bash
# Stand up the nosniff fronting layer for the PUBLIC image bucket (card 7KlXAiW0).
#
# Why: a direct storage.googleapis.com object can NEVER return a real
# `X-Content-Type-Options: nosniff` RESPONSE header — custom object metadata
# surfaces only as `x-goog-meta-*`, which browsers ignore. This script fronts
# the public image bucket with a global external HTTPS load balancer whose
# Cloud CDN backend bucket injects the header on every response.
#
# OPERATOR-RUN ONLY. Never wired into CI — creating LB resources is a
# deliberate infra change with a small recurring cost (a global forwarding
# rule bills hourly whether or not it serves traffic, plus CDN egress).
# Companion runbook (read it first): docs/RUNBOOKS/public-media-nosniff.md
#
# Idempotent: every resource is create-if-missing; the backend bucket is
# updated in place on reruns so the header/CDN settings converge. Requires
# roles/compute.loadBalancerAdmin (+ compute.networkAdmin for the address)
# on the target project.
#
# Usage:
#   PROJECT_ID=<gcp-project> \
#   MEDIA_BUCKET=<public image bucket — the SITE_IMAGES_BUCKET value> \
#   MEDIA_DOMAIN=<serving domain, e.g. media.example.com> \
#   ./scripts/setup_media_cdn.sh
#
# Optional:
#   PREFIX=<resource name prefix>   (default: rsb-media)
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID to the GCP project that owns the bucket}"
: "${MEDIA_BUCKET:?set MEDIA_BUCKET to the public image bucket (the SITE_IMAGES_BUCKET value)}"
: "${MEDIA_DOMAIN:?set MEDIA_DOMAIN to the domain the media will be served from}"
PREFIX="${PREFIX:-rsb-media}"

g() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

echo "== 1/6 backend bucket (Cloud CDN + nosniff response header)"
# NOTE: --custom-response-header REPLACES the full header list on update (same
# replace-vs-merge trap as rule #20). If more custom headers are ever added,
# every one of them must be passed here on every run.
if g compute backend-buckets describe "$PREFIX-backend" >/dev/null 2>&1; then
  g compute backend-buckets update "$PREFIX-backend" \
    --gcs-bucket-name="$MEDIA_BUCKET" \
    --enable-cdn \
    --cache-mode=CACHE_ALL_STATIC \
    --custom-response-header='X-Content-Type-Options: nosniff'
else
  g compute backend-buckets create "$PREFIX-backend" \
    --gcs-bucket-name="$MEDIA_BUCKET" \
    --enable-cdn \
    --cache-mode=CACHE_ALL_STATIC \
    --custom-response-header='X-Content-Type-Options: nosniff'
fi

echo "== 2/6 URL map"
if ! g compute url-maps describe "$PREFIX-lb" --global >/dev/null 2>&1; then
  g compute url-maps create "$PREFIX-lb" \
    --default-backend-bucket="$PREFIX-backend" \
    --global
fi

echo "== 3/6 Google-managed SSL certificate"
# The managed cert only leaves PROVISIONING after MEDIA_DOMAIN's DNS points at
# the LB IP printed below — provisioning is normally minutes, can take hours.
if ! g compute ssl-certificates describe "$PREFIX-cert" --global >/dev/null 2>&1; then
  g compute ssl-certificates create "$PREFIX-cert" \
    --domains="$MEDIA_DOMAIN" \
    --global
fi

echo "== 4/6 target HTTPS proxy"
if ! g compute target-https-proxies describe "$PREFIX-proxy" --global >/dev/null 2>&1; then
  g compute target-https-proxies create "$PREFIX-proxy" \
    --url-map="$PREFIX-lb" \
    --ssl-certificates="$PREFIX-cert" \
    --global
fi

echo "== 5/6 global static IP"
if ! g compute addresses describe "$PREFIX-ip" --global >/dev/null 2>&1; then
  g compute addresses create "$PREFIX-ip" --global --ip-version=IPV4
fi
IP="$(g compute addresses describe "$PREFIX-ip" --global --format='value(address)')"

echo "== 6/6 forwarding rule (443)"
if ! g compute forwarding-rules describe "$PREFIX-https" --global >/dev/null 2>&1; then
  g compute forwarding-rules create "$PREFIX-https" \
    --target-https-proxy="$PREFIX-proxy" \
    --address="$PREFIX-ip" \
    --ports=443 \
    --global
fi

CERT_STATUS="$(g compute ssl-certificates describe "$PREFIX-cert" --global --format='value(managed.status)')"

cat <<DONE

Fronting layer is up. Remaining operator steps (details in the runbook):

  1. DNS: create an A record   $MEDIA_DOMAIN -> $IP
  2. Wait for the managed cert to go ACTIVE (currently: $CERT_STATUS):
       gcloud compute ssl-certificates describe $PREFIX-cert --global \\
         --project $PROJECT_ID --format='value(managed.status)'
  3. Verify the header on a real object:
       curl -sI "https://$MEDIA_DOMAIN/<any-object-path-on-the-bucket>" | grep -i x-content-type-options
     Expected:  x-content-type-options: nosniff
  4. Flip the app to mint media URLs through the layer:
       gh secret set PUBLIC_MEDIA_BASE_URL --repo OpsAgentsAI/rapid-site-builder \\
         --body "https://$MEDIA_DOMAIN"
     then rerun deploy.yml AND deploy-realapp.yml (or merge to their branches).
  5. Confirm /api/health shows "publicMediaBase": true on both services.
DONE
