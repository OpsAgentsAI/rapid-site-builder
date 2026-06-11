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
