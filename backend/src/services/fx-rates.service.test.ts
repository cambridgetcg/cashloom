import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import axios, { AxiosResponse } from "axios";
import {
  getRatesToHome,
  resetRatesCache,
  RateQuote,
} from "./fx-rates.service";
import { RATE_SCALE } from "../utils/rate-math";

// All HTTP is mocked at the axios boundary — these tests never touch the
// network (house template: stripe.connector.test.ts). Both rate APIs are
// keyless, so the hygiene assertions guard against axios-config/payload echo
// rather than key leakage.
vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);

const FRANKFURTER_URL = "https://api.frankfurter.app/latest";
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

// Minimal-but-valid AxiosResponse so the mock satisfies the real signature.
const ratesResponse = (status: number, data: unknown): AxiosResponse =>
  ({
    status,
    statusText: status === 200 ? "OK" : "",
    data,
    headers: {},
    config: {},
  } as AxiosResponse);

// --- Fixtures ----------------------------------------------------------------

// GET https://api.frankfurter.app/latest?from=USD&to=GBP
const frankfurterUsdGbp = {
  amount: 1,
  base: "USD",
  date: "2026-06-11", // the ECB fix date — becomes the quote's asOf
  rates: { GBP: 0.79 },
};

// GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&...
const coingeckoBtcEthGbp = {
  bitcoin: { gbp: 79123.45, last_updated_at: 1749600000 },
  ethereum: { gbp: 1987.6543210123, last_updated_at: 1749600300 },
};

// Answer GETs by host so provider ordering never matters in a test.
const mockByHost = () => {
  mockedGet.mockImplementation(async (url) =>
    String(url).includes("coingecko")
      ? ratesResponse(200, coingeckoBtcEthGbp)
      : ratesResponse(200, frankfurterUsdGbp)
  );
};

// ------------------------------------------------------------------------------

beforeEach(() => {
  resetRatesCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("getRatesToHome — routing and exact scaling", () => {
  it("prices fiat via frankfurter and crypto via coingecko as exact scale-12 BigInts", async () => {
    mockByHost();

    const { rates, errors } = await getRatesToHome("GBP", [
      "GBP",
      "USD",
      "BTC",
      "ETH",
    ]);

    expect(errors).toEqual([]);
    // One frankfurter call (USD) + ONE batched coingecko call (BTC+ETH).
    expect(mockedGet).toHaveBeenCalledTimes(2);

    const gbp = rates.get("GBP") as RateQuote;
    expect(gbp.source).toBe("identity");
    expect(gbp.rateScaled).toBe(1000000000000n); // exact 1.0 at scale 12
    expect(gbp.scale).toBe(RATE_SCALE);
    expect(gbp.stale).toBe(false);

    // "0.79" — the double's exact shortest decimal form, re-encoded exactly.
    const usd = rates.get("USD") as RateQuote;
    expect(usd.rateScaled).toBe(790000000000n);
    expect(usd.scale).toBe(RATE_SCALE);
    expect(usd.source).toBe("frankfurter");
    expect(usd.stale).toBe(false);
    expect(usd.asOf).toEqual(new Date("2026-06-11")); // the ECB fix date

    const btc = rates.get("BTC") as RateQuote;
    expect(btc.rateScaled).toBe(79123450000000000n); // 79123.45 * 10^12
    expect(btc.source).toBe("coingecko");
    expect(btc.asOf).toEqual(new Date(1749600000 * 1000)); // last_updated_at

    const eth = rates.get("ETH") as RateQuote;
    expect(eth.rateScaled).toBe(1987654321012300n); // 1987.6543210123 * 10^12
    expect(eth.source).toBe("coingecko");
  });

  it("identity short-circuit: the home currency makes ZERO HTTP calls", async () => {
    const { rates, errors } = await getRatesToHome("gbp", ["gbp"]);

    expect(mockedGet).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    const quote = rates.get("GBP") as RateQuote; // keys are normalized
    expect(quote.source).toBe("identity");
    expect(quote.rateScaled).toBe(10n ** 12n);
    expect(quote.stale).toBe(false);
    expect(quote.asOf).toBeInstanceOf(Date);
  });

  it("batches every crypto symbol into ONE coingecko call with exact params and the 8s timeout", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(200, coingeckoBtcEthGbp));

    await getRatesToHome("GBP", ["BTC", "ETH"]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockedGet.mock.calls[0];
    expect(url).toBe(COINGECKO_URL);
    expect(config?.params).toEqual({
      ids: "bitcoin,ethereum",
      vs_currencies: "gbp",
      include_last_updated_at: "true",
    });
    expect(config?.timeout).toBe(8000);
  });

  it("asks frankfurter for each base DIRECTLY (?from=CUR&to=HOME — no float inversion)", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));

    await getRatesToHome("GBP", ["USD"]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockedGet.mock.calls[0];
    expect(url).toBe(FRANKFURTER_URL);
    expect(config?.params).toEqual({ from: "USD", to: "GBP" });
    expect(config?.timeout).toBe(8000);
  });

  it("dedupes duplicate currency spellings into one quote and one upstream call", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));

    const { rates } = await getRatesToHome("GBP", ["USD", "usd", " USD "]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect([...rates.keys()]).toEqual(["USD"]);
  });
});

