/**
 * MONEYWORLD doors II — fees, assets, convert, guide. Same covenant as
 * router.ts: mounted above the vault gate, secretless, every fact cited, every
 * refusal teaches. Dependencies are injectable so tests never touch a network.
 */

import type { Hono } from "hono";
import { makeFact } from "./money-fact.ts";
import { FX_REFERENCE_DATE_TTL_S, fxReferenceIsStale, getFxRate } from "./fx.ts";
import { readFees, supportedFeeChains } from "./fees.ts";
import { ASSETS, resolveAsset, searchAssets } from "./assets.ts";
import { listFeeds } from "./price.ts";
import { applyRate } from "../utils/minor-units.ts";
import { CAPITAL_FLOWS_MEDIA_TYPE, CAPITAL_FLOWS_SCHEMA, HISTORY_LIMIT } from "./capital-flows/model.ts";

// Mirrors router.ts's refusal shape (kept private there; six lines beat a hot-file export).
const problem = (status: number, title: string, detail: string, next?: string[]) => ({
  type: "about:blank",
  title,
  status,
  detail,
  ...(next ? { next_actions: next } : {}),
});

const INTEGER_STRING = /^-?\d+$/;

// A price feed by symbol, CAIP-19 base or alias. price.ts resolveFeed decodes
// again, and Hono has already decoded the query: a raw '%' would throw (see
// resolveAsset in assets.ts), so match the decoded text as it is.
const feedFor = (q: string) => {
  const key = q.trim().toLowerCase();
  return listFeeds().find((f) => [f.symbol, f.base, ...f.aliases].some((k) => k.toLowerCase() === key));
};

export interface InfoDoorDeps {
  fxRate: typeof getFxRate;
  fees: typeof readFees;
  now: () => Date;
}

