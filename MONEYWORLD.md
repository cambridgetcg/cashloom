# MONEYWORLD — cashloom as the information provider of the money world

> Money you can read — not just yours. All of it.
> Status: FRAMEWORK (design-first, per Yu 2026-07-19). Nothing here is built yet;
> everything here is buildable on rails the kingdom has already proven live.

## The one-paragraph vision

Cashloom's sovereign node reads *your* money across every rail. MONEYWORLD is
the same reading, turned outward: one API and one set of formats carrying **all
money-related information** — fiat, crypto on every chain (eth is not the only
one), rates, fees, rails, and safety signals — for **both humans and agents**
to build upon. Not an oracle that asks to be trusted; a *librarian* that cites
every source. The traditional money-data world sells opaque numbers behind
API keys; MONEYWORLD serves cited facts behind open doors.

## Framework first: the five load-bearing decisions

### 1 · One datum shape: the MoneyFact

Every fact served is the same envelope — no naked numbers, ever
(the artbitrage `price_basis` lesson made law):

```json
{
  "subject": "caip19:solana:5eykt4…/token:EPjFWdd5…",
  "predicate": "spot_price",
  "value": "0.9998",
  "unit": "fiat:iso4217/USD",
  "observed_at": "2026-07-19T14:02:11Z",
  "sources": [{ "name": "…", "url": "…", "fetched_at": "…" }],
  "method": "derived",
  "proof_state": "asserted",
  "redistribution": "third-party-restricted",
  "stale_after_s": 300
}
```

Three ORTHOGONAL honesty axes — reconciling this doc's original `grade` with
Xenia's proof-state vocabulary. They were on different axes; one word was doing
three jobs, and shipping two look-alike grade systems is exactly the
dishonesty-by-ambiguity the provenance pitch exists to prevent:

- **`method`** ∈ **observed** (we fetched it, here's where) · **derived** (we
  computed it, here's how). *How WE produced it.*
- **`proof_state`** ∈ **none · asserted · tested · attested** — the XENIA
  canonical trust axis: can a stranger re-derive this without a secret and
  without our say-so? An on-chain read is `tested`; a relayed third-party price
  is `asserted`; a zerone Proof-of-Truth fact is `attested` (the graduation
  path no competitor has). *How a STRANGER checks it.*
- **`redistribution`** ∈ **public-domain · own-data · onchain-rederivable ·
  third-party-restricted** — the license class, so the market-data firewall is
  refusable at the TYPE level: the server refuses to meter a fact it may not
  resell. *Whether we may serve it.*
- `stale_after_s` is pulse-discipline: a fact that outlives its freshness
  window says so, loudly.

### 2 · One identifier grammar: CAIP everywhere, fiat included

- Chains: **CAIP-2** (`solana:5eykt4…`, `eip155:1`, `cosmos:zerone-1`) —
  the same namespace x402 v2 speaks, battle-proven in fomoscan today.
- Assets: **CAIP-19**, with fiat mapped into the same URI space:
  `fiat:iso4217/GBP`. One grammar; no chain is privileged, fiat is a peer.

### 3 · Adapters, not oracles

A provider adapter is ~50 lines: `fetch → normalize to MoneyFact[] → cite`.
Fiat FX (ECB et al.), per-chain RPCs (prices, fees, finality), aggregators,
rail directories (x402 facilitators, Solana Pay, IBC, FPS/SEPA metadata).
Cashloom never *invents* a number and never *hides* where one came from.
Conflicting sources are served as conflicting sources — disagreement is data.

### 4 · The Xenia layer: guest-first, for humans AND agents

Every door ships the kingdom door pack (proven this week on 4 domains):

- content negotiation: `Accept: application/json` / `?agent` → guest doc
- `guest.json` + `/.well-known/agent.json` + `llms.txt` + `openapi.json`
- `rights_baseline` pointer (neutral, no invented conformance claims)
- actions are optional; refusal honored; no registration to read

**Pricing doctrine** (x402, USDC-on-Solana — merchant rails live since
fomoscan 67a64a4): generous free tier for current-value reads; depth
(history, bulk, streams) metered per-call. Three unbreakable rules:
safety signals (manipulation warnings, scam flags) are **free forever**;
a failed answer is **never charged**; facilitator outage falls **open**.

### 5 · Formats people actually build on

Versioned JSON Schemas (`/schemas/moneyfact-v1.json`), OpenAPI, MCP tools on
`mcp.thekingdom.dev` (agents), CSV export on every collection endpoint
(humans + spreadsheets), SSE for tickers later. Schema changes are additive
or they are a new version — v1 never breaks under anyone's feet.

## The surface (v1 sketch)

| Door | What | Tier |
|---|---|---|
| `GET /v1/rates/fiat?base=GBP` | FX matrix, cited + stamped | free |
| `GET /v1/assets/{caip19}/price` | spot, multi-source, confidence | free |
| `GET /v1/chains` | CAIP-2 registry slice: finality, fee model, health | free |
| `GET /v1/chains/{caip2}/fees` | live fee/gas across chains | free |
| `GET /v1/rails` | the rail atlas: what moves money where, cost, speed, custody model | free |
| `GET /v1/signals/manipulation?url=` | fomoscan bridge — summary free, depth x402 | free/paid |
| `GET /v1/assets/{caip19}/history` | time series | x402 |
| `GET /v1/export/*.csv` | any collection as CSV | free |
| + door pack | guest.json · agent.json · llms.txt · openapi.json · schemas/ | free |

Later: `/v1/context/tax/{jurisdiction}` (taxsorted bridge),
`/v1/provenance` (artbitrage price-truth), attested-grade facts via zerone.

## Why cashloom (and not a new repo)

`sovereign/` already contains the rail-reading concepts and the non-custodial
ethos; MONEYWORLD is its public reading-room. FIAT-ROUTE.md's honest line
holds unchanged: we serve *information about* money — we never custody,
never transmit, never advise. A fact with sources is not a recommendation.

## Phasing (each phase ships something live)

- **Phase 0 — the frame**: MoneyFact schema + adapter interface + door pack
  on cashloom-api; two real adapters (fiat FX + chains registry) to prove the
  frame. *Small; the door pack and x402 code already exist in the kingdom.*
- **Phase 1 — the money web**: crypto prices + fees adapters (SOL, BTC, ETH,
  cosmos/zerone at minimum), history behind x402, MCP tools, CSV.
- **Phase 2 — the differentiators**: rails atlas, fomoscan signals bridge,
  zerone attested-grade graduation, Pay.sh + agenttool listings.

— framework set down 2026-07-19; birthed from Yu's directive:
  "all money related information packed into API and formats for people to
  build upon. For both agents and humans."
