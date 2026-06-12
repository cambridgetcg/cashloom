import axios from "axios";
import { InternalServerException } from "../utils/app-error";
import { RATE_SCALE, scaleRateToBigInt } from "../utils/rate-math";

// FX/crypto rate quotes for the valuation layer (display-only, never ledger
// math). Two KEYLESS public sources — frankfurter (daily ECB fiat fixes) and
// the CoinGecko free tier (crypto spot) — so there is no credentialRef, no
// CREDENTIAL_REF_PATTERN entry, and no secret anywhere in this module.
//
// PRECISION BOUNDARY (the rule every reader needs): both APIs return rates as
// JSON doubles. A double's toString() is its exact shortest decimal form, so
// the ONLY legal move at the boundary is String(rate) →
// scaleRateToBigInt(rate, RATE_SCALE) — an exact re-encoding of whatever the
// source published — after which every amount conversion stays in BigInt
// (utils/rate-math convertMinor). Floats are never multiplied, divided, or
// inverted here: frankfurter is asked for each base currency DIRECTLY
// (?from=CUR&to=HOME) precisely so no float inversion/division ever happens.
// Amount math is therefore exact; quote fidelity equals source fidelity.
// These quotes are display-layer only and must never feed back into
// Account.balanceMinor — a settable balance is a forgeable balance.

/* --------------------------------- types --------------------------------- */

export type RateSource = "frankfurter" | "coingecko" | "identity";

// PINNED CONTRACT — P2-5 (valuation service) builds against this verbatim.
export type RateQuote = {
  rateScaled: bigint; // rate re-encoded at `scale` fraction digits
  scale: number; // always RATE_SCALE
  asOf: Date; // when the SOURCE says the quote is from (not when we fetched)
  source: RateSource;
  stale: boolean; // true when served from cache past its TTL after an upstream failure
};

/* ------------------------------- constants ------------------------------- */

const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";
const FRANKFURTER_LATEST_PATH = "/latest";

const COINGECKO_BASE_URL = "https://api.coingecko.com";
const COINGECKO_PRICE_PATH = "/api/v3/simple/price";

// Crypto symbols priced via CoinGecko; everything else is treated as fiat and
// sent to frankfurter (an unknown symbol simply 404s there → null quote).
const SYMBOL_TO_COINGECKO_ID = new Map<string, string>([
  ["BTC", "bitcoin"],
  ["ETH", "ethereum"],
]);

// frankfurter publishes one ECB fix per business day, so an hour of cache
// loses nothing; crypto moves continuously, so its TTL is tight. Both are
// deliberately generous versus the CoinGecko free tier (~10-30 req/min).
const FIAT_TTL_MS = 60 * 60 * 1000;
const CRYPTO_TTL_MS = 5 * 60 * 1000;

// Serve-stale window: after an upstream failure a cached quote up to this old
// is still served (flagged stale:true) rather than degrading to unpriced.
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 8_000;

// Normalized currency-code shape ("GBP", "BTC", "USDC"...). Anything else is
// reported unpriced, never sent upstream.
const CURRENCY_SYMBOL_PATTERN = /^[A-Z0-9]{2,10}$/;

/* ------------------------------ wire shapes ------------------------------ */

interface FrankfurterLatestResponse {
  base?: string;
  date?: string; // YYYY-MM-DD — the ECB fix date this quote is from
  rates?: Record<string, number>;
}

// { bitcoin: { gbp: 79123.45, last_updated_at: 1749600000 }, ... }
type CoinGeckoSimplePriceResponse = Record<
  string,
  Record<string, number> | undefined
>;

/* --------------------------------- cache --------------------------------- */

interface CachedRate {
  quote: RateQuote; // always stored with stale:false; stale is set on the copy served
  fetchedAt: number; // epoch ms of the successful fetch — the TTL/stale anchor
}

// Module-scoped cache keyed `${home}|${currency}` (GoCardless token-cache
// precedent for module state + reset seam).
const ratesCache = new Map<string, CachedRate>();

