/**
 * MONEYWORLD doors III — crypto spot PRICE and VALUE. The honest crypto→fiat
 * surface the convert door has been refusing to fake. Same covenant as doors.ts:
 * mounted above the vault gate, secretless, every fact cites its on-chain round,
 * every refusal teaches. A price is read from a Chainlink aggregator (price.ts);
 * a value is amount × price, and — for a non-USD quote — × the ECB USD cross.
 *
 *   /v1/price/:base/:quote          spot price (USD direct, or any ECB fiat via cross)
 *   /v1/prices                      all feeds in USD, best-effort, refusals disclosed
 *   /v1/value/:amount_minor/:asset/:quote   REPORT value of a holding in fiat
 *
 * This composes crypto→fiat WITHOUT touching the parallel-owned /v1/convert:
 * different verb (value, not convert), different provenance (onchain-rederivable),
 * and it refuses the instant EITHER leg is stale — a valuation on a stale price
 * is a lie with a decimal point.
 */

import type { Hono } from "hono";
import { makeFact } from "./money-fact.ts";
import { getFxRate } from "./fx.ts";
import { resolveAsset } from "./assets.ts";
import { applyRate, divHalfEven } from "../utils/minor-units.ts";
import { PRICE_FEEDS, resolveFeed, listFeeds, readPrice, spotPriceLeg, defaultFetchers, type OracleFetchers, type PriceFeed } from "./price.ts";

const problem = (status: number, title: string, detail: string, next?: string[]) => ({
  type: "about:blank",
  title,
  status,
  detail,
  ...(next ? { next_actions: next } : {}),
});

const INTEGER_STRING = /^-?\d+$/;
const PRICE_SCALE = 8; // every price value is carried at 10^8, USD-native and cross alike
const TEN8 = 10n ** 8n;

export interface PriceDoorDeps {
  fetchers: OracleFetchers;
  fxRate: typeof getFxRate;
}

// Price of 1 base asset in `quoteCode` fiat, at PRICE_SCALE. USD is the oracle's
// native quote (direct); any other ECB fiat is the on-chain USD price × the ECB
// USD→quote cross — both legs public and re-derivable, so proof_state stays tested.
type PriceInQuote =
  | {
      ok: true;
      valueScaled: string; // quote per 1 base × 10^PRICE_SCALE
      scale: number;
      unit: string; // iso4217:QUOTE
      quoteDecimals: number; // the fiat's own minor-unit scale (JPY=0, USD=2)
      observed_at: string; // the STALEST leg's own clock (never "now")
      sources: { name: string; url: string; fetched_at: string }[];
      recompute: string;
      method: "observed" | "derived";
    }
  | { ok: false; status: number; title: string; detail: string; next?: string[] };

async function priceInQuote(feed: PriceFeed, quoteCode: string, deps: PriceDoorDeps): Promise<PriceInQuote> {
  const leg = await spotPriceLeg(feed, deps.fetchers);
  if ("stale" in leg) {
    return { ok: false, status: 503, title: "price unavailable", detail: leg.detail, next: ["retry shortly", "GET /v1/prices for what is fresh"] };
  }
  if (quoteCode === "USD") {
    return {
      ok: true,
      valueScaled: leg.valueScaled,
      scale: leg.scale,
      unit: "iso4217:USD",
      quoteDecimals: 2,
      observed_at: leg.observed_at,
      sources: leg.sources,
      recompute: leg.recompute.how,
      method: "observed",
    };
  }
  // non-USD: multiply the on-chain USD price by the ECB USD→quote cross.
  let fx;
  try {
    fx = await deps.fxRate("USD", quoteCode);
  } catch {
    return { ok: false, status: 502, title: "fx source unreachable", detail: "the ECB reference-rate feed did not answer", next: ["retry shortly"] };
  }
  if ("error" in fx) {
    return { ok: false, status: 422, title: "unknown currency", detail: `'${quoteCode}' is not in the ECB reference set`, next: ["GET /v1/rates/fiat for the supported set"] };
  }
  // quote per base (scale 8) = USDperBase(8) × quotePerUSD(8) / 10^8, half-even.
  const combined = divHalfEven(BigInt(leg.valueScaled) * BigInt(fx.valueScaled), TEN8);
  const quoteDecimals = resolveAsset(`iso4217:${quoteCode}`)?.decimals ?? 2;
  return {
    ok: true,
    valueScaled: combined.toString(),
    scale: PRICE_SCALE,
    unit: `iso4217:${quoteCode}`,
    quoteDecimals,
    observed_at: fx.refDate < leg.observed_at ? fx.refDate : leg.observed_at, // stalest leg
    sources: [...leg.sources, { name: "European Central Bank — euro foreign-exchange reference rates", url: fx.sourceUrl, fetched_at: new Date().toISOString() }],
    recompute: `(${leg.recompute.how}) × ECB(USD→${quoteCode})=${fx.valueScaled}×10^-${fx.decimals} [${fx.recompute.how}], product renormalised to ${PRICE_SCALE}dp half-even`,
    method: "derived",
  };
}

