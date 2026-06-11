# Runbook — Cloud Run env vars on `rapid-builder-proxy`

**The trap:** `.github/workflows/deploy.yml` deploys with `--set-env-vars`, which
**REPLACES** the service's entire env list with the workflow's canonical list on
every push to `main`. Any value you changed by hand in between — e.g.
`gcloud run services update --update-env-vars AGENT_ENGINE_RESOURCE=…` — silently
reverts on the next deploy.

This is not a bug to fix by switching CI to `--update-env-vars`: CI carrying the
full canonical list is what makes a deploy reproducible. The rule is about where
a durable change must be made.

> Hit live 2026-06-11 17:26–17:38 UTC: manual `AGENT_ENGINE_RESOURCE` flips made
> during the Gemini-3 engine incident interleaved with push-triggered deploys and
> evaporated (card ZEqaJ0VZ, parent RWMcxAI7).

## Where each env var actually lives

| Env var | Source of truth |
|---|---|
| `AGENT_ENGINE_RESOURCE` | GH repo secret `AGENT_ENGINE_RESOURCE` |
| `SITE_IMAGES_BUCKET` / `PUBLISHED_SITES_BUCKET` / `IMAGE_PROJECT` / `WARM_KEY` | GH repo secrets (same names) |
| `IMAGE_REGION`, `IMAGE_MODEL`, `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS` | hardcoded in `deploy.yml` |
| `SESSION_SECRET` (and future Secret Manager mounts) | `--update-secrets` in `deploy.yml` → Secret Manager; rotate by adding a secret **version**, not by editing env |

## Durable change procedure

1. **Secret-sourced value** (e.g. flip the agent engine):
   ```bash
   gh secret set AGENT_ENGINE_RESOURCE --repo OpsAgentsAI/rapid-site-builder \
     --body "projects/<proj>/locations/us-central1/reasoningEngines/<id>"
   gh workflow run deploy.yml --repo OpsAgentsAI/rapid-site-builder   # or merge to main
   ```
2. **Workflow-hardcoded value**: edit `deploy.yml` in a PR, merge — the deploy it
   triggers applies it.
3. **Verify** after the run:
   ```bash
   gcloud run services describe rapid-builder-proxy --project <project> \
     --region us-central1 --format='value(spec.template.spec.containers[0].env)'
   curl -s https://rapid-site-builder.web.app/api/health
   ```

## Emergency manual flip (incident pressure)

A manual `--update-env-vars` flip is fine to stop the bleeding — but it is a
**temporary patch with a fuse**: it lives only until the next push to `main`.
Immediately after flipping by hand, do step 1 above so the GH secret matches
what you flipped to. If the manual value and the GH secret disagree, the next
deploy is a silent rollback.

Cross-stack context: rule #20 in the workspace CLAUDE.md (merge vs replace
semantics, postmortems MEzHPQXQ / tWTnlj2Y).
