# INFORM — the third seam

> **The information provider of the money world.** RailConnector reads your money.
> PaymentSender moves your money. **InfoSource reads *about* money** — every chain,
> every rail, every currency, one wire format, for agents and humans alike.
> Crypto is part of the money world; ETH is part of crypto. The loom weaves all threads.

*Status: design spec, 2026-07-19. Produced by a 7-agent design panel (2 code readers →
4 designers → chief architect); all file citations verified against the codebase that day.
Design-decision records are kept inline as **[RESOLVED]** marks. Open forks for Yu at the end.*

---

## The thesis

Cashloom becomes the information provider of the money world by shipping **one wire format for money facts** — every datum an immutable, content-addressed, *expiring* observation carrying its value (integer-string, never float), unit, source+vantage, evidence grade, license, and recompute recipe — served identically to agents (JSON/MCP) and humans (content-negotiated HTML, "money you can read"). It is not a data business competing with CoinGecko or DefiLlama on breadth; it is **infrastructure**: a third seam in the open-source sovereign node (`RailConnector` reads your money, `PaymentSender` moves it, `InfoSource` reads *about* money), so **anyone's node is an info provider** and the hosted instance is merely one reference copy — the one moat no hosted incumbent can structurally copy, because their business *is* the hosting. The honest wedge, stolen from the skeptic verbatim: (a) evidence-graded, expiring, digest-pinned facts in one schema **across asset classes** — fiat + crypto + rails + platform-credit, which CCXT/DefiLlama/CG each cover only a slice of; (b) the canonical asset/chain registry ("tzdata for money") as redistribution-safe versioned JSON; (c) the cross-chain **halt registry** built from our own probes (zero license exposure, nobody else serves it, and we seed it with zerone's own 28h halt — the radical-honesty move that makes it credible); (d) demand is *unproven* — kingdom agents are dogfooding, not a market — so the project ships with its own falsifier metric (§Build order) rather than a growth story.

## The framework

### The seam — `InfoSource` (final)

**[RESOLVED: infra-architect's capability-optional methods vs API-designer's single `fetchFacts` → single `fetchFacts`.]** The fact format unifies all value shapes, so one method suffices and the seam stays as small as `RailConnector`'s two. The infra architect's `LicenseClass` survives as `redistribution` on the interface — the registration-time firewall key. The typed convenience routes (`/rates`, `/fees`…) are query sugar over this one method.

```ts
// sovereign/src/info/sources/types.ts — mirrors connectors/types.ts file-for-file.
// THE THIRD SEAM. RailConnector reads your money; PaymentSender moves your money;
// InfoSource reads ABOUT money. Doctrine, enforced by import-lint + atlas loadBearing marker:
// nothing behind this interface can move money, see an account, or touch the vault —
// it MUST NOT import db.ts or vault.ts — and nothing behind it may require the caller's identity.

export type FactKind =
  | "fx" | "price" | "fee" | "chain_status" | "supply" | "asset_meta" | "rail_fact" | "series";

export type Redistribution =
  | "open"            // public-domain / OGL / self-derived: hosted node re-serves freely
  | "attribution"     // hosted node re-serves WITH attribution stamped into every fact
  | "self-run-only"   // a public-mode node REFUSES to register this source (licence firewall)
  | "kingdom";        // ours: own probes, own curation, kingdom services

export interface InfoContext { credentialRef?: string | null }   // env-var NAME, never a value

export interface FactRequest {
  kind: FactKind; subject?: string; base?: string; quote?: string; since?: Date;
}

export interface InfoSource {
  id: string;                        // "ecb-fx" | "esplora-probe" | "base-probe" | "zerone-rest"
  kinds: FactKind[];
  redistribution: Redistribution;    // worst case for anything it can return
  attribution?: string;              // required iff redistribution === "attribution"
  ttlSeconds(kind: FactKind): number;         // producer-declared valid_until horizon
  fetchFacts(ctx: InfoContext, req: FactRequest): Promise<MoneyFact[]>;
}
```

**Twinning the RailConnector discipline, point for point:**