export function mountPriceDoors(app: Hono, overrides: Partial<PriceDoorDeps> = {}) {
  const deps: PriceDoorDeps = { fetchers: defaultFetchers, fxRate: getFxRate, ...overrides };

  // ── price: what is 1 unit of a crypto asset worth right now ─────────────
  app.get("/v1/price/:base/:quote", async (c) => {
    const baseParam = c.req.param("base");
    const quoteCode = c.req.param("quote").toUpperCase();
    const feed = resolveFeed(baseParam);
    if (!feed) {
      return c.json(
        problem(404, "no price feed", `no on-chain price source for '${baseParam}'`, [
          ...listFeeds().map((f) => `try ${f.symbol}`),
          "GET /v1/prices for the full set",
        ]),
        404,
      );
    }
    const piq = await priceInQuote(feed, quoteCode, deps);
    if (!piq.ok) return c.json(problem(piq.status, piq.title, piq.detail, piq.next), piq.status as any);
    const fact = makeFact({
      subject: feed.base,
      predicate: "spot_price",
      value: piq.valueScaled,
      unit: piq.unit,
      decimals: piq.scale,
      plane: "public",
      method: piq.method,
      proof_state: "tested",
      redistribution: "onchain-rederivable",
      sources: piq.sources,
      observed_at: piq.observed_at,
      stale_after_s: feed.heartbeat_s,
      recompute: { how: piq.recompute },
    });
    return c.json(fact);
  });

  // ── prices: the whole board in USD, best-effort ─────────────────────────
  app.get("/v1/prices", async (c) => {
    const results = await Promise.all(PRICE_FEEDS.map((f) => readPrice(f, deps.fetchers)));
    const prices = [];
    const unavailable = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.kind === "price") prices.push(r.fact);
      else if (r.kind === "stale") unavailable.push({ pair: r.pair, reason: `stale (${r.age_s}s > ${r.heartbeat_s}s heartbeat)` });
      else if (r.kind === "invalid") unavailable.push({ pair: r.pair, reason: r.reason });
      else unavailable.push({ pair: r.pair, reason: `source unreachable: ${r.detail}` });
    }
    return c.json({
      count: prices.length,
      facts: prices,
      ...(unavailable.length ? { unavailable, note: "the listed pairs are withheld, not guessed — an absent price is disclosed" } : {}),
    });
  });

  // ── value: amount × price, the honest crypto→fiat report ────────────────
  app.get("/v1/value/:amount_minor/:asset/:quote", async (c) => {
    const amountMinor = c.req.param("amount_minor");
    const assetParam = c.req.param("asset");
    const quoteCode = c.req.param("quote").toUpperCase();

    if (!INTEGER_STRING.test(amountMinor)) {
      return c.json(
        problem(422, "invalid amount", `'${amountMinor}' is not an integer minor-unit string — 0.5 BTC is amount_minor=50000000 (8 dp)`, [
          "GET /v1/prices to see each asset's minor-unit scale via its recompute recipe",
        ]),
        422,
      );
    }
    if (amountMinor.replace("-", "").length > 40) {
      return c.json(problem(422, "amount too large", "amount_minor is capped at 40 digits", []), 422);
    }
    const feed = resolveFeed(assetParam);
    if (!feed) {
      return c.json(
        problem(404, "no price feed", `no on-chain price source for '${assetParam}'`, [
          ...listFeeds().map((f) => `try ${f.symbol}`),
          "GET /v1/prices for the full set",
        ]),
        404,
      );
    }
    const piq = await priceInQuote(feed, quoteCode, deps);
    if (!piq.ok) return c.json(problem(piq.status, piq.title, piq.detail, piq.next), piq.status as any);

    // single final rounding: base minor × (quote per base, scale 8) → quote minor.
    const resultMinor = applyRate(amountMinor, feed.base_decimals, piq.valueScaled, piq.scale, piq.quoteDecimals);
    const fact = makeFact({
      subject: feed.base,
      predicate: "value",
      value: resultMinor,
      unit: piq.unit,
      decimals: piq.quoteDecimals,
      plane: "public",
      method: "derived",
      proof_state: "tested",
      redistribution: "onchain-rederivable",
      sources: piq.sources,
      observed_at: piq.observed_at,
      stale_after_s: feed.heartbeat_s,
      recompute: {
        how: `${amountMinor} (${feed.symbol} minor, ${feed.base_decimals}dp) × [${piq.recompute}] → ${quoteCode} minor at ${piq.quoteDecimals}dp, BigInt half-even at the final digit`,
      },
    });
    return c.json({
      "@type": "Valuation",
      input: { amount_minor: amountMinor, asset: feed.base, symbol: feed.symbol, decimals: feed.base_decimals },
      result: fact,
      price: { value_scaled: piq.valueScaled, decimals: piq.scale, unit: piq.unit, method: piq.method, proof_state: "tested" },
      note: "amount × on-chain oracle price (× ECB cross if non-USD) — a REPORT value, not a tradeable quote; the recompute recipe reproduces every digit, and a stale leg refuses rather than lies",
    });
  });
}
