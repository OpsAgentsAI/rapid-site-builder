# Managed vs BYOK — Tier Sheet

> # ⚠️ DRAFT — NOT APPROVED, DO NOT PUBLISH
>
> **Status:** awaiting Michal's approval (Trello card [1z5hAnJv](https://trello.com/c/1z5hAnJv), BYOK-B).
> Nothing in this document may be rendered on any user-facing surface, quoted to a
> customer, or wired into checkout until Michal approves it. Every number below is
> either (a) cited from the LOCKED canonical pricing page in Notion, or (b) marked
> **TBD (Michal)**. No number here was invented.

---

## 1. What this is (and is not)

Rapid Site Builder's auth-ON surface (`real-app` → `rapid-builder-app`) now has:

- a **plan** axis — `free | paid` (card KY2YTmoL, `lib/entitlements.js`: free-site cap, expiry, checkout CTA), and
- a **tier** axis — `managed | byok` (this card, `lib/tiers.js`), keyed to the BYOK-A
  provider abstraction (card Azz8fInK, `lib/providerConfig.js`: `source: 'byok'|'managed'`).

The two are **orthogonal**: a paid customer is either *Managed* (we run cloud + AI on
our keys) or *BYOK* (they bring their own Vertex/Arize keys; software-only license).

**This is NOT a revival of the retired flat managed monthly tiers.** The Notion
canonical ([OpsAgents Product Pricing Menu](https://www.notion.so/38238b5dfb2781559f59e780b07d65d8),
LOCKED 2026-06-21, conflict resolution 2) removed the catalog-wide "$2,200 / $4,400 /
Enterprise" managed tiers. What is proposed here is a **per-product deployment/credential
tier for one product (RSB)** — who owns the cloud and model keys — consistent with the
locked "products + product bundles" model. It still needs Michal's explicit sign-off
because the canonical currently lists RSB as free (see §2).

## 2. Canonical baseline (what the Notion pricing page says today)

| Canonical row (Notion, LOCKED 2026-06-21) | Value | Relevance here |
|---|---|---|
| §C "Live self-serve" → **Rapid Site Builder** | **Free, no signup** | Current public state. Any paid RSB tier is a *change to the canonical* and needs Michal to amend the LOCKED page. |
| §C → CLI Gateway | Free $0 · Starter **$29/mo** · Pro **$99/mo** · Scale **$299/mo** (+$19/CLI · +$49/MCP · +$99/API add-ons) | The house pattern for self-serve tool tiers + add-ons — the closest comparable for RSB tiering. |
| §C → MSApps Lead Pipeline | **$149/mo** | Comparable single-product SaaS price point. |
| LOCKED §A roster agents | Maya **$299** · Sales **$249** · Michelle/Support **$199** · Ops **$199** · Finance **$199** · Marketing **$99** /mo | Upper band for agent-powered products. |
| LOCKED bundles | Starter **$349** · Growth **$599** · Full Ops Team **$899** /mo · Pilot 2wk 50% off | Bundle framing if RSB joins a bundle later. |
| §D 2026-06-08 guidance | AI agents **$49–199/mo**, **90%+ gross margin** — "price for adoption, not cost" | Margin guardrail this tier sheet must respect. |
| §D cost floors | ~**$5–6/agent/mo** · image ~**$0.03** · 5-sec video ~**$2** | Managed-tier COGS floor inputs. |
| Currency rule (2026-07-14) | Self-serve digital = **USD-primary** ($ on EN + HE; ₪ toggle only) | RSB tiers are USD-primary. |
| §E hourly | MSApps dev **₪250/h** · Architects **₪350/h** · HITM **₪250/h** | Rate for any human onboarding/key-setup services attached to a tier. |

Everything below that is *not* one of these cited values is **TBD (Michal)**.

## 3. The two tiers

### 🏢 Managed — "we run everything"

We host cloud + AI on **our** keys and projects. The customer signs in and builds;
nothing to configure.

**Includes**

- Site build + publish on our Cloud Run / Hosting surface (`rapid-builder-app`)
- Model calls (Agent Engine) + image generation on **our** Vertex credentials
  (`providerConfig source: 'managed'`)
- Observability on our Arize Phoenix space
- Ops, upgrades, incident response — SLA-backed support (`slaSupport: true`)
- Free-plan cap/expiry rules per KY2YTmoL until upgraded to `paid`

**Economics** — target gross margin **~85–90%** (card brief target, consistent with the
canonical §D "90%+ gross margin" guidance; cost floor inputs: ~$5–6/agent/mo + ~$0.03/image,
canonical §D). We absorb provider spend (`providerCostsBilledToTenant: false`), so the
price must clear the model-spend floor with headroom.

### 🔑 BYOK — "bring your own keys"

Software-only license. The customer supplies their **own** Vertex project / Agent
Engine resource / image project and (optionally) their own Arize space; our code runs
against **their** credentials (`providerConfig source: 'byok'`, via
`TENANT_PROVIDER_CONFIG` or per-call overrides).

**Includes**

- The same build path, byte-identical code (BYOK-A design guarantee)
- Their model + observability spend on their own GCP/Arize billing
  (`providerCostsBilledToTenant: true`)
- Community/basic support only (`slaSupport: false`); no managed hosting ops
- Cheaper entry price than Managed — the entry ramp

**Economics** — target gross margin **~95%+** (card brief target): near-zero marginal
COGS since model spend is theirs.

**IP note (both tiers):** the product stays proprietary. Keys are *injected*
(env/config), source is **never shipped** to the customer in either tier — BYOK is a
license to run against your credentials, not a source hand-off.

## 4. Rate card — DRAFT (all RSB-specific prices TBD)

> No RSB tier price exists in the Notion canonical (RSB row = "Free, no signup").
> Per the no-invented-numbers rule, every RSB price below is **TBD (Michal)**.
> Bracket suggestions reference cited canonical rows only.

| Row | 🔑 BYOK (entry) | 🏢 Managed (premium) | Canonical anchor |
|---|---|---|---|
| Free plan (status quo) | n/a — free plan runs managed keys | Free · cap `FREE_SITE_CAP` sites · 30-day expiry (KY2YTmoL) | Notion §C: RSB "Free, no signup" |
| Monthly license | **TBD (Michal)** | **TBD (Michal)** | CLI Gateway band $29/$99/$299 (§C); Lead Pipeline $149 (§C); agents guidance $49–199 (§D) |
| Annual (discount %) | TBD (Michal) | TBD (Michal) | — (no canonical row) |
| **Custom domain** (card [SXePLiLL](https://trello.com/c/SXePLiLL)) | **Reserved as PAID add-on anchor — price TBD (Michal)** | **Reserved as PAID add-on anchor — price TBD (Michal)** | — (row reserved; the add-on pattern mirrors CLI Gateway's +$19/+$49/+$99 add-ons, §C) |
| Extra live sites beyond plan cap | TBD (Michal) | TBD (Michal) | — |
| Image/video generation overage | Billed to customer's own Vertex project (their GCP bill) | TBD (Michal) | Cost floor: image ~$0.03 · 5-sec video ~$2 (§D) |
| Key-setup / onboarding (human, optional) | TBD (Michal) — anchor: hourly canon | Included | ₪250/h MSApps · ₪350/h Architects (§E) |
| SLA / support | Community only | Included | — |
| Currency | USD-primary | USD-primary | Currency rule 2026-07-14 |

## 5. Upsell triggers — BYOK → Managed

The BYOK tier is the entry ramp; these are the moments the product (and sales copy)
should surface the Managed upgrade:

1. **Key-management pain** — expired/rotated service-account keys, `TENANT_PROVIDER_CONFIG`
   misconfiguration, IAM drift. Every BYOK build that falls back to managed creds is
   flagged by `assertTierConsistency()` (lib/tiers.js) — each flag is an upsell event.
2. **Cost visibility** — the customer can't predict their own Vertex bill; Managed is
   one flat line item instead of variable GCP spend.
3. **SLA** — an outage in *their* project is theirs to debug on BYOK; Managed includes
   ops + incident response (`slaSupport`).
4. **Quota/region friction** — their project lacks model quota or the right regions;
   ours is pre-provisioned.
5. **Team growth** — more editors/sites than they want to administer IAM for.

(Downgrade path Managed → BYOK also stays open — it protects churn: a cost-sensitive
customer keeps a license instead of cancelling.)

## 6. Enforcement mapping (code, shipped in this PR)

| Capability (`lib/tiers.js`) | managed | byok |
|---|---|---|
| `managedAI` | ✅ | ❌ |
| `requiresProviderKeys` | ❌ | ✅ |
| `managedHosting` | ✅ | ❌ |
| `managedObservability` | ✅ | ❌ |
| `slaSupport` | ✅ | ❌ |
| `providerCostsBilledToTenant` | ❌ | ✅ |

`tierGate(tenant, capability)` returns the same `{ ok / status / body }` contract as
KY2YTmoL's `publishGate`; wiring into `server.js` / `lib/entitlements.js` is a
**documented post-merge TODO** (those files belong to sibling PRs this cycle).

## 7. What Michal needs to decide (approval checklist)

- [ ] Approve the Managed/BYOK tier axis for RSB at all (canonical currently says RSB is free)
- [ ] Managed monthly price (USD)
- [ ] BYOK monthly price (USD, below Managed)
- [ ] Custom-domain add-on price (card SXePLiLL anchor)
- [ ] Annual discount, overage rows, onboarding-service pricing
- [ ] Amend the LOCKED Notion pricing page accordingly (only Michal edits the canonical)

*Prices are DRAFT pending Michal approval; nothing here is rendered to users.*
