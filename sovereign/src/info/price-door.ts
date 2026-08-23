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
 * different verb (value, not convert), combined provenance (the strictest
 * source reuse condition wins), and it refuses a stale on-chain price. Derived
 * facts keep the older ECB reference date so consumers can also apply their
 * own date-aware FX freshness policy.
 */

import type { Hono } from "hono";
import { makeFact, type Redistribution } from "./money-fact.ts";
import {
  fxReferenceExpiresAt,
  fxReferenceIsStale,
  getFxRate,
} from "./fx.ts";
import { resolveAsset } from "./assets.ts";
import { applyRate, divHalfEven } from "../utils/minor-units.ts";
import { PRICE_FEEDS, resolveFeed, listFeeds, readPrice, spotPriceLeg, defaultFetchers, type OracleFetchers, type PriceFeed } from "./price.ts";

const problem = (status: number, title: string, detail: string, next?: string[], code?: string) => ({
  type: "about:blank",
  title,
  status,
  ...(code ? { code } : {}),
  detail,
  ...(next ? { next_actions: next } : {}),
});

const FX_FAILURE = Object.freeze({
  upstream: {
    code: "fx_upstream_unavailable",
    message: "The ECB reference-rate source did not answer with a usable observation.",
  },
  pair: {
    code: "fx_pair_unsupported",
    message: "The requested currency pair is not available in the ECB reference set.",
  },
  stale: {
    code: "fx_reference_stale",
    message: "The ECB reference-rate observation is too old for a current derived value.",
  },
  expired: {
    code: "derived_price_expired",
    message: "One of the cited price legs has expired.",
  },
} as const);

const INTEGER_STRING = /^-?\d+$/;
const PRICE_SCALE = 8; // every price value is carried at 10^8, USD-native and cross alike
const TEN8 = 10n ** 8n;

export interface PriceDoorDeps {
  fetchers: OracleFetchers;
  fxRate: typeof getFxRate;
  now: () => Date;
}

function staleAfterFromExpiry(observedAt: string, expiresAtMs: number): number {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return 1;
  return Math.max(1, Math.ceil((expiresAtMs - observedMs) / 1000));
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
      redistribution: Redistribution;
      /** One expiry shared by every input leg, represented relative to observed_at. */
      stale_after_s: number;
      expires_at_ms: number;
    }
  | { ok: false; status: number; title: string; code: string; detail: string; next?: string[] };

