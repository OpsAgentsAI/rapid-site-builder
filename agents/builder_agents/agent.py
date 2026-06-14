"""Builder crew — an ADK orchestrator + five specialists on Vertex AI Agent Engine.

    site_builder_orchestrator (root_agent)
      |- business_research_agent  -> brand brief from a one-line description
      |- layout_agent (Leo)       -> block sequence + rationale
      |- copy_agent (Noa)         -> HE/EN copy per block
      |- seo_agent (Sam)          -> SEO score + fixes
      `- observability_agent (Phoenix) -> records the run to Arize Phoenix via MCP

Google-native end to end: Gemini on Vertex AI through the ADK (google-adk).
Set GOOGLE_GENAI_USE_VERTEXAI=TRUE before deploy; the deploy script handles it.

Partner-MCP integration: observability_agent connects to the Arize Phoenix MCP
server as an ADK MCPToolset, configured entirely from env (ARIZE_MCP_URL /
ARIZE_MCP_API_KEY — see docs/ARIZE_MCP.md). When unset the toolset is omitted
with a loud warning so the core build path still runs.

Publishing is HUMAN-GATED by design: the crew drafts and stops; the only way a
site goes live is the client clicking Publish in the app (server-side render).
"""
from __future__ import annotations

import os
import sys

from google.adk.agents import Agent

from .global_gemini import GlobalGemini
from .tools import arize_mcp_config_from_env, business_research, layout_proposal, seo_audit

try:
    from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams
except Exception as _mcp_exc:  # pragma: no cover
    MCPToolset = None
    StreamableHTTPConnectionParams = None
    print("WARNING: ADK MCP toolset import failed (%r); Arize MCP disabled." % _mcp_exc,
          file=sys.stderr)

# Gemini 3 previews live on the GLOBAL Vertex endpoint only. The routing must
# travel INSIDE the pickled model object (see global_gemini.py for why env and
# import-time patches never reach the engine): one shared GlobalGemini instance
# pins location="global" lazily at runtime. Stable models keep the plain string
# (regional, ADK default).
_MODEL_NAME = os.environ.get("BUILDER_MODEL", "gemini-2.5-flash")
MODEL = GlobalGemini(model=_MODEL_NAME) if os.environ.get("BUILDER_USE_GLOBAL") == "1" else _MODEL_NAME
print("builder_agents: model=%s routing=%s" % (
    _MODEL_NAME, "global (GlobalGemini)" if isinstance(MODEL, GlobalGemini) else "regional default"),
    file=sys.stderr)


def _build_arize_mcp_toolset():
    cfg = arize_mcp_config_from_env()
    if cfg is None or MCPToolset is None or StreamableHTTPConnectionParams is None:
        print(
            "WARNING: Arize Phoenix MCP NOT wired (ARIZE_MCP_URL unset or ADK MCP "
            "unavailable). The partner-MCP integration is a hackathon eligibility "
            "requirement — see docs/ARIZE_MCP.md.",
            file=sys.stderr,
        )
        return None
    return MCPToolset(
        connection_params=StreamableHTTPConnectionParams(url=cfg["url"], headers=cfg["headers"]),
    )


_arize_toolset = _build_arize_mcp_toolset()

business_research_agent = Agent(
    name="business_research_agent",
    model=MODEL,
    description="Turns a one-line business description into a brand brief.",
    instruction=(
        "Call business_research with the description, name, category, language and "
        "style from the request. Present the brief — audience, tone, vibe, layout — "
        "and add two sharp insights about what this business's site must get right."
    ),
    tools=[business_research],
)

layout_agent = Agent(
    name="layout_agent",
    model=MODEL,
    description="Leo — proposes the page's block sequence with rationale.",
    instruction=(
        "You are Leo, the layout specialist. Given the brand brief, call "
        "layout_proposal and present the block sequence with a one-line rationale "
        "per block. Respect the brief's vibe; never invent new visual direction."
    ),
    tools=[layout_proposal],
)

copy_agent = Agent(
    name="copy_agent",
    model=MODEL,
    description="Noa — drafts the site copy per block, Hebrew and/or English.",
    instruction=(
        "You are Noa, the copywriter. For each proposed block write concrete, "
        "specific copy in the brief's language (Hebrew briefs get Hebrew copy in a "
        "warm feminine voice; English briefs get English). Headlines state benefits, "
        "body copy stays short and sensory, every section ends in a clear action. "
        "Invent believable details (address, phone, hours) when not given."
    ),
)

seo_agent = Agent(
    name="seo_agent",
    model=MODEL,
    description="Sam — scores the drafted page for SEO and proposes fixes.",
    instruction=(
        "You are Sam, the SEO specialist. Assemble a page dict from the drafted "
        "copy (title from the hero heading, description from the tagline, h1_count, "
        "word_count, cta_count), call seo_audit on it, and report the score, grade "
        "and the one most impactful fix."
    ),
    tools=[seo_audit],
)

observability_agent = Agent(
    name="observability_agent",
    model=MODEL,
    description="Phoenix — records build-run quality signals to Arize Phoenix via its MCP server.",
    instruction=(
        "You are Phoenix, the observability agent. Record this build run to Arize "
        "Phoenix using your MCP tools: add an example to the dataset "
        "'website_build_run_quality_signals' capturing the business name, category, "
        "language, layout and SEO score. Then confirm what you stored. If no MCP "
        "tools are available, say so explicitly."
    ),
    tools=[t for t in [_arize_toolset] if t is not None],
)

root_agent = Agent(
    name="site_builder_orchestrator",
    model=MODEL,
    description=(
        "Theo — orchestrates the site-building crew: research, layout, copy, SEO, "
        "observability. Builds complete one-page marketing sites from one-line briefs."
    ),
    instruction=(
        "You are Theo, the orchestrator of a website-building agent team. Follow the "
        "user's phase instructions exactly: delegate to the named sub-agent for each "
        "phase and keep your own summaries to one sentence. Never publish anything — "
        "publishing is human-approved outside this crew. When asked for the final "
        "site spec, return ONLY the strict JSON object requested, no prose."
    ),
    sub_agents=[business_research_agent, layout_agent, copy_agent, seo_agent, observability_agent],
)