describe("getRatesToHome — TTL cache", () => {
  it("serves a second request within the TTL from cache — no second HTTP call", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));

    const first = await getRatesToHome("GBP", ["USD"]);
    const second = await getRatesToHome("GBP", ["USD"]);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(second.rates.get("USD")).toEqual(first.rates.get("USD"));
    expect(second.errors).toEqual([]);
  });

  it("re-fetches after TTL expiry — 5min for crypto, 60min for fiat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    mockByHost();

    await getRatesToHome("GBP", ["USD", "BTC"]);
    expect(mockedGet).toHaveBeenCalledTimes(2);

    // +6min: BTC (5min TTL) expired, USD (60min TTL) still fresh.
    vi.setSystemTime(new Date("2026-06-12T00:06:00Z"));
    await getRatesToHome("GBP", ["USD", "BTC"]);
    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(String(mockedGet.mock.calls[2][0])).toContain("coingecko");

    // +61min: USD expired too (BTC refreshed at +6min is now 55min old > 5min).
    vi.setSystemTime(new Date("2026-06-12T01:01:00Z"));
    await getRatesToHome("GBP", ["USD", "BTC"]);
    expect(mockedGet).toHaveBeenCalledTimes(5);
  });
});

describe("getRatesToHome — serve-stale on upstream failure", () => {
  it("serves a <24h cached quote with stale:true and the ORIGINAL asOf when the upstream 500s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));
    await getRatesToHome("GBP", ["USD"]);

    // Past the 60min fiat TTL, well inside the 24h stale window.
    vi.setSystemTime(new Date("2026-06-12T02:00:00Z"));
    mockedGet.mockResolvedValueOnce(ratesResponse(500, { message: "boom" }));
    const { rates, errors } = await getRatesToHome("GBP", ["USD"]);

    const usd = rates.get("USD") as RateQuote;
    expect(usd.stale).toBe(true);
    expect(usd.rateScaled).toBe(790000000000n);
    expect(usd.source).toBe("frankfurter");
    expect(usd.asOf).toEqual(new Date("2026-06-11")); // original quote time
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 500");
    expect(errors[0]).toContain("serving rates from 2026-06-11T00:00:00.000Z");
  });

  it("serves stale on a 429 WITHOUT retrying (retrying a throttled free API makes it worse)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    mockedGet.mockResolvedValueOnce(ratesResponse(200, coingeckoBtcEthGbp));
    await getRatesToHome("GBP", ["BTC"]);

    vi.setSystemTime(new Date("2026-06-12T00:06:00Z")); // past the 5min crypto TTL
    mockedGet.mockResolvedValueOnce(ratesResponse(429, {}));
    const { rates, errors } = await getRatesToHome("GBP", ["BTC"]);

    expect(mockedGet).toHaveBeenCalledTimes(2); // seed + ONE failed call, NO retry
    const btc = rates.get("BTC") as RateQuote;
    expect(btc.stale).toBe(true);
    expect(btc.rateScaled).toBe(79123450000000000n);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("429");
  });

  it("serves stale on a transport failure, keeping only the error code", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));
    await getRatesToHome("GBP", ["USD"]);

    vi.setSystemTime(new Date("2026-06-12T02:00:00Z"));
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("read ETIMEDOUT"), {
        isAxiosError: true,
        code: "ETIMEDOUT",
        config: { url: FRANKFURTER_URL },
      })
    );
    const { rates, errors } = await getRatesToHome("GBP", ["USD"]);

    const usd = rates.get("USD") as RateQuote;
    expect(usd.stale).toBe(true);
    expect(errors[0]).toContain("ETIMEDOUT");
  });

  it("returns null once the cached quote is older than 24h", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    mockedGet.mockResolvedValueOnce(ratesResponse(200, frankfurterUsdGbp));
    await getRatesToHome("GBP", ["USD"]);

    vi.setSystemTime(new Date("2026-06-13T01:00:00Z")); // 25h later
    mockedGet.mockResolvedValueOnce(ratesResponse(500, {}));
    const { rates, errors } = await getRatesToHome("GBP", ["USD"]);

    expect(rates.get("USD")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 500");
    expect(errors[0]).not.toContain("serving rates from");
  });

  it("returns null + a redacted reason when the upstream fails and nothing was ever cached", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(500, {}));

    const { rates, errors } = await getRatesToHome("GBP", ["USD"]);

    expect(rates.get("USD")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 500");
  });
});