// SINGLE-FLIGHT: one in-flight fetch round per (source, home), shared by every
// concurrent caller, so simultaneous /net-worth requests cause at most one
// upstream call per provider.
const inFlightRounds = new Map<string, Promise<FetchOutcome>>();

const cacheKey = (home: string, currency: string): string =>
  `${home}|${currency}`;

// Test/ops seam: clears the quote cache and any in-flight bookkeeping so each
// test (or an operator poke) starts cold.
export const resetRatesCache = (): void => {
  ratesCache.clear();
  inFlightRounds.clear();
};

/* ----------------------------- error handling ---------------------------- */

// Per-currency fetch outcome: null = success (cache updated), string = a
// REDACTED failure reason (host path + status / transport code only — the
// errorHandler middleware console.logs raw objects, so nothing from an axios
// config or response body may ever ride along; reasons end up in errors[]).
type FetchOutcome = Map<string, string | null>;

type HttpResult =
  | { kind: "http"; status: number; data: unknown }
  | { kind: "transport"; code: string | null };

// One GET with validateStatus passing everything through, so every HTTP
// status lands in the "http" branch and the catch is transport-only
// (DNS/TLS/reset/timeout). The raw axios error carries the full request
// config and must never escape — only error.code survives.
const ratesGet = async (
  url: string,
  params: Record<string, string>
): Promise<HttpResult> => {
  try {
    const response = await axios.get(url, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return { kind: "http", status: response.status, data: response.data };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return {
      kind: "transport",
      code: typeof code === "string" && code !== "" ? code : null,
    };
  }
};

// Redacted failure prose: source + optional currency pair + status/code +
// path TEMPLATE. A 429 is called out explicitly and is NEVER retried —
// retrying a throttled free API makes it worse; serve-stale-or-null instead.
const failureReason = (
  source: "frankfurter" | "coingecko",
  pair: string | null,
  result: HttpResult,
  path: string
): string => {
  const target = pair === null ? "" : ` for ${pair}`;
  if (result.kind === "transport") {
    return `${source} request${target} failed before any HTTP response${
      result.code === null ? "" : ` (${result.code})`
    } (GET ${path})`;
  }
  if (result.status === 429) {
    return `${source} rate limited (HTTP 429)${target} on GET ${path} — deliberately not retried`;
  }
  return `${source} request${target} failed with HTTP ${result.status} (GET ${path})`;
};

/* ------------------------------ fetch rounds ------------------------------ */

const storeQuote = (
  home: string,
  currency: string,
  rateDecimal: string,
  source: "frankfurter" | "coingecko",
  asOf: Date
): void => {
  ratesCache.set(cacheKey(home, currency), {
    quote: {
      // The precision boundary: exact re-encoding of the source's double via
      // its shortest decimal string — never float arithmetic.
      rateScaled: scaleRateToBigInt(rateDecimal, RATE_SCALE),
      scale: RATE_SCALE,
      asOf,
      source,
      stale: false,
    },
    fetchedAt: Date.now(),
  });
};

// ONE batched CoinGecko call for every requested crypto symbol — the free
// tier allows ~10-30 req/min, so per-symbol calls are never made.
const coingeckoRound = async (
  home: string,
  symbols: string[]
): Promise<FetchOutcome> => {
  const outcomes: FetchOutcome = new Map();
  const ids = symbols
    .map((symbol) => SYMBOL_TO_COINGECKO_ID.get(symbol))
    .filter((id): id is string => id !== undefined)
    .sort()
    .join(",");
  const vs = home.toLowerCase();
  const result = await ratesGet(`${COINGECKO_BASE_URL}${COINGECKO_PRICE_PATH}`, {
    ids,
    vs_currencies: vs,
    include_last_updated_at: "true",
  });

  if (result.kind === "transport" || result.status < 200 || result.status >= 300) {
    const reason = failureReason("coingecko", null, result, COINGECKO_PRICE_PATH);
    for (const symbol of symbols) outcomes.set(symbol, reason);
    return outcomes;
  }

  const body = (
    typeof result.data === "object" && result.data !== null ? result.data : {}
  ) as CoinGeckoSimplePriceResponse;
  for (const symbol of symbols) {
    const id = SYMBOL_TO_COINGECKO_ID.get(symbol);
    const entry = id === undefined ? undefined : body[id];
    const price = entry?.[vs];
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      outcomes.set(symbol, `coingecko returned no ${symbol}→${home} rate`);
      continue;
    }
    const lastUpdatedAt = entry?.["last_updated_at"];
    const asOf =
      typeof lastUpdatedAt === "number" && Number.isFinite(lastUpdatedAt)
        ? new Date(lastUpdatedAt * 1000)
        : new Date();
    storeQuote(home, symbol, String(price), "coingecko", asOf);
    outcomes.set(symbol, null);
  }
  return outcomes;
};

