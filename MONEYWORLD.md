# CashLoom World — product guide

**[Open World at cashloom.io/world](https://cashloom.io/world)** to read public
money observations with source receipts. No account or wallet is required.
The current service/workspace source is published in the private repository on
`release/service-workspace-20260929`. On 29 September 2026, its Cloudflare preview
passed 19 checks with zero failures; the hosted Capital flows API still returned
404. Production deployment is pending. The original framework below is design
history, not a list of current capabilities.

## What you can read

- **Observations:** policy and overnight cash rates, available sovereign yield
  curves, FX and BTC/ETH reference values, Bitcoin/Base fee observations, and
  scheduled central-bank meetings. Today is a sourced overview, not a claim that
  every observation changed today.
- **Receipts:** use an observation's **Receipt** button to inspect its original
  source, timestamps, method, supplied derivation inputs, and usage terms where
  available. A receipt explains provenance; it is not proof of accuracy or advice.
- **Freshness:** source observation times, fetch times, and World assembly time
  are different. A newly fetched snapshot need not contain new observations.
  Saved or stale snapshots and failed refreshes are labeled; check the receipt
  and **Sources / Coverage & freshness** before relying on a value.
- **Partial coverage:** unavailable sources and rights restrictions are disclosed.
  Brent/WTI benchmark values and UK yield-curve values remain withheld pending
  display rights; broader research coverage is incomplete. Missing values are
  not replaced with a proxy or an invented zero.

## Currency references and Watching

Choose **USD, EUR, GBP, JPY, CHF, CAD, AUD, or CNY**. The selector changes the
requested FX reference pairs and BTC/ETH reference currency. It does not convert
every observation, provide executable exchange quotes, or change a wallet.

Star cards, then use **Watching** to filter the observation-card sections to your
saved choices. Currency, stars, and the filter preference are stored in this
browser when local storage is available. This is local filtering, not alerts,
background monitoring, cross-device sync, or a history of watched values. World
also keeps bounded public snapshots locally for reloads and labels saved data.

## Hosted World and local software are separate

The hosted World website reads the public INFO service; that service's entrypoint
has no wallet vault, ledger, or transaction signers. You can run the same read-only
path with the [local INFO and frontend guide](README.md#run-the-existing-information-tools-locally).
Cloning or reading the source requires access to the private GitHub repository;
without access, GitHub may show “Page not found.” Public World use needs no
repository access.
It still uses upstream public data services and RPC endpoints, not an offline copy
of the money world. The [advanced local wallet](sovereign/README.md) is a separate
entrypoint with owner-controlled custody and signing capabilities.

[Onchain](https://cashloom.io/onchain) is a secondary read-only view of selected
chain and protocol observations. For current API discovery, start with the
[machine orientation](https://cashloom-api.fly.dev/v1/orientation), not the
historical endpoint sketch below. Read the
[data-practices disclosure](https://cashloom-api.fly.dev/v1/data-practices) for
application scope and external-layer unknowns: no account requirement is not an
anonymity guarantee, and hosting, networks, browsers, and upstream providers have
their own practices.

[Published release source](https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929)
requires private repository access and identifies the service/workspace source
branch, not the exact deployed revision.

## Capital flows — source and deployment status

`release/service-workspace-20260929` includes the separate, lazy `/capital-flows`
page and `GET /v1/capital-flows` API, with conditional GET/HEAD. The source is
published privately and the Cloudflare preview is verified. **The existing
hosted INFO service still returns 404 for this API**, as checked on
29 September 2026; the page shows the unavailable-feed boundary explicitly.
The public-only INFO image passed local Linux verification, which does not
establish hosted deployment. To run it locally, use the current release and the
[local INFO and frontend instructions](README.md#run-the-existing-information-tools-locally),
then open `/capital-flows` on the frontend and
`http://127.0.0.1:4747/v1/capital-flows` for JSON. INFO serves the API; Atlas serves
the human route. Neither path requires a wallet.

### What the selected flows mean

| Source / population | Measures and native reporting units | Limits |
|---|---|---|
| US Daily Treasury Statement, published Table II cash totals | Daily public-debt cash issues, cash redemptions, and compatible issues-minus-redemptions net; USD millions | Cash financing into the Treasury General Account, not raw debt-accounting aggregates, auction allotments or a change in outstanding debt stock. |
| ECB Spain and Germany central government excluding social security | Monthly all-maturity issuance, redemptions and net issuance at face value; EUR millions | Two named issuer markets, not all governments or cash-proceeds accounting. |
| ECB euro-area (changing composition) non-MMF investment funds | Quarterly equity, bond, real-estate and private-equity fund-share transactions; EUR millions | Fund domicile is neither investor nor underlying-asset geography. Nonconsolidated fund populations and overlapping PE categories must not be summed. Real-estate fund shares are not direct property investment; PE fund flows are not worldwide deals, commitments or calls/distributions. |
| Treasury TIC Grand Total `99996` | Monthly foreign purchases, sales and compatible net acquisitions of US long-term Treasury bonds/notes, corporate/other bonds and equities; USD millions | `_sale` means US sales to foreigners (foreign purchases); `_pur` means US purchases from foreigners (foreign sales). Settlement-cost transactions include primary issues/redemptions: not pure secondary turnover. Expenses are included in US purchases; US sales proceeds are net of charges. No Table III bill stock-difference estimates. |

All seven asset categories remain visible: sovereign debt, equities, bonds,
precious metals, crypto, private equity and real estate. Crypto and metals broad
investment flows, other sovereign issuer regions including China/UK/Japan,
broader BIS coverage, global secondary volume, direct property and worldwide PE
calls/distributions remain explicit gaps—not a real-time worldwide census.
Onchain supply, bridges, prices and TVL are not substitutes for investment flows.
No cross-source global total, wrapper-plus-underlying sum, mismatched-period
comparison or historical conversion using today's FX is supplied.

### Read periods, values, history and receipts

The [typed API contract](sovereign/src/info/capital-flows/model.ts) uses schema
`cashloom.capital-flows/1` and media type
`application/vnd.cashloom.capital-flows.v1+json`. Read `series[].definition` for
`metricKind`, `perspective`, `signConvention`, `geography`, `valuation`, `unit`,
`seasonalAdjustment` and `annualization`. The geography dimensions separately name
issuer, investor, reporting, custodial and fund domicile where known.

Each `series[].history[]` observation keeps its `period` start/end/frequency,
`completeness`, revision/provisional flags, and nullable `value`. Exact
`value.raw × 10^-value.decimals` is the native-unit decimal; `unitMultiplier`
converts that to currency units (`unitExponent: 6` means millions). Preserve
`publisherLexeme`, `currency` and the multiplier; do not sum unlike units.
`status` distinguishes observed zero from `missing`, `suppressed`,
`notYetReported` and `withdrawn`; `rightsWithheld` series contain no numeric history.

Receipts identify `sourceSeriesId`, `datasetId`, `resourceUrl`, `method`, `recipe`,
`inputObservationIds`, limitations, `retrievedAt` and nullable `publicationAt`.
`generatedAt` is snapshot assembly time; a new retrieval does not move the
reporting period forward. `reportingRecency: expectation_unknown` means no
publication schedule has been inferred, not that an old period is up to date.
Open a row's history and receipt before comparing values or relying on a revision.
History is latest-revised publisher data, **not an archive of prior vintages**:
up to 60 daily, 26 weekly, 24 monthly or 20 quarterly observations per series,
subject to what the selected publisher provides. No weekly source or auction
feed is enabled; the model's 30-event ceiling is not auction coverage.

### Refresh, failure and reuse boundaries

Reads initiate bounded source rechecks only when due: normally hourly for daily
sources and six-hourly for monthly/quarterly sources, with failure backoff.
Manual refresh cannot bypass those limits. An independent single-flight RAM
cache keeps capital fetching out of World's critical path. A cold read waits at
most one second, then can return completed sources with partial/refreshing states.
The page's completion checks are bounded to four within 30 seconds, then stop;
this is not continuous monitoring or alerts.

Inspect `refresh.state`, `refresh.health`, `sources[].retrievalState`,
`series[].state`, `coverage` and limitations. `refresh.launchReadiness: notAssessed`
is not a source-coverage certification. Failed refreshes retain original last-good
histories and receipts for at most seven days after successful validation;
`sources[].nextAttemptAt` and `fallbackExpiresAt` name the boundaries. RAM loss
clears the fallback. Rights restrictions withhold values before fetch/serialization.
No accounts, execution, database, continuous collector or application-level
persistent browser snapshots/preferences are added by Capital flows.

Source receipts and `sources[].definition.rights` carry the scoped reuse evidence:

- [FiscalData API terms](https://fiscaldata.treasury.gov/api-documentation/) permit
  copying, adaptation and redistribution, including commercial use.
- [ECB reuse conditions](https://www.ecb.europa.eu/services/disclaimer/html/index.en.html)
  require attribution and disclosure of modifications. **These data are available
  free of charge from the ECB**; CashLoom does not charge for access. Selection,
  normalization and derived nets are disclosed in the receipts.
- TIC reuse relies on the [US government-work/public-data basis](https://www.copyright.gov/title17/92chap1.html#105)
  for Treasury's [official SLT aggregate provenance](https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/tic-slt-form-and-instructions),
  not blanket permission for government-hosted third-party files, vendor or
  branding rights, or confidential reports.

The new API is discoverable through local `/v1/orientation` and `/v1/guide`, but
is **not** one of XENIA Surface's three deterministic resources. Cold partial
responses, single-flight caching and cache fall-through are not themselves a
Surface-conformance result. Hosted INFO remains process-wide non-custodial;
local sovereign public reads remain a route-scoped boundary alongside its
separate private wallet. Fixture tests and source suitability are not live
adapter or deployment verification.

## Historical proposals — not shipped capabilities

The original 2026-07-19 framework is preserved below as historical proposals.
Its universal coverage, pricing, exports, integrations, example schemas, and
phases are not a current service contract or evidence that those capabilities
shipped. Some ideas informed today's product; use the guide above and machine
orientation for the implemented surface.

<details>
<summary>Original MONEYWORLD framework and roadmap (2026-07-19)</summary>

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

</details>
