# ⚡ Rapid Site Builder

**Describe your business in one line — an AI agent team designs, writes, and ships your website in front of you.**

Built for the Google Cloud Rapid Agent Hackathon. Google-native end to end:

- **Google Cloud Agent Builder (ADK)** — a five-specialist crew orchestrated by `site_builder_orchestrator`, deployed on **Vertex AI Agent Engine**
- **Gemini** for every agent turn, plus **Gemini image generation ("Nano Banana")** for hero photography (GCS-cached by business category)
- **Arize Phoenix MCP** (partner integration) — the observability agent records every build run through Phoenix's MCP server
- No other AI anywhere.

## The experience

1. **Intake (~30 seconds, no login):** business name · category · one line about it · language (EN/עברית) · optional vibe.
2. **The agents show:** the crew streams live — Brief researches, Leo lays out, Noa writes, Sam scores SEO, Phoenix traces the run to Arize — every real `function_call` visible.
3. **The payoff:** a polished one-page site renders in an inline preview (RTL-correct Hebrew included).
4. **Publish — free:** one click ships it to a real shareable URL (`/sites/{id}`), server-side rendered.
5. **The operate board:** the client lands with **Theo the orchestrator** front and center — the team now *runs* the site (monitoring, updates, security). The client never has to do anything; they can talk to Theo only when they wish ("Ask the team" sends a real turn to the live Agent Engine), and the rare decision arrives as a single calm approval.

## Architecture

```
web/                 static frontend (landing show + operate board)
server.js            Express on Cloud Run — SSE /api/build, /api/publish, /sites/:id, /api/ask
lib/engine.js        Vertex AI Agent Engine driver (create_session + phased stream_query,
                     incremental SSE — one ADK turn ends at the first agent transfer)
lib/renderer.js      deterministic site renderer (4 layouts × 5 vibe palettes, RTL, no scripts)
lib/images.js        Gemini image gen + GCS cache keyed by category/style (recyclable art)
lib/store.js         published sites in GCS, served at /sites/:id
agents/              the ADK crew source (google-adk) + deterministic tools
scripts/deploy_agent_engine.py   deploys the crew to Vertex AI Agent Engine
```

Human-in-the-loop by design: the crew only drafts; the **only** way a site goes live is the human clicking Publish.

## Run it yourself

Prereqs: a GCP project with Vertex AI enabled, two GCS buckets (one public-read for the image cache, one private for published sites), and ADC (`gcloud auth login`).

```bash
# 1. Deploy the agent crew to Vertex AI Agent Engine
pip install -r agents/requirements.txt
GOOGLE_CLOUD_PROJECT=<project> AGENT_ENGINE_STAGING_BUCKET=gs://<staging-bucket> \
  python scripts/deploy_agent_engine.py
# → prints RESOURCE_NAME=projects/.../reasoningEngines/...

# 2. Configure + run the app
cp .env.example .env   # fill in the resource name + buckets + image project
npm install
node server.js         # http://localhost:8080

# 3. (optional) pre-seed the hero-image cache
node scripts/seed_images.mjs
```

Deploy to Cloud Run with the same env vars (`gcloud run deploy --source .`); put Firebase Hosting in front with the included `firebase.json` rewrite if you want a `*.web.app` URL.

For the Arize Phoenix MCP integration (bring your own key), see [docs/ARIZE_MCP.md](docs/ARIZE_MCP.md).

## License

[Apache-2.0](LICENSE)