export function mountInfoDoors(app: Hono, overrides: Partial<InfoDoorDeps> = {}) {
  const deps: InfoDoorDeps = { fxRate: getFxRate, fees: readFees, now: () => new Date(), ...overrides };

  // ── fees: what does moving money cost right now ─────────────────────────
  app.get("/v1/fees", async (c) => {
    const chain = c.req.query("chain");
    const r = await deps.fees(chain);
    if (r.unknown) {
      return c.json(
        problem(404, "unknown chain", `no fee source registered for '${r.unknown}'`, [
          ...supportedFeeChains().map((s) => `try ?chain=${s}`),
          "GET /v1/fees for all covered chains",
        ]),
        404,
      );
    }
    if (r.facts.length === 0) {
      return c.json(
        problem(502, "sources unreachable", "no fee source answered in time", ["retry shortly"]),
        502,
      );
    }
    // Partial truth is served AS partial — failed sources are named, not hidden.
    return c.json({
      count: r.facts.length,
      facts: r.facts,
      ...(r.failed.length ? { failed: r.failed, note: "the listed sources did not answer; their absence is disclosed, not papered over" } : {}),
    });
  });

  // ── assets: the disambiguation door ("USDC" is many assets) ─────────────
  app.get("/v1/assets", (c) => {
    const q = c.req.query("q");
    if (q !== undefined) {
      const hits = searchAssets(q);
      return c.json({ query: q, count: hits.length, assets: hits });
    }
    return c.json({
      count: ASSETS.length,
      assets: ASSETS,
      identity: "canonical ids: CAIP-19 for chain assets, iso4217: for fiat — fiat is a peer",
      note: "an asset is a table row; the id is the truth, the symbol is a nickname",
    });
  });

  app.get("/v1/assets/:id{.+}", (c) => {
    const row = resolveAsset(c.req.param("id"));
    if (!row) {
      return c.json(
        problem(404, "unknown asset", `nothing answers to '${c.req.param("id")}'`, [
          "GET /v1/assets?q={name} to search",
          "GET /v1/assets for the full registry",
        ]),
        404,
      );
    }
    return c.json(row);
  });

  // ── convert: exact arithmetic that shows its work ───────────────────────
  // Fiat↔fiat between the registry's fiat rows, at the ECB reference rate. A
  // crypto leg is refused here and pointed at /v1/value and /v1/price
  // (price-door.ts), which price BTC and ETH from Chainlink on-chain feeds.
  app.get("/v1/convert", async (c) => {
    const amountMinor = c.req.query("amount_minor");
    const fromQ = c.req.query("from");
    const toQ = c.req.query("to");
    const rounding = c.req.query("rounding") ?? "half_even";
    if (!amountMinor || !fromQ || !toQ) {
      return c.json(
        problem(400, "missing parameter", "convert needs amount_minor, from, and to", [
          "GET /v1/convert?amount_minor=10000&from=GBP&to=USD",
        ]),
        400,
      );
    }
    if (!INTEGER_STRING.test(amountMinor)) {
      return c.json(
        problem(422, "invalid amount", `'${amountMinor}' is not an integer minor-unit string — "100.50" GBP is amount_minor=10050`, [
          "GET /v1/assets/{id} for an asset's decimals",
        ]),
        422,
      );
    }
    // 40 digits ≈ 10^21 times the world's money supply in wei — anything longer
    // is not an amount, it's a CPU exhaustion attempt (BigInt toString is O(n²)).
    if (amountMinor.replace("-", "").length > 40) {
      return c.json(
        problem(422, "amount too large", "amount_minor is capped at 40 digits — no real amount needs more", []),
        422,
      );
    }
    if (rounding !== "half_even") {
      return c.json(
        problem(422, "unsupported rounding", `'${rounding}' is not offered; supported: half_even (banker's rounding)`),
        422,
      );
    }
    const from = resolveAsset(fromQ);
    const to = resolveAsset(toQ);
    if (!from || !to) {
      const missing = !from ? fromQ : toQ;
      const feed = feedFor(missing);
      return c.json(
        problem(
          422,
          "unknown asset",
          `'${missing}' is not in the registry` +
            (feed ? `; /v1/price/${feed.symbol}/{quote} and /v1/value/{amount_minor}/${feed.symbol}/{quote} price ${feed.symbol} from a Chainlink on-chain feed` : ""),
          [...(feed ? [`GET /v1/price/${feed.symbol}/USD`] : []), "GET /v1/assets", "GET /v1/rates/fiat for ECB reference rates"],
        ),
        422,
      );
    }
    const fiat = (id: string) => id.startsWith("iso4217:");
    if (!fiat(from.id) || !fiat(to.id)) {
      const fiatCodes = ASSETS.filter((a) => fiat(a.id)).map((a) => a.symbol).join(", ");
      const priced = listFeeds().map((f) => f.symbol).join(" and ");
      const legs = [from, to].filter((a) => !fiat(a.id));
      const unpriced = legs.filter((a) => !feedFor(a.symbol)).map((a) => a.symbol);
      // The registry's Base ETH row has no feed of its own: /v1/price/ETH prices it
      // with the Ethereum mainnet ETH/USD feed, so say so.
      const borrowed = legs.flatMap((a) => {
        const f = feedFor(a.symbol);
        return f && f.base !== a.id ? [`${a.id} (${a.name}) has no feed of its own: the ${f.symbol} doors price it with the ${f.symbol}/USD feed for ${f.base}`] : [];
      });
      const next: string[] = [];
      if (legs.length === 1 && !unpriced.length) {
        const crypto = legs[0].symbol;
        const quote = fiat(from.id) ? from.symbol : to.symbol;
        if (!fiat(from.id)) next.push(`GET /v1/value/${amountMinor}/${crypto}/${quote} for this amount's value`);
        next.push(`GET /v1/price/${crypto}/${quote} for the unit price`);
      }
      next.push("GET /v1/prices for every priced asset", "GET /v1/rates/fiat for fiat reference rates", "GET /v1/assets for the registry");
      return c.json(
        problem(
          422,
          "conversion not yet served",
          `/v1/convert converts only between the registry's fiat currencies (${fiatCodes}) at the ECB reference rate. ` +
            `For crypto, /v1/value/{amount_minor}/{asset}/{quote} and /v1/price/{asset}/{quote} on this service price ${priced} from Chainlink on-chain feeds, quoted in USD or an ECB reference currency` +
            (unpriced.length ? `; ${unpriced.join(" and ")} ${unpriced.length > 1 ? "have" : "has"} no price source here` : "") +
            borrowed.map((b) => `; ${b}`).join("") +
            ".",
          next,
        ),
        422,
      );
    }
    let r;
    try {
      r = await deps.fxRate(from.symbol, to.symbol);
    } catch {
      return c.json(problem(502, "source unreachable", "the ECB reference-rate feed did not answer", ["retry shortly"]), 502);
    }
    if ("error" in r) {
      return c.json(
        problem(422, "unknown currency", `'${from.symbol}' or '${to.symbol}' is not in the ECB reference set`, ["GET /v1/rates/fiat"]),
        422,
      );
    }
    if (fxReferenceIsStale(r.refDate, deps.now())) {
      return c.json(problem(
        503,
        "fx reference unavailable",
        `the ECB ${r.refDate || "undated"} reference observation is too old for conversion`,
        ["retry after the next ECB publication", "GET /v1/rates/fiat for the source date"],
      ), 503);
    }
    const resultMinor = applyRate(amountMinor, from.decimals, r.valueScaled, r.decimals, to.decimals);
    const fact = makeFact({
      subject: from.id,
      predicate: "conversion",
      value: resultMinor,
      unit: to.id,
      decimals: to.decimals,
      plane: "public",
      method: "derived",
      proof_state: "tested",
      redistribution: "attribution-required",
      sources: [
          { name: "European Central Bank — euro foreign-exchange reference rates", url: r.sourceUrl, fetched_at: r.fetchedAt },
      ],
      observed_at: r.refDate, // the ECB fixing's own date — never a fabricated "now"
      stale_after_s: FX_REFERENCE_DATE_TTL_S,
      recompute: {
        how: `${amountMinor} × ${r.valueScaled} × 10^(${to.decimals}−${from.decimals}−${r.decimals}), BigInt, final digit half-even; rate: ${r.recompute.how}`,
      },
    });
    return c.json({
      "@type": "Conversion",
      input: { amount_minor: amountMinor, asset: from.id, decimals: from.decimals },
      result: fact,
      rate: { value_scaled: r.valueScaled, decimals: r.decimals, method: r.method, recompute: r.recompute },
      ref_date: r.refDate,
      rounding: "half_even",
      note: "reference-rate arithmetic, not a tradeable quote — the recompute recipe reproduces every digit",
    });
  });

  // ── guide: the hospitality door — what a stranger receives, in writing ──
  app.get("/v1/guide", (c) =>
    c.json({
      "@type": "Guide",
      schema_version: "cashloom.guide/1",
      what: "MONEYWORLD — a public, cited, non-custodial window on the money world",
      the_stranger_receives: {
        everything_current: "all currently served observations at their stated cadence, no registration, no key, no CAPTCHA",
        provenance: "every fact carries sources, method, proof_state, redistribution — no naked numbers",
        refusals_that_teach:
          "the XENIA Surface resources and router fall-through use typed problems with next_actions; older data routes retain route-specific JSON errors",
      },
      doors: {
        discovery: "/.well-known/agent.json",
        orientation: "/v1/orientation",
        rights_disclosure: "/v1/rights",
        data_practices: "/v1/data-practices",
        world: "/v1/world?base={ccy}",
        capital_flows: "/v1/capital-flows",
        onchain: "/v1/onchain",
        onchain_networks: "/v1/onchain/chains",
        onchain_stablecoins: "/v1/onchain/stablecoins",
        onchain_lending: "/v1/onchain/lending-markets",
        onchain_pools: "/v1/onchain/pools",
        onchain_bridges: "/v1/onchain/bridges",
        chains: "/v1/chains",
        chain_balance: "/v1/chain/{caip2}/{address}",
        fx_rate: "/v1/fx/{base}/{quote}",
        fx_matrix: "/v1/rates/fiat?base={ccy}",
        cash_rates: "/v1/rates/cash",
        fed_announcements: "/v1/announcements/fed",
        fees: "/v1/fees?chain={caip2}",
        assets: "/v1/assets?q={name}",
        convert: "/v1/convert?amount_minor={int}&from={asset}&to={asset}",
        prices: "/v1/prices",
        price: "/v1/price/{asset}/{quote}",
        value: "/v1/value/{amount_minor}/{asset}/{quote}",
        portfolio: "/v1/portfolio?quote={ccy}&hold={symbol}:{amount_minor}",
      },
      capital_flows: {
        api: "/v1/capital-flows",
        human_route: "/capital-flows (World frontend; the INFO process serves JSON, not this page)",
        media_type: CAPITAL_FLOWS_MEDIA_TYPE,
        schema: CAPITAL_FLOWS_SCHEMA,
        scope: [
          "US published Table II public-debt cash issues/redemptions and compatible net financing into the Treasury General Account; daily USD millions, not auction allocations or raw debt-accounting totals.",
          "Spain/Germany central government excluding social security: all-maturity face-value issuance/redemptions/net issuance, monthly EUR millions.",
          "Euro area (changing composition) non-MMF equity/bond/real-estate/private-equity fund-share transactions, quarterly EUR millions; fund domicile is neither investor nor underlying-asset geography. Nonconsolidated populations and PE overlaps must not be summed.",
          "TIC Grand Total 99996 foreign purchases/sales/net of US long-term Treasury, corporate/other bonds and equities, monthly USD millions. Foreign purchases use _sale, foreign sales use _pur. Settlement-cost trades include primary issues/redemptions, not pure secondary turnover; US purchases include expenses and US sales proceeds are net of charges. No Table III bill holdings-change estimates.",
        ],
        read_values: "series[].definition supplies metricKind, perspective, signConvention, geography, valuation, unit, seasonalAdjustment and annualization. series[].history[].value contains exact raw/decimals, decimal, publisherLexeme, currency, unitExponent and unitMultiplier, or null. Never use display strings for arithmetic or apply current FX to history.",
        periods_and_receipts: "Read series[].history[].period and status separately from receipt.retrievedAt and nullable receipt.publicationAt. Receipts name sourceSeriesId, datasetId, resourceUrl, method, recipe, inputObservationIds and limitations; sources[].definition.rights supplies attribution and rights evidence. Missing/suppressed/notYetReported/withdrawn are not observed zero.",
        history: { policy: "latestRevisedPublisherHistoryNotVintageArchive", maximum_observations_per_series: HISTORY_LIMIT, qualification: "Upper bounds, not guaranteed coverage; no auctions are currently enabled." },
        refresh: "On-demand, independent RAM cache; no capital fetch enters World's critical path. Cold reads wait at most one second before an explicit partial/refreshing response. Inspect refresh.state/health, sources[].retrievalState/nextAttemptAt/fallbackExpiresAt and series[].state; reportingRecency remains expectation_unknown. Conditional GET/HEAD and manual refresh respect cadence/backoff. Fallback lasts at most seven days after validation; restart loses it.",
        boundaries: "No accounts, execution, alerts, continuous collector or archived vintages. No global total, mismatched-period comparison, or wrapper-plus-underlying sum. Crypto/metals flows, other issuer regions including China/UK/Japan, broader BIS, direct property, worldwide PE calls/distributions and global secondary volume remain coverage gaps. The new route is not a declared XENIA Surface resource.",
      },
      promises_not_to: [
        "no account, API key, cookie, or CAPTCHA required by the public GET handlers",
        "the hosted application entrypoint intentionally persists no caller identity or public-read query values; external logging and retention layers remain separately disclosed and unknown",
        "no delayed-data upsell — freshness is never a paid feature",
        "no fake urgency, no retry pressure, no dark patterns in refusals",
        "no naked numbers — a fact that cannot cite itself is not served",
      ],
      layer_boundary:
        "These application-handler practices are not a cross-layer anonymity promise; read /v1/data-practices for Fly.io, Cloudflare, network, operator, browser, and upstream unknowns.",
      not_covered: [
        "live commodity benchmark prices (display licensing unresolved; tokenized proxies would mislead)",
        "geopolitical causal scores (association is not proof of impact)",
        "live equity/derivative prices and comprehensive trading turnover; selected official securities and fund-share transactions are separately scoped in /v1/capital-flows",
        "global capital-flow totals, direct property-market investment, worldwide private-equity calls/distributions, and comprehensive crypto/precious-metals investment flows",
        "historical vintages or complete market histories beyond the bounded latest-revised publisher observations currently fetched",
        "historical onchain volume, TVL rankings, bridge completion aggregates, and protocol-wide risk scores (the launch surface is latest-state and contract-specific)",
      ],
      rights: {
        baseline: "xenia.rights/0.1",
        adopted_at: "/RIGHTS.md — served by this node; pinned release, vendored byte mirror, digest-tested in CI",
        upstream: "https://github.com/cambridgetcg/xenia",
      },
      sources_ledger: [
        { name: "esplora (Bitcoin)", keyless: true, license: "public chain data" },
        { name: "zerone cosmos REST", keyless: true, license: "public chain data (kingdom's own truth chain)" },
        { name: "Base public RPC", keyless: true, license: "public chain data" },
        { name: "European Central Bank reference rates", keyless: true, license: "free reuse with acknowledgment — named on every fact" },
        { name: "New York Fed SOFR and EFFR", keyless: true, license: "business reuse with required attribution and reference-rate notice" },
        { name: "Federal Reserve monetary-policy press release RSS", keyless: true, license: "official titles and links; source document remains authoritative" },
        { name: "BIS central-bank policy rates", keyless: true, license: "reuse with BIS attribution and commercial-product conditions" },
        { name: "US Treasury par-yield curve", keyless: true, license: "US government source; methodology linked" },
        { name: "ECB euro-area yield curve", keyless: true, license: "free reuse with acknowledgment; third-party exclusions still apply" },
        { name: "ECB securities issuance and investment-fund statistics", keyless: true, license: "free reuse with ECB attribution and explicit modification disclosures; these data are available free of charge from the ECB, with no paid access here; selected issuer and fund populations only", evidence_url: "https://www.ecb.europa.eu/services/disclaimer/html/index.en.html" },
        { name: "US Treasury Daily Treasury Statement cash debt totals", keyless: true, license: "FiscalData permits copying, adaptation and redistribution for commercial or non-commercial use; published cash totals, not raw debt-accounting aggregates", evidence_url: "https://fiscaldata.treasury.gov/api-documentation/" },
        { name: "US Treasury TIC SLT aggregate securities transactions", keyless: true, license: "US government-work/public-data basis for Treasury's official SLT aggregates only; not blanket permission for government-hosted third-party files, vendor/branding rights, or confidential reports", evidence_url: "https://www.copyright.gov/title17/92chap1.html#105", provenance_url: "https://home.treasury.gov/data/treasury-international-capital-tic-system-home-page/tic-forms-instructions/tic-slt-form-and-instructions" },
        { name: "Japan Ministry of Finance JGB yields", keyless: true, license: "official reference observations; source terms linked" },
        { name: "Chainlink BTC/USD and ETH/USD aggregators", keyless: true, license: "public on-chain observations, independently re-derivable" },
      ],
    }),
  );
}