// One frankfurter call PER base currency (?from=CUR&to=HOME) so the published
// fix is used directly — no float inversion. The 60-minute cache makes the
// per-currency calls cheap; an unknown symbol simply 404s into a null quote.
const frankfurterRound = async (
  home: string,
  symbols: string[]
): Promise<FetchOutcome> => {
  const outcomes: FetchOutcome = new Map();
  await Promise.all(
    symbols.map(async (symbol) => {
      const pair = `${symbol}→${home}`;
      const result = await ratesGet(
        `${FRANKFURTER_BASE_URL}${FRANKFURTER_LATEST_PATH}`,
        { from: symbol, to: home }
      );
      if (
        result.kind === "transport" ||
        result.status < 200 ||
        result.status >= 300
      ) {
        outcomes.set(
          symbol,
          failureReason("frankfurter", pair, result, FRANKFURTER_LATEST_PATH)
        );
        return;
      }
      const body = (
        typeof result.data === "object" && result.data !== null
          ? result.data
          : {}
      ) as FrankfurterLatestResponse;
      const rate = body.rates?.[home];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        outcomes.set(symbol, `frankfurter returned no ${pair} rate`);
        return;
      }
      const fixDate =
        typeof body.date === "string" ? new Date(body.date) : new Date();
      const asOf = Number.isNaN(fixDate.getTime()) ? new Date() : fixDate;
      storeQuote(home, symbol, String(rate), "frankfurter", asOf);
      outcomes.set(symbol, null);
    })
  );
  return outcomes;
};

const runRound = (
  source: "coingecko" | "frankfurter",
  home: string,
  symbols: string[]
): Promise<FetchOutcome> =>
  source === "coingecko"
    ? coingeckoRound(home, symbols)
    : frankfurterRound(home, symbols);

/* ------------------------------- resolution ------------------------------- */

// The home currency prices itself: exact 1.0 at RATE_SCALE, no network, no
// rounding event.
const identityQuote = (): RateQuote => ({
  rateScaled: 10n ** BigInt(RATE_SCALE),
  scale: RATE_SCALE,
  asOf: new Date(),
  source: "identity",
  stale: false,
});

