# Agent Engines — lifecycle, source of truth, prune

> **Every `agent_engines.create()` mints a NEW reasoningEngine.** So does every run
> of the `Deploy Agent Engine` workflow (`deploy-engine.yml`). **Reuse — don't
> recreate.** Recreating without pinning the new resource leaves the app on the old
> engine and litters the project with orphans that still cost quota headroom.

## Source of truth (in priority order)

This repository is **public** — engine resource names are never committed here.
Do not add engine IDs, project numbers, or full `projects/.../reasoningEngines/...`
paths to any file in this repo (docs, tests, defaults, or scripts included).

1. **Live Cloud Run env** — `AGENT_ENGINE_RESOURCE` on the serving services
   (`rapid-builder-proxy`, `rapid-builder-app`). This is what actually serves.
   ```
   gcloud run services describe <service> --region us-central1 --project <run-project> \
     --format='value(spec.template.spec.containers[0].env)'
   ```
2. **GitHub repo secret `AGENT_ENGINE_RESOURCE`** — what the next deploy will pin
   (see `docs/RUNBOOKS/cloudrun-env.md`; `--set-env-vars` REPLACES, so the secret
   must always hold the full canonical value).
3. Anything written in a card, PR description, or commit message is **not**
   authoritative. Three conflicting IDs circulated in docs before this file
   existed; the audit that reconciled them (ID-level truth table + stale list)
   lives operator-side on the tracking card (TSIGYBav), not in this public repo.

Both serving services must pin the **same** resource. If they diverge, the last
deploy wins on its own service only — fix the secret, then redeploy both.

## Rotating to a new engine

1. Run the `Deploy Agent Engine` workflow (manual dispatch) — it prints
   `RESOURCE_NAME=projects/.../reasoningEngines/...`.
2. Pin it: `gh secret set AGENT_ENGINE_RESOURCE --repo <this-repo> --body "<RESOURCE_NAME>"`.
3. Re-run the Cloud Run deploy workflows so both services pick it up
   (per `docs/RUNBOOKS/cloudrun-env.md` — never hand-edit env on one service).
4. Verify both services' env shows the new resource, smoke the app, **then**
   queue the old engine for prune (below). Never delete before the replacement
   is verified serving.

## Audit: finding every engine and who uses it

There is no `gcloud ai reasoning-engines` CLI surface — use the REST API:

```
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/<engines-project>/locations/us-central1/reasoningEngines?pageSize=100"
```

Cross-reference every returned engine against **all** Cloud Run services in every
project that could reference it (`gcloud run services list --project <p>
--format='value(metadata.name,spec.template.spec.containers[0].env)'` and grep
for `reasoningEngines/`), plus any scheduled jobs or scripts. An engine is only
**stale** when nothing references it. Note: engines in the shared project may
belong to *other* products — a matching display-name lineage is not enough;
verdicts go by live references, not by docs or names.

## Prune (operator)

Engine deletion is destructive and gateway-blocked — it is an operator-only,
local-terminal action. One line per stale engine:

```
curl -s -X DELETE -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/<engines-project>/locations/us-central1/reasoningEngines/<ENGINE_ID>"
```

(Append `?force=true` only if the engine has child resources blocking deletion.)

Rules:
- Prune only engines with **zero** live references (audit above, re-run fresh).
- Never prune engines serving other products from the shared project.
- The current stale list (IDs + evidence) is maintained on card TSIGYBav.