async function priceInQuote(feed: PriceFeed, quoteCode: string, deps: PriceDoorDeps): Promise<PriceInQuote> {
  const leg = await spotPriceLeg(feed, deps.fetchers);
  if ("stale" in leg) {
    return { ok: false, status: 503, title: "price unavailable", code: leg.code, detail: leg.detail, next: ["retry shortly", "GET /v1/prices for what is fresh"] };
  }
  if (quoteCode === "USD") {
    const expiresAt = Date.parse(leg.observed_at) + feed.heartbeat_s * 1000;
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
      redistribution: "onchain-rederivable",
      stale_after_s: feed.heartbeat_s,
      expires_at_ms: expiresAt,
    };
  }
  // non-USD: multiply the on-chain USD price by the ECB USD→quote cross.
  let fx;
  try {
    fx = await deps.fxRate("USD", quoteCode);
  } catch {
    return { ok: false, status: 502, title: "fx source unreachable", code: FX_FAILURE.upstream.code, detail: FX_FAILURE.upstream.message, next: ["retry shortly"] };
  }
  if ("error" in fx) {
    return { ok: false, status: 422, title: "unknown currency", code: FX_FAILURE.pair.code, detail: FX_FAILURE.pair.message, next: ["GET /v1/rates/fiat for the supported set"] };
  }
  if (fxReferenceIsStale(fx.refDate, deps.now())) {
    return {
      ok: false,
      status: 503,
      title: "fx reference unavailable",
      code: FX_FAILURE.stale.code,
      detail: FX_FAILURE.stale.message,
      next: ["retry after the next ECB reference-rate publication", "GET /v1/rates/fiat for the source date"],
    };
  }
  // quote per base (scale 8) = USDperBase(8) × quotePerUSD(8) / 10^8, half-even.
  const combined = divHalfEven(BigInt(leg.valueScaled) * BigInt(fx.valueScaled), TEN8);
  const quoteDecimals = resolveAsset(`iso4217:${quoteCode}`)?.decimals ?? 2;
  const observedAt = fx.refDate < leg.observed_at ? fx.refDate : leg.observed_at;
  const oracleExpiresAt = Date.parse(leg.observed_at) + feed.heartbeat_s * 1000;
  const fxExpiresAt = fxReferenceExpiresAt(fx.refDate);
  const expiresAt = Math.min(oracleExpiresAt, fxExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= deps.now().getTime()) {
    return { ok: false, status: 503, title: "derived price stale", code: FX_FAILURE.expired.code, detail: FX_FAILURE.expired.message, next: ["retry shortly"] };
  }
  return {
    ok: true,
    valueScaled: combined.toString(),
    scale: PRICE_SCALE,
    unit: `iso4217:${quoteCode}`,
    quoteDecimals,
    observed_at: observedAt, // stalest leg
    sources: [...leg.sources, { name: "European Central Bank — euro foreign-exchange reference rates", url: fx.sourceUrl, fetched_at: fx.fetchedAt }],
    recompute: `(${leg.recompute.how}) × ECB(USD→${quoteCode})=${fx.valueScaled}×10^-${fx.decimals} [${fx.recompute.how}], product renormalised to ${PRICE_SCALE}dp half-even`,
    method: "derived",
    redistribution: "attribution-required",
    stale_after_s: staleAfterFromExpiry(observedAt, expiresAt),
    expires_at_ms: expiresAt,
  };
}

const quoteDecimalsFor = (quoteCode: string) => resolveAsset(`iso4217:${quoteCode}`)?.decimals ?? 2;

// Value ONE holding in the quote currency's minor units. A priced crypto goes
// through the oracle (× ECB cross if non-USD); a registered fiat goes through
// the ECB rate (or is the identity when it already IS the quote). Anything else,
// or a stale/unreachable leg, comes back {ok:false} with a reason — never a guess.
type LegValue =
  | { ok: true; asset: string; isCrypto: boolean; valueMinor: string; method: "observed" | "derived"; redistribution: Redistribution; sources: { name: string; url: string; fetched_at: string }[]; observed_at: string | null; expires_at_ms: number | null }
  | { ok: false; asset: string; code: string; reason: string };

async function valueHolding(sym: string, amountMinor: string, quoteCode: string, quoteDecimals: number, deps: PriceDoorDeps): Promise<LegValue> {
  const feed = resolveFeed(sym);
  if (feed) {
    const piq = await priceInQuote(feed, quoteCode, deps);
    if (!piq.ok) return { ok: false, asset: feed.base, code: piq.code, reason: piq.detail };
    return {
      ok: true,
      asset: feed.base,
      isCrypto: true,
      valueMinor: applyRate(amountMinor, feed.base_decimals, piq.valueScaled, piq.scale, quoteDecimals),
      method: "derived",
      redistribution: piq.redistribution,
      sources: piq.sources,
      observed_at: piq.observed_at,
      expires_at_ms: piq.expires_at_ms,
    };
  }
  const a = resolveAsset(sym);
  if (a && a.id.startsWith("iso4217:")) {
    if (a.symbol === quoteCode) {
      // identity — the holding already IS the quote currency; no rate, no source.
      return { ok: true, asset: a.id, isCrypto: false, valueMinor: amountMinor, method: "observed", redistribution: "own-data", sources: [], observed_at: null, expires_at_ms: null };
    }
    let fx;
    try {
      fx = await deps.fxRate(a.symbol, quoteCode);
    } catch {
      return { ok: false, asset: a.id, code: FX_FAILURE.upstream.code, reason: FX_FAILURE.upstream.message };
    }
    if ("error" in fx) return { ok: false, asset: a.id, code: FX_FAILURE.pair.code, reason: FX_FAILURE.pair.message };
    if (fxReferenceIsStale(fx.refDate, deps.now())) {
      return { ok: false, asset: a.id, code: FX_FAILURE.stale.code, reason: FX_FAILURE.stale.message };
    }
    const expiresAt = fxReferenceExpiresAt(fx.refDate);
    if (!Number.isFinite(expiresAt) || expiresAt <= deps.now().getTime()) {
      return { ok: false, asset: a.id, code: FX_FAILURE.expired.code, reason: FX_FAILURE.expired.message };
    }
    return {
      ok: true,
      asset: a.id,
      isCrypto: false,
      valueMinor: applyRate(amountMinor, a.decimals, fx.valueScaled, fx.decimals, quoteDecimals),
      method: "derived",
      redistribution: "attribution-required",
      sources: [{ name: "European Central Bank — euro foreign-exchange reference rates", url: fx.sourceUrl, fetched_at: fx.fetchedAt }],
      observed_at: fx.refDate,
      expires_at_ms: expiresAt,
    };
  }
  return { ok: false, asset: sym, code: "asset_unsupported", reason: "unknown asset: no configured crypto price or fiat reference is available." };
}

