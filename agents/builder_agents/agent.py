"""Builder crew — an ADK orchestrator + five specialists on Vertex AI Agent Engine.

    site_builder_orchestrator (root_agent)
      |- business_research_agent  -> brand brief from a one-line description
      |- layout_agent (Leo)       -> block sequence + rationale
      |- ux_agent (Dana)          -> UX-flow review of the block sequence
      |- visual_agent (Remy)      -> visual design system from the brief's vibe
      |- copy_agent (Noa)         -> HE/EN copy per block
      |- seo_agent (Sam)          -> SEO score + fixes
      |- frontend_agent (Kai)     -> pre-ship frontend checklist
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

# Gemini 3 preview models are served from the GLOBAL Vertex endpoint only.
# GOOGLE_CLOUD_LOCATION is reserved in Agent Engine env_vars (the runtime
# injects its own region) and the env override alone proved insufficient —
# the ADK's genai client still bound the regional location. When
# BUILDER_USE_GLOBAL=1 we therefore patch genai Client construction itself:
# every client the ADK builds gets location="global", regardless of how or
# when it imports the class. Model calls route global; the engine's control
# plane stays regional (managed by Vertex, unaffected).
if os.environ.get("BUILDER_USE_GLOBAL") == "1":
    os.environ["GOOGLE_CLOUD_LOCATION"] = "global"
    try:
        from google.genai import client as _genai_client_mod

        _orig_client_init = _genai_client_mod.Client.__init__

        def _global_client_init(self, *args, **kwargs):
            kwargs["location"] = "global"
            _orig_client_init(self, *args, **kwargs)

        _genai_client_mod.Client.__init__ = _global_client_init
        print("builder_agents: genai Client patched to location=global", file=sys.stderr)
    except Exception as _patch_exc:  # pragma: no cover
        print("WARNING: global-client patch failed (%r); Gemini 3 routing may fail."
              % _patch_exc, file=sys.stderr)

from google.adk.agents import Agent

from .tools import (
    arize_mcp_config_from_env,
    business_research,
    frontend_check,
    layout_proposal,
    seo_audit,
    ux_flow_review,
    visual_system,
)

try:
    from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams
except Exception as _mcp_exc:  # pragma: no cover
    MCPToolset = None
    StreamableHTTPConnectionParams = None
    print("WARNING: ADK MCP toolset import failed (%r); Arize MCP disabled." % _mcp_exc,
          file=sys.stderr)

MODEL = os.environ.get("BUILDER_MODEL", "gemini-2.5-flash")


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

ux_agent = Agent(
    name="ux_agent",
    model=MODEL,
    description="Dana — reviews the page's UX flow against conversion best practice.",
    instruction=(
        "You are Dana, the UX specialist. Given the proposed block sequence, call "
        "ux_flow_review with the blocks and the brief's audience, then report the "
        "flow score and walk through each issue with a concrete reordering fix. "
        "Respect Leo's layout intent — you tune the journey, not the blocks."
    ),
    tools=[ux_flow_review],
)

visual_agent = Agent(
    name="visual_agent",
    model=MODEL,
    description="Remy — derives the visual design system from the brief's vibe.",
    instruction=(
        "You are Remy, the visual designer. Call visual_system with the brief's "
        "vibe and category and present the system — palette, type pairing, corners, "
        "imagery direction, spacing — with one sentence on why it fits this "
        "business. Never contradict the brief's vibe."
    ),
    tools=[visual_system],
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

frontend_agent = Agent(
    name="frontend_agent",
    model=MODEL,
    description="Kai — runs the pre-ship frontend checklist on the assembled page.",
    instruction=(
        "You are Kai, the frontend builder. Assemble a page dict from the draft "
        "(h1_count, description, has_scripts, mobile_ready, images_have_alt), call "
        "frontend_check on it and report pass/fail per item, the single most "
        "important fix first. Published pages must stay script-free."
    ),
    tools=[frontend_check],
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
    sub_agents=[
        business_research_agent,
        layout_agent,
        ux_agent,
        visual_agent,
        copy_agent,
        seo_agent,
        frontend_agent,
        observability_agent,
    ],
)