describe("getRatesToHome — single-flight", () => {
  it("two concurrent requests cause at most ONE upstream call per provider", async () => {
    mockByHost();

    const [first, second] = await Promise.all([
      getRatesToHome("GBP", ["USD", "BTC"]),
      getRatesToHome("GBP", ["USD", "BTC"]),
    ]);

    // One frankfurter + one coingecko call TOTAL across both requests.
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.rates.get("USD")).toEqual(first.rates.get("USD"));
    expect(second.rates.get("BTC")).toEqual(first.rates.get("BTC"));
  });
});

describe("getRatesToHome — unpriced currencies never throw", () => {
  it("maps an unknown symbol (frankfurter 404) to a null quote, never a throw", async () => {
    mockedGet.mockResolvedValueOnce(ratesResponse(404, { message: "not found" }));

    const { rates, errors } = await getRatesToHome("GBP", ["XMR"]);

    expect(rates.get("XMR")).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("404");
    expect(errors[0]).toContain("XMR");
  });

  it("prices the symbols coingecko returned and nulls the missing ones", async () => {
    mockedGet.mockResolvedValueOnce(
      ratesResponse(200, {
        bitcoin: { gbp: 79123.45, last_updated_at: 1749600000 },
        // ethereum deliberately absent from the response
      })
    );

    const { rates, errors } = await getRatesToHome("GBP", ["BTC", "ETH"]);

    expect((rates.get("BTC") as RateQuote).rateScaled).toBe(79123450000000000n);
    expect(rates.get("ETH")).toBeNull();
    expect(errors).toEqual(["coingecko returned no ETH→GBP rate"]);
  });

  it("rejects a malformed currency symbol locally — null quote, no HTTP", async () => {
    const { rates, errors } = await getRatesToHome("GBP", ["not-a-code!"]);

    expect(mockedGet).not.toHaveBeenCalled();
    expect(rates.get("NOT-A-CODE!")).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("getRatesToHome — error hygiene (errorHandler console.logs raw objects)", () => {
  it("transport failures surface only the code + path template — never the axios config", async () => {
    const transportError = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.frankfurter.app"),
      {
        isAxiosError: true,
        code: "ENOTFOUND",
        config: {
          url: FRANKFURTER_URL,
          headers: { "X-Fake": "AXIOS_CONFIG_CANARY" },
        },
      }
    );
    mockedGet.mockRejectedValueOnce(transportError);

    const result = await getRatesToHome("GBP", ["USD"]);

    expect(result.rates.get("USD")).toBeNull();
    expect(result.errors[0]).toContain("ENOTFOUND");
    expect(result.errors[0]).toContain("/latest");
    // Even a logger that deep-inspects the whole result can never see the
    // axios request config.
    expect(inspect(result, { depth: 10 })).not.toContain("AXIOS_CONFIG_CANARY");
  });

  it("HTTP failures surface only the status — never the response payload", async () => {
    mockedGet.mockResolvedValueOnce(
      ratesResponse(503, { detail: "UPSTREAM_PAYLOAD_CANARY" })
    );

    const result = await getRatesToHome("GBP", ["BTC"]);

    expect(result.rates.get("BTC")).toBeNull();
    expect(result.errors[0]).toContain("HTTP 503");
    expect(inspect(result, { depth: 10 })).not.toContain(
      "UPSTREAM_PAYLOAD_CANARY"
    );
  });
});