export function mountPriceDoors(app: Hono, overrides: Partial<PriceDoorDeps> = {}) {
  const deps: PriceDoorDeps = { fetchers: defaultFetchers, fxRate: getFxRate, now: () => new Date(), ...overrides };

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
    if (!piq.ok) return c.json(problem(piq.status, piq.title, piq.detail, piq.next, piq.code), piq.status as any);
    const fact = makeFact({
      subject: feed.base,
      predicate: "spot_price",
      value: piq.valueScaled,
      unit: piq.unit,
      decimals: piq.scale,
      plane: "public",
      method: piq.method,
      proof_state: "tested",
      redistribution: piq.redistribution,
      sources: piq.sources,
      observed_at: piq.observed_at,
      stale_after_s: piq.stale_after_s,
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
      else if (r.kind === "stale") unavailable.push({ pair: r.pair, code: r.code, reason: "The on-chain price observation is older than its configured heartbeat." });
      else if (r.kind === "invalid") unavailable.push({ pair: r.pair, code: r.code, reason: r.reason });
      else unavailable.push({ pair: r.pair, code: r.code, reason: r.detail });
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
    if (!piq.ok) return c.json(problem(piq.status, piq.title, piq.detail, piq.next, piq.code), piq.status as any);

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
      redistribution: piq.redistribution,
      sources: piq.sources,
      observed_at: piq.observed_at,
      stale_after_s: piq.stale_after_s,
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

  // ── portfolio: what a whole basket of holdings is worth, in one quote ────
  // A wallet's real question. Mixed crypto + fiat, each leg valued honestly.
  // If ANY leg is stale/unknown, the total is served AS PARTIAL — the missing
  // legs are named in `withheld` and `complete:false`, never silently dropped
  // into a smaller-looking number. Some truth, labelled, beats a tidy lie.
  //   /v1/portfolio?quote=USD&hold=BTC:50000000,ETH:1000000000000000000,GBP:50000
  app.get("/v1/portfolio", async (c) => {
    const quoteCode = (c.req.query("quote") ?? "USD").toUpperCase();
    const holdRaw = c.req.query("hold");
    if (!holdRaw) {
      return c.json(
        problem(400, "missing holdings", "portfolio needs hold=SYM:amount_minor pairs (comma-separated)", [
          "GET /v1/portfolio?quote=USD&hold=BTC:50000000,ETH:1000000000000000000,GBP:50000",
          "amount_minor is exact integer minor units (0.5 BTC = 50000000 at 8 dp)",
        ]),
        400,
      );
    }
    const tokens = holdRaw.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 50) {
      return c.json(problem(422, "too many holdings", "a portfolio query is capped at 50 legs", []), 422);
    }
    // parse SYM:amount — reject anything malformed rather than coerce it.
    const parsed: { sym: string; amount: string }[] = [];
    for (const t of tokens) {
      const i = t.lastIndexOf(":");
      const sym = i < 0 ? "" : t.slice(0, i);
      const amount = i < 0 ? "" : t.slice(i + 1);
      if (!sym || !INTEGER_STRING.test(amount) || amount.replace("-", "").length > 40) {
        return c.json(
          problem(422, "malformed holding", `'${t}' is not SYM:amount_minor with an integer amount`, [
            "each leg is SYMBOL:INTEGER, e.g. BTC:50000000",
          ]),
          422,
        );
      }
      parsed.push({ sym, amount });
    }

    const quoteDecimals = quoteDecimalsFor(quoteCode);
    const legs = await Promise.all(parsed.map((p) => valueHolding(p.sym, p.amount, quoteCode, quoteDecimals, deps)));

    let sum = 0n;
    const holdings = [];
    const withheld = [];
    const sourceMap = new Map<string, { name: string; url: string; fetched_at: string }>();
    const observedDates: string[] = [];
    const expiryTimes: number[] = [];
    let aggregateRedistribution: Redistribution = "own-data";
    const redistributionRank: Record<Redistribution, number> = {
      "own-data": 0,
      "onchain-rederivable": 1,
      "public-domain": 1,
      "attribution-required": 2,
      "third-party-restricted": 3,
    };
    for (let k = 0; k < legs.length; k++) {
      const leg = legs[k];
      const inp = parsed[k];
      if (!leg.ok) {
        withheld.push({ asset: leg.asset, input: inp.sym, code: leg.code, reason: leg.reason });
        continue;
      }
      sum += BigInt(leg.valueMinor);
      if (redistributionRank[leg.redistribution] > redistributionRank[aggregateRedistribution]) {
        aggregateRedistribution = leg.redistribution;
      }
      if (leg.observed_at) observedDates.push(leg.observed_at);
      if (leg.expires_at_ms !== null) expiryTimes.push(leg.expires_at_ms);
      for (const s of leg.sources) sourceMap.set(s.url, s);
      holdings.push({
        input: { symbol: inp.sym, amount_minor: inp.amount },
        asset: leg.asset,
        value: { value: leg.valueMinor, unit: `iso4217:${quoteCode}`, decimals: quoteDecimals, method: leg.method, redistribution: leg.redistribution, ...(leg.expires_at_ms !== null ? { expires_at: new Date(leg.expires_at_ms).toISOString() } : {}) },
      });
    }

    const complete = withheld.length === 0;
    const stalest = observedDates.sort()[0] ?? deps.now().toISOString();
    const earliestExpiry = expiryTimes.sort((a, b) => a - b)[0];
    const total = makeFact({
      subject: "aggregate:portfolio",
      predicate: complete ? "total_value" : "partial_value",
      value: sum.toString(),
      unit: `iso4217:${quoteCode}`,
      decimals: quoteDecimals,
      plane: "public",
      method: "derived",
      proof_state: "tested",
      redistribution: aggregateRedistribution,
      sources: [...sourceMap.values()],
      observed_at: stalest, // as fresh only as the STALEST leg summed
      stale_after_s: earliestExpiry === undefined ? 3600 : staleAfterFromExpiry(stalest, earliestExpiry),
      recompute: {
        how: `Σ over holdings[] of (amount_minor × its cited rate → ${quoteCode} minor, half-even); ${holdings.length} leg(s) summed${complete ? "" : `, ${withheld.length} withheld (see withheld[]) — this total is PARTIAL`}`,
      },
    });

    return c.json({
      "@type": "Portfolio",
      quote: `iso4217:${quoteCode}`,
      complete,
      total,
      holdings,
      ...(withheld.length ? { withheld, note: "these legs were withheld, not zeroed — the total above is PARTIAL and excludes them; a stale or unknown leg is disclosed, never silently dropped" } : {}),
    });
  });
}
