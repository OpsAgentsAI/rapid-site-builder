"""Deterministic tools for the builder crew — stdlib only, no ADK/Vertex deps.

Each tool is a pure function the LLM agents call conversationally. Keeping the
logic deterministic and dependency-free makes the crew cheap to test and the
agents' reasoning visible: the model narrates around solid, reproducible data.
"""
from __future__ import annotations

import json
import os


INDUSTRIES = {
    "food_beverage": {"keywords": ["cafe", "coffee", "bakery", "restaurant", "bar"],
                      "audience": "locals and regulars who value freshness and atmosphere",
                      "tone": "warm, sensory, inviting", "vibe": "warm", "layout": "catalog"},
    "retail": {"keywords": ["shop", "store", "boutique"],
               "audience": "shoppers looking for curated, quality products",
               "tone": "crisp, friendly, confident", "vibe": "bold", "layout": "catalog"},
    "beauty": {"keywords": ["salon", "spa", "beauty", "nails"],
               "audience": "clients seeking self-care and a premium feel",
               "tone": "serene, polished, indulgent", "vibe": "warm", "layout": "booking"},
    "health": {"keywords": ["clinic", "dental", "doctor", "therapy"],
               "audience": "patients who need reassurance and clarity",
               "tone": "calm, professional, caring", "vibe": "trust", "layout": "booking"},
    "fitness": {"keywords": ["gym", "fitness", "pilates", "yoga", "studio"],
                "audience": "people building a routine that fits their life",
                "tone": "energetic, encouraging, no-nonsense", "vibe": "fresh", "layout": "booking"},
    "professional": {"keywords": ["agency", "consult", "law", "account"],
                     "audience": "businesses choosing a partner they can rely on",
                     "tone": "assured, specific, results-led", "vibe": "trust", "layout": "services"},
    "tech": {"keywords": ["app", "saas", "software", "startup", "ai"],
             "audience": "early adopters and teams evaluating tools",
             "tone": "sharp, modern, benefit-first", "vibe": "modern", "layout": "services"},
    "real_estate": {"keywords": ["real estate", "realty", "homes"],
                    "audience": "buyers and sellers making their biggest decision",
                    "tone": "trustworthy, local, personal", "vibe": "trust", "layout": "services"},
    "education": {"keywords": ["school", "course", "tutor"],
                  "audience": "learners and parents investing in growth",
                  "tone": "encouraging, clear, credible", "vibe": "fresh", "layout": "services"},
    "events": {"keywords": ["event", "wedding", "venue", "catering"],
               "audience": "people planning a day they will remember",
               "tone": "celebratory, elegant, organized", "vibe": "bold", "layout": "services"},
}


def business_research(description: str, name: str = "", category: str = "",
                      language: str = "", style: str = "") -> dict:
    """Produce a brand brief from a one-line business description.

    Deterministic: classifies the industry (explicit category wins, else keyword
    scan) and derives audience/tone/vibe/layout defaults the downstream agents
    elaborate on. Never raises.
    """
    text = f"{name} {description}".strip()
    cat = (category or "").strip().lower()
    if cat not in INDUSTRIES:
        cat = ""
        low = text.lower()
        for key, ind in INDUSTRIES.items():
            if any(k in low for k in ind["keywords"]):
                cat = key
                break
        cat = cat or "professional"
    ind = INDUSTRIES[cat]
    he = language == "he"
    return {
        "business_name": name or (description.split(",")[0][:60] if description else "New Business"),
        "category": cat,
        "language": "he" if he else "en",
        "audience": ind["audience"],
        "tone": ind["tone"],
        "suggested_vibe": (style if style in ("warm", "fresh", "modern", "trust", "bold") else ind["vibe"]),
        "suggested_layout": ind["layout"],
        "description": description[:400],
    }


def layout_proposal(brief: dict) -> dict:
    """Propose the page's block sequence for a brand brief, with rationale."""
    layout = (brief or {}).get("suggested_layout", "standard")
    sequences = {
        "standard": ["hero", "about", "offerings", "why_us", "visit", "cta", "footer"],
        "services": ["hero_cover", "services", "process_why", "about", "cta", "footer"],
        "catalog": ["hero_cover", "menu_grid", "about", "visit", "cta", "footer"],
        "booking": ["hero_trust", "why_us", "services", "hours_visit", "book_cta", "footer"],
    }
    blocks = sequences.get(layout, sequences["standard"])
    return {
        "layout": layout if layout in sequences else "standard",
        "blocks": blocks,
        "rationale": {
            "standard": "balanced storytelling page: story first, offerings second",
            "services": "service-led: what you get up top, trust signals right after",
            "catalog": "product-led: the catalog IS the pitch, story supports it",
            "booking": "appointment-led: trust and hours up front, one clear booking action",
        }.get(layout, "balanced default"),
        "headline_rule": "one H1 only; concrete benefit, no slogans",
    }


def seo_audit(page: dict) -> dict:
    """Score a drafted page dict ({title, description, h1_count, word_count, cta_count})."""
    page = page or {}
    score = 100
    findings = []
    title = str(page.get("title", ""))
    if not title:
        score -= 25; findings.append("missing title")
    elif not 15 <= len(title) <= 60:
        score -= 8; findings.append("title length off (aim 15-60 chars)")
    desc = str(page.get("description", ""))
    if not desc:
        score -= 18; findings.append("missing meta description")
    elif not 50 <= len(desc) <= 160:
        score -= 6; findings.append("meta description length off (aim 50-160)")
    if int(page.get("h1_count", 0) or 0) != 1:
        score -= 12; findings.append("exactly one H1 required")
    if int(page.get("word_count", 0) or 0) < 120:
        score -= 10; findings.append("thin content (<120 words)")
    if int(page.get("cta_count", 0) or 0) < 1:
        score -= 10; findings.append("no call to action")
    score = max(0, min(100, score))
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D"
    return {"score": score, "grade": grade, "findings": findings or ["clean"]}


