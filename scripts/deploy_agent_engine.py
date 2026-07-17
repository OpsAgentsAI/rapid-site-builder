"""Deploy the builder crew to Vertex AI Agent Engine.

Usage (any environment with ADC and the agents/requirements.txt installed):

    GOOGLE_CLOUD_PROJECT=<project> \
    GOOGLE_CLOUD_LOCATION=us-central1 \
    AGENT_ENGINE_STAGING_BUCKET=gs://<your-staging-bucket> \
    python scripts/deploy_agent_engine.py

Prints the new reasoningEngine resource name — paste it into the app's
AGENT_ENGINE_RESOURCE env var. Note: every create() mints a NEW engine; pin the
printed resource and delete stale ones from the console. Lifecycle, source of
truth, audit and prune procedure: docs/ENGINES.md.

Region note: Agent Engine availability is regional; us-central1 is a safe pick.
GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION are RESERVED by the managed runtime
and must NOT be forwarded as env_vars (it injects them itself).
"""
from __future__ import annotations

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_AGENTS_DIR = os.path.join(_REPO_ROOT, "agents")
for p in (_AGENTS_DIR, _REPO_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

import vertexai
from vertexai import agent_engines

AdkApp = None
try:
    from vertexai.agent_engines import AdkApp as _AdkApp  # type: ignore
    AdkApp = _AdkApp
except Exception:  # pragma: no cover
    from vertexai.preview.reasoning_engines import AdkApp as _AdkApp  # type: ignore
    AdkApp = _AdkApp

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
STAGING_BUCKET = os.environ.get("AGENT_ENGINE_STAGING_BUCKET", "")

REQUIREMENTS = [
    "google-cloud-aiplatform[agent_engines,adk]",
    "google-adk>=1.32,<2",
    "mcp>=1.0.0",
]

_RUNTIME_ENV_KEYS = (
    "BUILDER_MODEL",
    "BUILDER_USE_GLOBAL",
    "ARIZE_MCP_URL",
    "ARIZE_MCP_API_KEY",
    "ARIZE_MCP_AUTH_HEADER",
    "ARIZE_MCP_HEADERS",
)


def _runtime_env() -> dict:
    env = {"GOOGLE_GENAI_USE_VERTEXAI": "TRUE"}
    for key in _RUNTIME_ENV_KEYS:
        val = os.environ.get(key)
        if val:
            env[key] = val
    return env


def main() -> int:
    if not PROJECT or not STAGING_BUCKET:
        print("FATAL: set GOOGLE_CLOUD_PROJECT and AGENT_ENGINE_STAGING_BUCKET")
        return 2
    print("Deploy target: project=%s location=%s" % (PROJECT, LOCATION))

    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "TRUE"
    os.environ["GOOGLE_CLOUD_PROJECT"] = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"] = LOCATION

    from builder_agents.agent import root_agent

    print("Imported root_agent: name=%s sub_agents=%d" % (
        getattr(root_agent, "name", "?"),
        len(getattr(root_agent, "sub_agents", []) or []),
    ))

    vertexai.init(project=PROJECT, location=LOCATION, staging_bucket=STAGING_BUCKET)
    app = AdkApp(agent=root_agent, enable_tracing=True)

    # extra_packages must be RELATIVE so the runtime tar lands `builder_agents/`
    # at import root — an absolute path produced "No module named 'builder_agents'"
    # at engine boot (control-plane UserCodeControlPlaneError).
    os.chdir(_AGENTS_DIR)
    remote = agent_engines.create(
        app,
        display_name="rapid-site-builder-crew",
        requirements=REQUIREMENTS,
        extra_packages=["builder_agents"],
        env_vars=_runtime_env(),
    )
    print("RESOURCE_NAME=%s" % remote.resource_name)
    print("Set AGENT_ENGINE_RESOURCE to the value above and redeploy the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
