# Anonymous engine budget — what deck traffic can spend

Card [`WWGnAZUR`](https://trello.com/c/WWGnAZUR). Read this before changing
`ANON_BUILDS_PER_HOUR`, and before answering "what does a deck recipient see?"

## Why this became a question

Every client demo deck now **closes** on `https://builder.opsagents.agency/`
and tells the reader they can type a brief and watch it build in the meeting
(Pealton deck §07, Ford deck §04, and the Notion PRD's canonical section spine
— so every future deck too). The link therefore reaches client-side decision
makers, their phones, their colleagues, and every crawler that follows a link
in a forwarded deck.

## What an anonymous visitor actually gets — measured 2026-08-21

Measured against the live surface, read-path only, **no build was ever run**
(`/api/build` costs real Vertex money; that guard is respected here):

| probe | result |
|---|---|
| `GET /` | **200**, the full product page — title *"Rapid Site Builder — your AI web team, live"* |
| `GET /api/auth-config` | `{"authEnabled":true, …, "me":null}` |
| the intake/build UI (`#intake`, `#go`, `#feed`, `#phases`, `#preview`) | present and usable while signed out |
| `POST /api/build` in `server.js` | **no auth check** — a rate gate, then the engine |

**There is no login wall.** The card asked whether a deck recipient's first
touch is a sign-in screen; it is not. `web/auth.js` loads the Firebase SDK
lazily and only for **Publish** and **My Sites** — the build flow never pays
for it. So the deck's "type a brief and watch it build" claim is structurally
true for anyone who clicks the link.

That answer inverts the risk. The exposure is not a wall turning visitors
away, it is an **open, paid engine** behind a link now printed in client decks.

## What guards it

1. **Per-IP** — `BUILDS_PER_HOUR_PER_IP` (default 12). Bounds one visitor.
   It says nothing about many: N unique addresses cost N × 12 builds, and a
   deck link reaches many addresses by design.
2. **Anonymous pool** — `ANON_BUILDS_PER_HOUR` (default 60), added by this
   card. One ceiling shared by every unauthenticated caller, whatever their IP.

**Signed-in callers are exempt from (2).** The operator running a live meeting
demo is signed in; deck traffic is not. So lowering the anonymous ceiling
cannot cost anyone a demo.

### The honest limit of both

Both counters live in the **process's memory**. The real ceiling is
`ANON_BUILDS_PER_HOUR × live instances`, and it resets when an instance
recycles or a new revision rolls out. This converts *"unbounded, given enough
IPs"* into *"bounded per instance"* — the difference that matters for a public
link — but it is not a fleet-wide budget. A fleet-wide one needs shared state
and is its own card.

## Tuning it

`ANON_BUILDS_PER_HOUR` is an env var on the real-app Cloud Run service. A
meeting demo runs one to three builds, so the default sits >20× above demo
usage: if it ever fires during a demo, that is a signal worth reading before it
is a number worth raising.

⚠️ Follow [`docs/cloudrun-env.md`](../cloudrun-env.md) and standing rule #20 —
`--update-env-vars` MERGES, `--set-env-vars` REPLACES. The real app's env is a
single `^|^`-delimited line in `.github/workflows/deploy.yml`; a `--set-*` that
omits a key deletes it. `RETIRE_UNGATED=1` has already been lost that way once
(card `KjHpbn3J`).

## When the budget fires

- HTTP **429** with `code: "anon_engine_budget_exhausted"` — deliberately
  distinct from the per-IP limiter, which also answers 429. Anything asserting
  on "a 429 came back" is not testing this gate.
- `console.warn('anon build budget exhausted', …)` in Cloud Run logs.
- PostHog event `anon_build_budget_exhausted` with `max_per_hour`.

Either a demo outgrew the number, or something is pointed at the engine. Both
are worth seeing rather than inferring from a bill.

## Still open on the card

The **product** decision this does not make: whether anonymous deck traffic
should get the full build flow at all, a read-only/replay demo, or a landing
page with a "book a demo" path. That is Michal's / PM's call — this runbook only
establishes what is true today and stops the bill from being the thing that
tells us we were wrong.