def arize_mcp_config_from_env() -> dict | None:
    """Arize Phoenix MCP connection config from env, or None when unset.

    Returns {"url": str, "headers": dict} when ARIZE_MCP_URL is set; never raises.
    """
    url = (os.environ.get("ARIZE_MCP_URL") or "").strip()
    if not url:
        return None
    headers: dict[str, str] = {}
    key = (os.environ.get("ARIZE_MCP_API_KEY") or "").strip()
    if key:
        header_name = (os.environ.get("ARIZE_MCP_AUTH_HEADER") or "Authorization").strip()
        headers[header_name] = f"Bearer {key}" if header_name.lower() == "authorization" else key
    extra = os.environ.get("ARIZE_MCP_HEADERS")
    if extra:
        try:
            parsed = json.loads(extra)
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        except (ValueError, TypeError):
            pass
    return {"url": url, "headers": headers}


CANONICAL_FLOW = ["hero", "about", "items", "why", "cta", "contact"]


def ux_flow_review(blocks: list = None, audience: str = "") -> dict:
    """Review a proposed block sequence against the canonical conversion flow.

    Deterministic: checks hero-first, proof-before-ask and ends-on-action
    ordering, flags duplicates and non-canonical blocks. Returns a 0-100 flow
    score plus ordered issues the UX agent (Dana) narrates. Never raises.
    """
    seq = [str(b).strip().lower() for b in (blocks or []) if str(b).strip()]
    if not seq:
        return {"score": 0, "audience": audience or "general",
                "issues": ["no blocks proposed — fall back to the canonical flow"],
                "canonical": CANONICAL_FLOW}
    score, issues = 100, []
    if seq[0] != "hero":
        score -= 25; issues.append("hero is not first — visitors decide in the first screen")
    if "cta" in seq and "why" in seq and seq.index("cta") < seq.index("why"):
        score -= 15; issues.append("ask comes before proof — move 'why' above the CTA")
    if seq[-1] not in ("cta", "contact"):
        score -= 20; issues.append("page does not end on an action — close with cta or contact")
    dupes = sorted({b for b in seq if seq.count(b) > 1})
    if dupes:
        score -= 10; issues.append("duplicate blocks: " + ", ".join(dupes))
    unknown = sorted({b for b in seq if b not in CANONICAL_FLOW})
    if unknown:
        issues.append("non-canonical blocks (fine if intentional): " + ", ".join(unknown))
    return {"score": max(0, score), "audience": audience or "general",
            "issues": issues or ["flow follows conversion best practice"],
            "canonical": CANONICAL_FLOW}


VIBE_SYSTEMS = {
    "warm": {"palette": "cream / terracotta / espresso",
             "type_pairing": "serif display + humanist sans body",
             "corners": "soft (16px)",
             "imagery": "natural light, close textures, people mid-moment",
             "spacing": "generous, airy sections"},
    "bold": {"palette": "ink / electric accent / white",
             "type_pairing": "heavy grotesque display + tight sans body",
             "corners": "sharp (4px)",
             "imagery": "high contrast, strong color blocking",
             "spacing": "dense hero, wide rhythm below"},
    "trust": {"palette": "deep navy / slate / warm gray",
              "type_pairing": "transitional serif + neutral sans",
              "corners": "subtle (8px)",
              "imagery": "real team, real place — no stock clichés",
              "spacing": "even, predictable grid"},
    "fresh": {"palette": "white / leaf green / citrus accent",
              "type_pairing": "rounded sans throughout",
              "corners": "round (20px)",
              "imagery": "motion, outdoors, bright daylight",
              "spacing": "open, lots of whitespace"},
    "modern": {"palette": "near-black / off-white / single neon accent",
               "type_pairing": "geometric sans display + mono details",
               "corners": "medium (12px)",
               "imagery": "product UI, abstract gradients",
               "spacing": "tight hero, modular grid"},
}


def visual_system(vibe: str = "", category: str = "") -> dict:
    """Derive the deterministic visual design system for a vibe.

    Returns palette, type pairing, corner radius, imagery direction and spacing
    rules the visual agent (Remy) elaborates on. Unknown vibes fall back to the
    category's default vibe, then to 'modern'. Never raises.
    """
    v = (vibe or "").strip().lower()
    if v not in VIBE_SYSTEMS:
        v = INDUSTRIES.get((category or "").strip().lower(), {}).get("vibe", "modern")
    return {"vibe": v, **VIBE_SYSTEMS.get(v, VIBE_SYSTEMS["modern"])}


def frontend_check(page: dict = None) -> dict:
    """Pre-ship frontend checklist for the assembled page dict.

    Deterministic pass/fail items (single H1, meta description, script-free,
    mobile breakpoint, image alts) the frontend agent (Kai) reports on.
    Never raises.
    """
    p = page if isinstance(page, dict) else {}
    checks = {
        "single_h1": int(p.get("h1_count", 1) or 0) == 1,
        "meta_description": bool(str(p.get("description", "")).strip()),
        "script_free": not bool(p.get("has_scripts", False)),
        "mobile_breakpoint": bool(p.get("mobile_ready", True)),
        "image_alts": bool(p.get("images_have_alt", True)),
    }
    failed = [k for k, ok in checks.items() if not ok]
    return {"pass": not failed, "checks": checks, "failed": failed}