// Resolve one provider group: serve fresh cache hits, share a single in-flight
// fetch round per (source, home) for the misses, then fall back to
// serve-stale-or-null per currency. NEVER throws for a bad currency — every
// failure becomes a null/stale quote plus a redacted reason in errors[].
const resolveGroup = async (
  source: "coingecko" | "frankfurter",
  home: string,
  symbols: string[],
  rates: Map<string, RateQuote | null>,
  errors: string[]
): Promise<void> => {
  if (symbols.length === 0) return;
  const ttlMs = source === "coingecko" ? CRYPTO_TTL_MS : FIAT_TTL_MS;

  const misses: string[] = [];
  for (const currency of symbols) {
    const entry = ratesCache.get(cacheKey(home, currency));
    if (entry && Date.now() - entry.fetchedAt < ttlMs) {
      rates.set(currency, { ...entry.quote });
    } else {
      misses.push(currency);
    }
  }
  if (misses.length === 0) return;

  const flightKey = `${source}|${home}`;
  const existing = inFlightRounds.get(flightKey);
  let outcomes: FetchOutcome;
  if (existing) {
    // Copy before any local additions — the shared map belongs to every
    // awaiter of this flight.
    outcomes = new Map(await existing);
    // A concurrent caller with a DIFFERENT currency set may find some of its
    // misses uncovered by the shared round; fetch just those directly.
    const uncovered = misses.filter((currency) => !outcomes.has(currency));
    if (uncovered.length > 0) {
      const extra = await runRound(source, home, uncovered);
      for (const [currency, outcome] of extra) outcomes.set(currency, outcome);
    }
  } else {
    const flight = runRound(source, home, misses).finally(() => {
      inFlightRounds.delete(flightKey);
    });
    inFlightRounds.set(flightKey, flight);
    outcomes = new Map(await flight);
  }

  for (const currency of misses) {
    const outcome: string | null = outcomes.has(currency)
      ? (outcomes.get(currency) as string | null)
      : `${source} returned no outcome for ${currency}→${home}`;
    const entry = ratesCache.get(cacheKey(home, currency));

    if (outcome === null) {
      // Fetched and cached just now.
      if (entry) {
        rates.set(currency, { ...entry.quote });
      } else {
        rates.set(currency, null);
        errors.push(`${source} produced no cached quote for ${currency}→${home}`);
      }
      continue;
    }

    // SERVE-STALE: an upstream failure with a usable (<24h) cached quote
    // serves that quote flagged stale:true with its ORIGINAL asOf, and the
    // redacted reason still lands in errors[] so nothing degrades silently.
    if (entry && Date.now() - entry.fetchedAt < STALE_MAX_MS) {
      rates.set(currency, { ...entry.quote, stale: true });
      errors.push(
        `${outcome} — serving rates from ${entry.quote.asOf.toISOString()}`
      );
    } else {
      rates.set(currency, null);
      errors.push(outcome);
    }
  }
};

/* ------------------------------- public API ------------------------------- */

// PINNED CONTRACT — P2-5 (valuation service) builds against this. Returns one
// RateQuote (or null = unpriced, with a redacted reason in errors[]) per
// distinct requested currency, keyed by the NORMALIZED (trimmed, uppercased)
// code. Routing: home prices itself (identity, zero network); BTC/ETH ride
// ONE batched CoinGecko call; everything else is fiat via frankfurter, one
// direct ?from=CUR call each. A bad currency NEVER throws — only a malformed
// home (a programming error upstream of the validator) does.
export const getRatesToHome = async (
  home: string,
  currencies: string[]
): Promise<{ rates: Map<string, RateQuote | null>; errors: string[] }> => {
  const homeUpper = (home ?? "").trim().toUpperCase();
  if (!CURRENCY_SYMBOL_PATTERN.test(homeUpper)) {
    throw new InternalServerException(
      `Invalid home currency "${home}": expected a currency code like "GBP"`
    );
  }

  const rates = new Map<string, RateQuote | null>();
  const errors: string[] = [];
  const crypto: string[] = [];
  const fiat: string[] = [];
  const seen = new Set<string>();

  for (const raw of currencies) {
    const currency = (raw ?? "").trim().toUpperCase();
    if (seen.has(currency)) continue;
    seen.add(currency);
    if (!CURRENCY_SYMBOL_PATTERN.test(currency)) {
      rates.set(currency, null);
      errors.push(`unrecognized currency symbol "${currency}" — left unpriced`);
      continue;
    }
    if (currency === homeUpper) {
      rates.set(currency, identityQuote());
      continue;
    }
    if (SYMBOL_TO_COINGECKO_ID.has(currency)) {
      crypto.push(currency);
    } else {
      fiat.push(currency);
    }
  }

  await Promise.all([
    resolveGroup("coingecko", homeUpper, crypto, rates, errors),
    resolveGroup("frankfurter", homeUpper, fiat, rates, errors),
  ]);

  // Batched failures can produce identical reasons for several currencies;
  // collapse exact duplicates so the caller's warnings stay readable.
  return { rates, errors: [...new Set(errors)] };
};