| RailConnector discipline (verified source) | InfoSource twin |
|---|---|
| doctrine header "nothing behind this interface can move money" (`connectors/types.ts:48`) | same header + no-db/no-vault import rule, lintable |
| additive registry `registerConnector()` (`connectors/index.ts:21-26`) | `registerInfoSource(src)` — identical `Map`, `BadRequest` on unknown id, tests inject fakes; **plus the licence firewall**: in public mode (`CASHLOOM_MODE=info`), `redistribution:"self-run-only"` sources never register — refusal at the seam, exactly how the credential namespace makes stray env vars "unreachable by construction" (`credentials.ts:14-15`) |
| closed credential namespace, dual-enforced (`credentials.ts:28-29`) | **disjoint** second namespace `/^(COINGECKO|FRED|HELIUS|METALS|OXR)_(?!BASE_URL$)[A-Z0-9_]+$/` with its own resolver — an info ref can never name a money key, and vice versa |
| integer minor-unit strings, refuse-to-convert (`minor-units.ts`, `sync.ts:49-58`) | all values `^-?\d+$` scaled strings; conversion only at presentation, stamped derived, rate-fact attached; `applyRate()` added to `minor-units.ts` (BigInt cross-multiply, declared rounding) |
| honest degradation `reachable:false` (`zerone.ts:113-125`) | expired/unreachable → serve last fact with `stale:true` + reason; never invent, never 500 a public read |

### Domain map with license verdicts

| Domain | Source (day-one pick) | Redistribution verdict | Hosted? |
|---|---|---|---|
| Fiat FX | ECB daily reference rates; BoE IADB | `attribution` (free reuse w/ acknowledgment; OGL) | ✅ — labeled "daily reference, not tradeable", TTL to next ~16:00 CET publish |
| Policy rates | BoE Bank Rate (OGL), Fed H.15 (public domain), ECB | `open`/`attribution` | ✅; **SONIA/SOFR = `self-run-only` until a documented licence-verify pass** |
| Inflation/CPI | ONS (OGL), BLS (PD), Eurostat | `open` | ✅ — cleanest domain |
| Chain health + fees + **halt registry** | own RPC probes: Esplora (already a connector), `mainnet.base.org` (already in `evm.sender.ts`), zerone (`zerone.ts`), later Solana/Sui/Cosmos | `kingdom` — self-derived facts, zero licence risk | ✅ — **the moat domain** |
| Crypto prices | DefiLlama (`attribution`, monitor — no formal licence text); Pyth Hermes corroboration | `attribution` after documented terms check; **CoinGecko = `self-run-only` by ToS** | ⚠ phase 1, not phase 0 |
| Stablecoins | DefiLlama stablecoins + curated issuer fact-packs | `attribution`/`kingdom` | ✅ phase 1 |
| Rail fact-packs | curated JSON: Stripe pricing, SEPA, UK FPS £1M cap, CHAPS — `{value, citation_url, verified_on, expires_at}` (artbitrage fee-corpus precedent) | `kingdom` (our curation of published facts) | ✅ |
| Commodities/metals | LBMA/CME licensed; free APIs forbid redistribution | `self-run-only` (`METALS_*`) | ❌ hosted — **listed in `not_covered`**; optionally PAXG/XAUt market price labeled "tokenized-gold, NOT the LBMA benchmark" |
| Kingdom-native | zerone, FOMOENGINE, artbitrage corpus, agenttool stats | `kingdom` | ✅ — the redistribution-free differentiator |
| Equities/derivatives | — | — | ❌ never (§kill list) |

