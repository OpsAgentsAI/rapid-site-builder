# Arize Phoenix MCP integration (partner track)

The crew's `observability_agent` ("Phoenix") connects to an **Arize Phoenix MCP
server** as an ADK `MCPToolset` and records one quality-signal example per build
run to the dataset `website_build_run_quality_signals` — business name,
category, language, layout, SEO score. That makes every agent run traceable in
Phoenix, beyond-chat, with your own Phoenix space as the sink.

## Bring your own Phoenix

1. Create (or reuse) an Arize Phoenix space and an API key.
2. Run a Phoenix MCP server reachable over HTTPS (Streamable HTTP transport).
   The Phoenix docs cover hosting options; any URL of the shape
   `https://<your-phoenix-host>/s/<space-id>/mcp` works. Note the `/s/<space-id>`
   prefix — omitting it is the most common misconfiguration.
3. Set the env vars when deploying the Agent Engine crew
   (`scripts/deploy_agent_engine.py` forwards them):

```bash
export ARIZE_MCP_URL="https://<your-phoenix-host>/s/<space-id>/mcp"
export ARIZE_MCP_API_KEY="<your-key>"
# optional: ARIZE_MCP_AUTH_HEADER=api_key   (default is Authorization: Bearer <key>)
```

When `ARIZE_MCP_URL` is unset the toolset is omitted with a loud warning and the
build path still runs — but the partner-MCP integration (and the traced-run wow
in the demo) is off.

## What you'll see

Each build run produces an `add-dataset-examples` call from Phoenix's MCP tools;
the example lands in `website_build_run_quality_signals` in your space, and the
run's turns are visible in the app's live feed as real `function_call` /
`function_response` events.
