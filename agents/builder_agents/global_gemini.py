"""Gemini model wrapper that pins the GLOBAL Vertex endpoint at RUNTIME.

Gemini 3 preview models are served from the global endpoint only. Two facts
make env/import-time approaches dead ends on Agent Engine:

1. GOOGLE_CLOUD_LOCATION is a RESERVED env var — the managed runtime injects
   its own region (us-central1), so it cannot be overridden via env_vars.
2. Nothing in the pickled agent graph references builder_agents.agent by
   module path (agents are ADK classes, tools resolve via builder_agents.tools),
   so agent.py's module-level code NEVER executes on the engine — an
   import-time monkey-patch fires in the bake process and nowhere else.
   Postmortem: engine 915293402344456192 404'd every turn on
   `projects/.../locations/us-central1/.../gemini-3-flash-preview`.

This subclass carries the routing inside the PICKLED OBJECT GRAPH instead:
the ADK resolves `self.api_client` lazily on the first model turn — i.e. on
the engine, after unpickle — and the override below builds that client with
location="global" explicitly. No env, no patch, no import-order dependency.

Do NOT touch `.api_client` before agent_engines.create() — accessing it would
cache a live genai.Client into the instance __dict__ and break pickling.
"""
from __future__ import annotations

import os
from functools import cached_property

from google.adk.models.google_llm import Gemini


class GlobalGemini(Gemini):
    @cached_property
    def api_client(self):
        from google import genai
        from google.genai import types as genai_types

        http_options = None
        try:
            http_options = genai_types.HttpOptions(headers=dict(self._tracking_headers))
        except Exception:
            pass  # tracking headers are telemetry — never block routing on them
        return genai.Client(
            vertexai=True,
            project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
            location="global",
            http_options=http_options,
        )