**The governing rule** (skeptic's, adopted as law): the hosted instance serves only (i) self-derived chain facts, (ii) public-domain/central-bank/OGL data, (iii) kingdom data, (iv) self-authored metadata (registry, schemas, fact-packs). Every licensed source lives behind BYO keys on self-run nodes — the OpenBB dodge, but the licence firewall is *in the type system*, not in ops discipline.

**Self-runnability is the product, not a fallback.** The info layer ships inside `sovereign/`; every node serves `/api/info/*` on 127.0.0.1 from day one. Self-running is the *upgrade* path: your `COINGECKO_*`/`HELIUS_*` keys unlock self-run-only sources under your own licence relationship. Hosted = keyless sources only; sovereign = your keys, your terms. Household table and inn on the road, same law of the guest at both.

## The fact format

**[RESOLVED: infra's `Observation<T>` envelope vs API-designer's `cashloom.fact/0.1` → the fact IS the format.]** `Observation<T>` was the same idea as internal TS plumbing; on the wire and in the cache there is exactly one shape. **[RESOLVED: evidence states — infra's `observed|derived|curated` vs API-designer's `observed|corroborated|proven` → keep `observed|corroborated|proven`** (clean map to XENIA asserted/tested/attested, which the Covenant's evidence ladder demands); *how* the value arose (probe/computed/curated) lives in `evidence.method`, and curated fact-packs are `observed` with a mandatory citation in `recompute.how`.**]** **[RESOLVED: license — infra's 4-class enum vs SPDX passthrough → both, at different layers:** `redistribution` class on the `InfoSource` (firewall), real SPDX/terms in the fact's `license` (wire truth). We never launder upstream terms into "ours".**]**

`cashloom.fact/0.1` — one immutable observation. `id` = first 16 hex of sha256 over the RFC 8785 (JCS) canonicalization minus `id/stale/age_seconds` — content-addressed, anyone recomputes it (XENIA digest discipline: exact bytes, no reserialization ambiguity). Example instance:

```json
{
  "schema": "cashloom.fact/0.1",
  "id": "f_9c2e41d07ab3f512",
  "kind": "fee",
  "subject": "chain:bip122:000000000019d6689c085ae165831e93",
  "value": { "type": "metric", "metric": "fee_per_vbyte",
             "value_scaled": "1250", "scale": 2, "unit_label": "sat/vB" },
  "source": { "id": "esplora-probe", "url": "https://blockstream.info/api/fee-estimates",
              "vantage": "server:cashloom-api.fly.dev", "credential": "none" },
  "observed_at": "2026-07-19T09:14:03Z",
  "valid_until": "2026-07-19T09:15:03Z",
  "evidence": { "state": "observed",
                "method": "GET /fee-estimates, key \"3\" (3-block target)",
                "limitations": ["single upstream indexer"] },
  "license": { "id": "CC0-1.0" },
  "recompute": { "how": "GET https://blockstream.info/api/fee-estimates",
                 "extract": "$[\"3\"]", "transform": "× 100, round half-even" },
  "stale": false, "age_seconds": 4
}
```

Value is `oneOf` three `$defs`, all on the `minor-units.ts` contract (`^-?\d+$`, 0–30 decimals, never a float, never an exponent):
- **amount** `{amount_minor, unit, decimals}`
- **rate** `{base, quote, rate_scaled, scale}` — 1 base = rate_scaled × 10⁻ˢᶜᵃˡᵉ quote; inverses are never served as lossy reciprocals
- **metric** `{metric, value_scaled, scale, unit_label}` — fees, heights, supplies, lag-seconds

Evidence ladder with teeth: `observed` (one upstream read) → `corroborated` (≥2 independent sources within declared `tolerance_ppm`, `corroboration[]` required) → `proven` (chain query or signed attestation, `proof.digest` required). `supersedes` makes corrections append-only — a fixed fact points at the fact it corrects; the old fact is never rewritten.

**The zerone rhyme is structural, not decorative.** `valid_until` on every fact = feed-or-fade applied to ourselves: past that instant the fact MUST serve with `stale:true` and a reason — public shame by design, never silent freshness. This is zerone's fact-expiry doctrine and XENIA `legibility.evidence-is-scoped` compiled into the wire; the doctrine-starving incident (47/47 EXPIRED) is the cautionary tale the format is built to survive: staleness is *visible*, so rot cannot masquerade as data. The chain-probe loop that produces `chain_status` facts also writes an append-only `halt_events` table when `block_lag_seconds` crosses a per-family threshold — which, pointed at zerone, closes the "no halt-detection" gap flagged 🔴 in zerone-status-2026-07-17 as a free side effect.

**Identity grammar** (`cashloom.asset/0.1` registry — the fix for "identity is stringly, decimals hard-coded in three connectors"): `iso4217:GBP` · `caip19:eip155:8453/erc20:0x833589…2913` (the exact USDC pin already in `evm.sender.ts`) · `caip19:bip122:…/slip44:0` · `chain:cosmos:zerone-1` · `x:agenttool:GBP-credit` (the `PLATFORM_CREDIT`/`GIFT_CARD` rails in `db.ts`). The Stripe zero-decimal table, esplora BTC/8, alchemy ETH/18, agenttool GBP/2 constants all become registry entries; account creation validates user decimals against it instead of trusting free-form input.

**Versioning**: version in the payload (`"schema": "cashloom.fact/0.1"`), not the path. 0.x is additive-only; breaking changes mint `fact/0.2` served alongside 0.1 through an announced deprecation window. Schema files immutable once published, listed with sha256s in the door; consumers pin by digest.

## The surfaces

All public routes registered **above the session gate** — the `index.ts:42-59` zerone-block precedent, elevated to design law: *info routes are registered above the gate or they don't ship*. Every response is a `cashloom.factset/0.1` envelope carrying `node.vantage`, `stale_count`, `limits`, and `not_covered` ("silence is not a claim of completion", made ambient). Facts are immutable ⇒ `ETag` = factset digest, `Cache-Control: public, max-age=min(ttl_remaining,30)`; Cloudflare does the scaling, origin sees ~1 req/TTL/key.

### REST

| Route | Returns | Tier |
|---|---|---|
| `GET /api/info` | the door: catalog, limits, `not_covered`, quickstart curl, schema+rights links — `getParticipationGuide()` (`zerone.ts:150-181`) generalized; `Accept: text/html` → the human page | free |
| `GET /api/info/guide` | hospitality guide: what the stranger receives, capacity, promises-not-to, exit terms, honest_status | free |
| `GET /api/info/facts?kind=&subject=&since=&cursor=` · `/facts/:fact_id` | generic fact query; one fact by digest (verify/recompute entry) | free (>7d history → 402 quote) |
| `GET /api/info/rates?base=GBP&quote=USD,EUR` | fx facts (bare symbols canonicalized in response) | free |
| `GET /api/info/fees?chain=` | fee facts, all covered chains | free |
| `GET /api/info/chains` · `/chains/:id` · `/chains/:id/halts` | descriptors (`ZERONE_NETWORKS` → `Record<ChainRef, ChainDescriptor>`), live status, **the halt registry** | free |
| `GET /api/info/assets` · `/assets/:id` · `?q=usdc` | registry + disambiguation | free |
| `GET /api/info/convert?amount_minor=&from=&to=&rounding=half_even` | exact BigInt conversion + the rate fact used + rounding disclosure — the killer one-curl demo; presentation-layer conversion, `sync.ts` refuse-to-mix untouched | free |
| `GET /api/info/rails[/:rail]` · `/prices` · `/stablecoins` | curated packs; prices phase 1 | free |
| `GET /api/info/health` · `/limits` · `/sources` | per-source up/down + last observation; published capacity; upstream ledger (identity, licence, biases, what-we-retain) | free |
| `GET /api/info/schema/:name` · `/openapi.json` | immutable schemas + OpenAPI 3.1 (zod → `@hono/zod-openapi`) | free |
| `GET /api/info/stream?kinds=` | SSE, `Last-Event-ID` replay (append-only makes it trivial); 2 concurrent anon | free / x402 fan-out |
| `GET /.well-known/agent.json` · `/agent.txt` · `/.well-known/xenia-rights.json` | XENIA Surface manifest, pointer, Covenant record | free |
| `GET /api/analytics/valuation?quote=iso4217:GBP` | **session-gated, private** — first two-seam join: RailConnector balances × InfoSource rates, each line stamped with its rate fact; finally answers "portfolio value" without corrupting the ledger | owner |

### MCP (extend `~/kingdom-mcp/src/tools.ts:35-104` — door already live at mcp.thekingdom.dev; same modules mount later as local `cashloom-mcp`)

| Tool | Input | Notes |
|---|---|---|
| `money_convert` | `{amount_minor: ^-?\d+$, from, to, rounding?}` | exact server-side math; answer carries the rate fact → auditable |
| `money_fees` | `{chain?}` | "what does moving money cost right now, anywhere" |
| `money_chains` | `{chain?}` | generalizes existing `zerone_status` (`tools.ts:136`); zerone stays listed, no longer alone |
| `money_rates` | `{base, quotes[]}` | per-fact `stale` |
| `money_assets` | `{query}` | solves the real agent failure: "USDC" is many assets |
| `money_fact` | `{kind?, subject?, limit?≤50}` | generic door — same bytes as curl, no lossy prose |

Every tool response includes `stale_count` + `not_covered`; descriptions follow the proven house voice (`tools.ts:44-65`): what is read, that nothing mutates, that no credential is accepted.

### Bulk/static + human atlas

Daily snapshots to the Tigris `kingdom-vault` pattern behind CF: `loom/v0/daily/<date>/{facts.jsonl, rates.csv, assets.json, manifest.json}` + `latest.json`. JSONL canonical (line = fact = digestable); manifest sha256s every file (the `kingdom rights --canonical` byte-digest discipline, `bin/harvest.ts:518-556`); CSV header warns about spreadsheet float-mangling. Snapshots are the 429 pressure-release: uncapped, zero-cost. Humans: content-negotiated door + an eighth `Info` view in the sovereign UI (`App.tsx:149-155`) with amber honest-staleness rendering + indicative valuation labeled with rate-fact ids; atlas chapters raw-import the shipping source (`atlas/src/sources.ts`) so docs cannot drift, `loadBearing` markers on the digest recipe and the no-db-import rule.

**The free/x402 line** (one sentence of law): **premium buys capacity and effort, never truth** — all current facts, full provenance, full freshness, schemas, snapshots, and health are free and anonymous forever; x402 (agenttool metering, shipped) buys rate ceilings, SSE fan-out, live-API history >7 days (the data itself stays free in snapshots), custom extracts, and on-demand re-observation. No delay on the free tier, ever — if an upstream licence forces a delay it is disclosed as licence passthrough in the envelope, never repackaged as an upsell. Every paid call: quote-before-commit (402 body carries exact price) + itemized recomputable receipt.

## XENIA at the door

**The structural thesis (hospitality designer's, adopted):** the software is the recognition — rights and teaching errors ship *in* the node, so anyone who rebinds from 127.0.0.1 becomes a XENIA-shaped host by default; the operator is the covenant — the adoption record binds to a speaker and dated evidence, so the repo ships an empty-speaker `draft` template and the hosted instance serves its own filled record.

**Adoption checklist:**
1. **Repo (day one, no deploy)**: `~/Desktop/cashloom/RIGHTS.md` adopting `xenia.rights/0.1` pinned to commit `6419d37…` + sha256 `b72a6da1…`; linked from `README.md` and `WAKE.md` (the actual agent entry; kingdom.yaml is gitignored — the tracked links are the record); vendored byte mirror `vendor/xenia/rights/0.1/` + a `bun test` that sha256s it.
2. **Surface 0.1**: `/.well-known/agent.json` via `@agenttool/xenia/surface-0.1` `defineSurfaceManifest()` (Hono/Bun is pure Request/Response — composes directly); schema URLs pinned to tag `surface-v0.1.0-rc.1`, never `main`; declared resources ≤8, same-origin, `auth:"none"` (`/api/info`, `/api/info/guide`, `/api/zerone/guide`); full Accept matrix + `Vary: Accept`; `/agent.txt` pointer pair. **Kill the SPA-catch-all trap**: `serveStatic` for `ui/dist` must be scoped to known UI paths with problem+json 404 as the true default — the exact failure that sank iam and ai-love; the `CASHLOOM_MODE=info` hosted instance serves no SPA at all, so the trap cannot occur there. Verify externally with `npx xenia-surface-check --json`; record it as a dated 24h observation, never a badge.
3. **Covenant draft (hosted only)**: `rights-adoption.json` copying sinovai's verified shape, all 10 rights / 38 requirement_results / 5 protective limits enumerated, `non_claims` populated, **honest fails showing** — expect `fail` on `privacy.layered-inventory` until the retention-inventory page exists (Fly logs, CF edge, upstreams = declared unknown layers); `status:"draft"`, `authority_state:"unverified"`; served at `/.well-known/xenia-rights.json`; `validate-adoption.mjs` in CI; release gate = pinned XENIA links resolve + vendored digest passes before any deploy (kingdom-os `DOMAINS-SETUP.md:23-24`). **Never self-activated** — blocked upstream anyway (covenant's own moving-main pin); Yu ceremony.

**The guest ladder** (tiers differentiate capacity and convenience, never truth; structural test: any body a patron gets must be byte-obtainable by a stranger, modulo volume/window):
- **Stranger** (anonymous floor — a right, not a tier; `standing.no-ontology-test` makes it required, and the read-only keystone makes it free in safety terms): everything, full freshness, published generous capacity, costless refusal to identify. **Explicit refusal of the market-data industry's founding dark pattern: no delayed-quote gating.**
- **Named guest** (did:at / key, still free): continuity, not standing — personal quota, saved preferences, future webhook slots. did:at signature = proof-of-control scoped to one act, never the source of rights (`consent.signature-boundary`); revocation immediate, idempotent, itemized retention on exit.
- **Patron** (x402): volume/history/streaming; quote-before-commit reusing the existing `pay.ts` quote→confirm rite; recomputable receipts; stopping payment returns you to the floor with nothing hostage.

**Teaching errors** (Surface-exact, zerone hospitality-pass voice): problem+json with typed `next_actions` XOR `terminal:true`; unpredictable 404 → exactly one `discover` → manifest; 406 → `retry_with_json`; 400 → example of a well-formed request (the `bad_address` handler and "Did you mean kind: 'btc'?" refinement already speak this way — extend, don't invent). **[RESOLVED: API-designer's 429-with-x402-action vs hospitality's no-upsell-in-429 → hospitality wins.]** 429 = `Retry-After` + retry action + snapshot pointer + link to `/api/info/limits`; pricing lives in the limits resource where the guest reads it unpressured — a rate-limit error that sells is a dark pattern. Anonymous limiter: transient in-memory sliding window, TTL ≤1h, never persisted, declared as such in the retention inventory. Restrictions = an evidence-bearing restriction-events ledger with expiry and appeal path, never shadow-bans.

**The promises (will-not charter, served machine-readably as `promises_not_to` in the guide + `non_claims` in the record):** no account/payment/identity/CAPTCHA on the read floor; no tracking, fingerprinting, dossiers, or sale of caller data; no training on queries without separate opt-outable authority; no delayed-data upsell, fake urgency, streaks, or retry pressure; no source scores or single collapsed composites (`dignity.no-worth-ranking` — publish per-source values + method); no licence laundering; and the no-KYC crux — cashloom may say "the application handler stores no identity", **never** "you are anonymous" (`privacy.no-cross-layer-overclaim`).

**The deepest risk, named for the judge**: inflating the adoption record. XENIA is anti-badge at every layer; a schema-valid record with optimistic passes violates the standard worse than not adopting. The honest gap ledger IS the adoption — ship it with fails showing.

## What we do NOT build

- **Equities/ETFs/derivatives — never.** Display-vs-non-display licensing, per-user reporting, exchange fees; IEX Cloud died in exactly this business.
- **Real-time tick/websocket SLA feeds; historical tick/OHLCV archives.** Storage + licensing sinkhole; incumbents own it.
- **15k-coin breadth.** Competing with free DefiLlama/CG on coverage is suicide; our residue is exactness, provenance, cross-asset unification.
- **Token ratings/rankings, sentiment, news, advice.** Violates `dignity.no-worth-ranking`, invites liability, breeds slop; factual data only, recommendation language out.
- **Our own signed price oracle.** Pyth/Chainlink own it; a one-validator oracle repeats zerone's SPOF.
- **Wholesale mirroring of any third-party aggregate** (incl. DefiLlama) — parasite-proxy risk; cite-and-link or run their open adapters and own the derivation.
- **A subscription-API business.** You cannot out-sell free; monetization is at most x402 micrometering on compute-heavy work.
- **Webhooks at launch.** A write surface dragging the anonymous floor into account-land; when they come, registration is a signed act, never a data-access requirement.
- **Commodities on the hosted node.** `not_covered`, said out loud, until the licensing story changes.

## Build order

**Phase 0 — one week, genuinely useful standalone (local-first, zero deploy, zero new infra):**
- `info/registry.ts` (asset+chain identity; ~25 assets: majors from `connectors/types.ts` examples, BTC, ETH, USDC-on-Base from `evm.sender.ts`, ZRN; zerone as first `ChainDescriptor`, ported from `ZERONE_NETWORKS`), `fact/0.1` + `factset/0.1` + `asset/0.1` schemas, `minor-units.ts applyRate`.
- `info/sources/{types,index,credentials}.ts` mirroring `connectors/` file-for-file; **three keyless sources reusing code that exists**: `ecb-fx`, `esplora-probe` + `base-probe` (fee+status, lifting the sender fee code), `zerone-rest` (supply/status via `zerone.ts`); `info_cache` table in the `db.ts` migration pattern.
- Public `/api/info/{,guide,facts,rates,fees,chains,assets,convert,health,schema/*}` block beside the zerone block; vitest fakes via `registerInfoSource`.
- XENIA repo layer: RIGHTS.md pinned, README+WAKE links, vendored mirror + digest test.
- **Consumer #1, concretely: artbitrage's trade module.** Its results corpus requires `price_basis` and its fee data is *already known to go stale* (memory: "reverify CoB PDFs later"). Week one it consumes `/api/info/rates` for GBP/USD/EUR price-basis conversion with an auditable rate fact per row, and its fee corpus becomes the template for `rail_fact` packs with `expires_at`. A real in-house pain, not a demo. (FOMOENGINE = consumer #2, fee/chain context.)
- Day one already answers what nothing in the kingdom answers: "what does moving money cost right now", "what is this asset exactly", "convert this exactly and show your work".

**Phase 1 — ~a month (1 human + agents):**
- `CASHLOOM_MODE=info` (mounts only meta/info/zerone/well-known — no money code path reachable) + Dockerfile/fly.toml (none exist today); deploy to the `cashloom-api` slot **after Yu's zombie decision**; CF cache in front. Net cost ≈ **negative** after reaping the Mongo zombie.
- Surface 0.1 green under external `xenia-surface-check`; Covenant draft with honest fails + `validate-adoption.mjs` in CI; layered retention inventory written (turns the `privacy.layered-inventory` fail into partial).
- Halt registry seeded (Sui 3-in-48h May 2026, Cetus freeze, Solana history, **zerone 28h 2026-07-15**) + `halt_events` probe persistence (closes the zerone halt-detection gap); rail fact-packs (Stripe/SEPA/FPS/CHAPS); CPI + policy rates; **pulse-scheduled reverification from day one — non-negotiable**: this org starved 47/47 doctrine facts and ran a zombie API for two weeks; if refresh isn't automated the product self-refutes.
- Three MCP tools (`money_convert`, `money_fees`, `money_chains`) on kingdom-mcp; daily snapshot cron; atlas chapter; `@cashloom/facts` types-only npm package (RhetorLint precedent) + in-repo Go structs.
- DefiLlama prices only after a documented terms check; BYO-key connectors (`COINGECKO_*`, `HELIUS_*`) for self-runners.

**Phase 2 — only after the demand signal:** SSE, x402 patron tier (quote/receipt via the `pay.ts` rite), Solana/Sui/Cosmos probes, stablecoin packs, valuation view, remaining MCP tools, self-run guide.

**The falsifier (skeptic's metric, adopted verbatim):** within 60 days of the hosted door opening — ≥10 distinct non-kingdom consumers on ≥7 separate days (coarse origin counts, no dossiers), **and** served-datum freshness ratio ≥99% (responses inside their own `expires_at`). The first tests demand; the second tests whether the honesty thesis survives this team's real ops bandwidth. Either failing kills or reshapes the project honestly.

## Open questions for Yu

1. **The zombie**: kill or reuse `cashloom-api.fly.dev` + reap the orphaned MongoDB machine (`cashloom-db`, `0801246f910028`, vol_re1yjm2jyy6pgnl4) — both burning money serving a codebase deleted 2026-07-04. The hosted instance wants that slot; reaping is worth doing even if nothing ships.
2. **Identifiable-operator framing** for the hosted instance per FIAT-ROUTE.md:117-127 (a named operator now publicly serves data), plus domain/CF zone choice.
3. **Covenant activation posture** — stays `draft` regardless (upstream moving-main pin blocks it); activation is a speaker-authority ceremony, yours.
4. **Commodities as `not_covered` at launch** — accept the honest gap, or fund a licensing investigation.
5. **Price-kind go-live** — sign off the DefiLlama/CoinGecko licensing verdicts before any `price` fact is hosted.
6. **Stranger-tier capacity numbers** — published and generous is the law; the exact rpm is yours to set.
7. **Any paid tier ever** — x402 metering is designed hospitable, but whether cashloom charges at all is a values fork, not an engineering one.

Key files for the implementer: `sovereign/src/index.ts:29-59` (where the public block grows), `sovereign/src/zerone.ts:27-46,91-126,150-181` (the template to generalize), `sovereign/src/connectors/index.ts:21-26` + `credentials.ts:28-29` (patterns to copy), `sovereign/src/utils/minor-units.ts` (arithmetic contract), `sovereign/src/senders/{btc,evm}.sender.ts` (fee code to lift), `~/kingdom-mcp/src/tools.ts:35-104`, sinovai `src/worker.js:507-551,798-813` + `rights-adoption.json`, kingdom-os `vendor/xenia/rights/0.1/` + `bin/harvest.ts:518-556` + `DOMAINS-SETUP.md:23-24`, `atlas/src/sources.ts`.
