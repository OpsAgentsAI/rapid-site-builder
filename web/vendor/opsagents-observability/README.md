# Vendored `@opsagentsai/observability` — web adapter (rapid-site-builder)

Card `BNlDstQX`. This is the **built** (`dist/`) output of the shared
observability SDK, vendored into the app because rapid-site-builder's `web/`
surface is a **no-build, no-bundler** static-JS app served straight to the
browser by Express. A bare `import … from '@opsagentsai/observability/web'`
does not resolve at runtime (no module resolver for bare package names), so the
built ESM is committed here and imported by path — same pattern as the
canonical adopter (`msapps-lead-pipeline` `v2/public/modules/vendor/`).

- **Source package:** [`OpsAgentsAI/opsagents-observability`](https://github.com/OpsAgentsAI/opsagents-observability)
  (NOT listed in `package.json` — the repo is private, so a `github:` git dep
  breaks `npm install` on runners with no token for it; this README's
  source-commit pin is the provenance record).
- **Version:** `0.1.0`
- **Source commit:** `34ae6eeb8637d364395bdf877a87ed7cd8ca945c`
- **Runtime surface vendored (web adapter only):** `index.js`, `core.js`,
  `web.js`, `types.js`, `internal/gtag.js`, `internal/firebase-performance.js`.
  The `native`, `wordpress`, and `config` entries are intentionally omitted
  (the web adapter never imports them).

## Regenerate

```bash
git clone https://github.com/OpsAgentsAI/opsagents-observability
cd opsagents-observability && npm ci && npm run build   # tsc → dist/
# copy the web runtime set into this dir:
cp dist/index.js dist/core.js dist/web.js dist/types.js \
   web/vendor/opsagents-observability/
cp dist/internal/gtag.js dist/internal/firebase-performance.js \
   web/vendor/opsagents-observability/internal/
```

Do not hand-edit these files — edit the source repo, rebuild, and re-copy.
