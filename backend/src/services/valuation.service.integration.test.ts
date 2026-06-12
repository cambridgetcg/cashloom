import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import AccountModel, {
  AccountStatusEnum,
  RailEnum,
} from "../models/account.model";
import UserModel from "../models/user.model";
import { getRatesToHome, RateQuote } from "./fx-rates.service";
import { netWorthValuationService } from "./valuation.service";
import { RATE_SCALE, scaleRateToBigInt } from "../utils/rate-math";

// Real-DB proof of the valuation layer: group-subtotal BigInt aggregation
// (components sum to the total EXACTLY, wei-safe far above
// Number.MAX_SAFE_INTEGER), owner scoping, the archived-accounts-excluded
// product choice, partial-tolerant degradation (unpriced currency → loud
// unconverted[], never a throw), and ZERO WRITES — a settable balance is a
// forgeable balance, so valuation must never touch an account document.
//
// The rate layer is mocked AT THE MODULE BOUNDARY (fx-rates.service): no
// axios, no network, no real rate APIs. Quote fixtures are built with the
// REAL scaleRateToBigInt so every expected value below is hand-computed from
// the same scaled-BigInt rates the service applies.

vi.mock("./fx-rates.service", () => ({
  getRatesToHome: vi.fn(),
}));

const mockedGetRatesToHome = vi.mocked(getRatesToHome);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await AccountModel.init();
}, 120000); // first run downloads a mongod binary

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await UserModel.deleteMany({});
  mockedGetRatesToHome.mockReset();
});

/* --------------------------------- fixtures -------------------------------- */

const RATE_AS_OF = new Date("2026-06-11T12:00:00.000Z");

const quote = (
  rateDecimal: string,
  source: RateQuote["source"],
  opts: { stale?: boolean; asOf?: Date } = {}
): RateQuote => ({
  rateScaled: scaleRateToBigInt(rateDecimal),
  scale: RATE_SCALE,
  asOf: opts.asOf ?? RATE_AS_OF,
  source,
  stale: opts.stale ?? false,
});

const ratesResult = (
  entries: Record<string, RateQuote | null>,
  errors: string[] = []
) => ({ rates: new Map(Object.entries(entries)), errors });

const seedAccount = (
  userId: mongoose.Types.ObjectId,
  overrides: Partial<{
    rail: RailEnum;
    displayName: string;
    currency: string;
    decimals: number;
    balanceMinor: string;
    status: AccountStatusEnum;
  }> = {}
) =>
  AccountModel.create({
    userId,
    rail: RailEnum.BANK,
    displayName: "Account",
    currency: "GBP",
    decimals: 2,
    balanceMinor: "0",
    ...overrides,
  });

// Bypasses the password requirement + bcrypt hook — only the display currency
// matters here.
const seedUser = async (currency: string): Promise<mongoose.Types.ObjectId> => {
  const _id = new mongoose.Types.ObjectId();
  await UserModel.collection.insertOne({
    _id,
    name: "Alex",
    email: `${_id.toHexString()}@example.test`,
    currency,
  });
  return _id;
};

const groupFor = (
  netWorth: Awaited<ReturnType<typeof netWorthValuationService>>,
  rail: string,
  currency: string
) => {
  const group = netWorth.groups.find(
    (g) => g.rail === rail && g.currency === currency
  );
  expect(group).toBeDefined();
  return group!;
};

const railFor = (
  netWorth: Awaited<ReturnType<typeof netWorthValuationService>>,
  rail: string
) => {
  const entry = netWorth.byRail.find((r) => r.rail === rail);
  expect(entry).toBeDefined();
  return entry!;
};

/* ---------------------------------- tests ---------------------------------- */

describe("netWorthValuationService — multi-rail aggregation", () => {
  it("converts group subtotals BigInt-exactly (wei-safe) and the components sum to the total", async () => {
    // Home resolves from the user's stored display currency, uppercased.
    const me = await seedUser("gbp");
    await seedAccount(me, {
      rail: RailEnum.BANK,
      displayName: "Main bank",
      currency: "GBP",
      balanceMinor: "250000", // £2500.00 — identity, no rounding
    });
    await seedAccount(me, {
      rail: RailEnum.STRIPE,
      displayName: "Stripe",
      currency: "USD",
      balanceMinor: "1234567", // $12,345.67 × 0.79 = £9,753.0793 → 975308p
    });
    await seedAccount(me, {
      rail: RailEnum.CRYPTO,
      displayName: "Cold BTC",
      currency: "BTC",
      decimals: 8,
      balanceMinor: "12345678", // 0.12345678 BTC × £80,000 = 987654.24p → 987654
    });
    // 123.456789012345678901 ETH in wei — far above Number.MAX_SAFE_INTEGER;
    // any float on the path would mangle it. × £2000 = 24,691,357.802...p
    await seedAccount(me, {
      rail: RailEnum.CRYPTO,
      displayName: "Hot ETH",
      currency: "ETH",
      decimals: 18,
      balanceMinor: "123456789012345678901",
    });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({
        GBP: quote("1", "identity"),
        USD: quote("0.79", "frankfurter"),
        BTC: quote("80000", "coingecko"),
        ETH: quote("2000", "coingecko"),
      })
    );

    const before = await AccountModel.collection
      .find({ userId: me })
      .toArray();

    const netWorth = await netWorthValuationService(String(me));

    expect(netWorth.home).toBe("GBP");
    expect(netWorth.homeDecimals).toBe(2);

    // ONE rate per DISTINCT currency.
    expect(mockedGetRatesToHome).toHaveBeenCalledTimes(1);
    const [homeArg, currenciesArg] = mockedGetRatesToHome.mock.calls[0];
    expect(homeArg).toBe("GBP");
    expect([...currenciesArg].sort()).toEqual(["BTC", "ETH", "GBP", "USD"]);

    // Hand-computed homeValueMinor per group (half-away-from-zero, once per
    // group): see the inline arithmetic on each seed above.
    const gbp = groupFor(netWorth, RailEnum.BANK, "GBP");
    expect(gbp.homeValueMinor).toBe("250000");
    expect(gbp.rate).toBe("1.000000000000");
    expect(gbp.rateSource).toBe("identity");

    const usd = groupFor(netWorth, RailEnum.STRIPE, "USD");
    expect(usd.homeValueMinor).toBe("975308"); // 975307.93 rounds up
    expect(usd.rate).toBe("0.790000000000");
    expect(usd.rateSource).toBe("frankfurter");
    expect(usd.rateAsOf).toBe(RATE_AS_OF.toISOString());

    const btc = groupFor(netWorth, RailEnum.CRYPTO, "BTC");
    expect(btc.homeValueMinor).toBe("987654"); // 987654.24 rounds down
    expect(btc.formatted).toBe("0.12345678");
    expect(btc.rate).toBe("80000.000000000000");

    const eth = groupFor(netWorth, RailEnum.CRYPTO, "ETH");
    expect(eth.balanceMinor).toBe("123456789012345678901"); // verbatim
    expect(eth.formatted).toBe("123.456789012345678901");
    expect(eth.homeValueMinor).toBe("24691358"); // …57.8024… rounds up
    expect(eth.homeValueFormatted).toBe("246913.58");

    // The components are additive to the total BY CONSTRUCTION.
    expect(netWorth.totalHomeMinor).toBe("26904320"); // 250000+975308+987654+24691358
    expect(netWorth.totalFormatted).toBe("269043.20");
    const groupSum = netWorth.groups.reduce(
      (sum, g) => sum + BigInt(g.homeValueMinor ?? "0"),
      0n
    );
    expect(groupSum.toString()).toBe(netWorth.totalHomeMinor);

    // byRail: BigInt sums of each rail's converted groups + account counts.
    expect(railFor(netWorth, RailEnum.BANK)).toMatchObject({
      homeValueMinor: "250000",
      homeValueFormatted: "2500.00",
      accountCount: 1,
    });
    expect(railFor(netWorth, RailEnum.STRIPE)).toMatchObject({
      homeValueMinor: "975308",
      accountCount: 1,
    });
    expect(railFor(netWorth, RailEnum.CRYPTO)).toMatchObject({
      homeValueMinor: "25679012", // 987654 + 24691358
      homeValueFormatted: "256790.12",
      accountCount: 2,
    });
    const railSum = netWorth.byRail.reduce(
      (sum, r) => sum + BigInt(r.homeValueMinor),
      0n
    );
    expect(railSum.toString()).toBe(netWorth.totalHomeMinor);

    expect(netWorth.complete).toBe(true);
    expect(netWorth.stale).toBe(false);
    expect(netWorth.unconverted).toEqual([]);
    expect(netWorth.warnings).toEqual([]);
    expect(netWorth.disclaimer).toBe(
      "Indicative valuation from public market rates — informational only, not financial advice."
    );
    expect(new Date(netWorth.asOf).getTime()).not.toBeNaN();

    // ZERO WRITES: valuation is derived/display-layer — every account document
    // must be byte-for-byte untouched (raw driver read bypasses Mongoose).
    const after = await AccountModel.collection.find({ userId: me }).toArray();
    expect(after).toEqual(before);
  });

  it("BigInt-sums same-(rail,currency,decimals) accounts into ONE group and requests each currency once", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, { rail: RailEnum.BANK, balanceMinor: "100" });
    await seedAccount(me, { rail: RailEnum.BANK, balanceMinor: "200" });
    await seedAccount(me, { rail: RailEnum.CASH, balanceMinor: "50" });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1", "identity") })
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(mockedGetRatesToHome).toHaveBeenCalledTimes(1);
    expect(mockedGetRatesToHome.mock.calls[0][1]).toEqual(["GBP"]);

    expect(netWorth.groups).toHaveLength(2);
    expect(groupFor(netWorth, RailEnum.BANK, "GBP").balanceMinor).toBe("300");
    expect(railFor(netWorth, RailEnum.BANK)).toMatchObject({
      homeValueMinor: "300",
      accountCount: 2,
    });
    expect(railFor(netWorth, RailEnum.CASH)).toMatchObject({
      homeValueMinor: "50",
      accountCount: 1,
    });
    expect(netWorth.totalHomeMinor).toBe("350");
  });

  it("subtracts negative balances through conversion (sign-preserving rounding)", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, { rail: RailEnum.BANK, balanceMinor: "50000" });
    await seedAccount(me, {
      rail: RailEnum.STRIPE,
      currency: "USD",
      balanceMinor: "-10000", // -$100 × 0.79 = -£79.00
    });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({
        GBP: quote("1", "identity"),
        USD: quote("0.79", "frankfurter"),
      })
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    const usd = groupFor(netWorth, RailEnum.STRIPE, "USD");
    expect(usd.homeValueMinor).toBe("-7900");
    expect(usd.formatted).toBe("-100.00");
    expect(netWorth.totalHomeMinor).toBe("42100"); // 50000 - 7900
    expect(netWorth.totalFormatted).toBe("421.00");
  });
});

describe("netWorthValuationService — scoping", () => {
  it("excludes ARCHIVED accounts and other users' accounts (owner-scope/IDOR shape)", async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await seedAccount(me, { balanceMinor: "10000" });
    await seedAccount(me, {
      balanceMinor: "999999",
      status: AccountStatusEnum.ARCHIVED, // visible on the page, NOT counted
    });
    await seedAccount(other, { balanceMinor: "888888" });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1", "identity") })
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(netWorth.totalHomeMinor).toBe("10000");
    expect(netWorth.groups).toHaveLength(1);
    expect(netWorth.groups[0].balanceMinor).toBe("10000");
    expect(railFor(netWorth, RailEnum.BANK).accountCount).toBe(1);
  });

  it("returns an empty valuation (no rate calls) for a user with no active accounts", async () => {
    const me = new mongoose.Types.ObjectId();

    const netWorth = await netWorthValuationService(String(me));

    expect(mockedGetRatesToHome).not.toHaveBeenCalled();
    expect(netWorth.home).toBe("USD"); // no user document → USD fallback
    expect(netWorth.totalHomeMinor).toBe("0");
    expect(netWorth.totalFormatted).toBe("0.00");
    expect(netWorth.groups).toEqual([]);
    expect(netWorth.byRail).toEqual([]);
    expect(netWorth.complete).toBe(true);
  });
});

describe("netWorthValuationService — partial tolerance", () => {
  it("parks an unpriced currency in unconverted[] with its balance intact while the total stays exact over priced groups", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, { rail: RailEnum.BANK, balanceMinor: "10000" });
    await seedAccount(me, {
      rail: RailEnum.CRYPTO,
      currency: "XMR", // unknown to both rate sources
      decimals: 12,
      balanceMinor: "5000000000000", // 5 XMR
    });

    const reason = "frankfurter returned no XMR→GBP rate";
    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1", "identity"), XMR: null }, [reason])
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(netWorth.complete).toBe(false);
    expect(netWorth.totalHomeMinor).toBe("10000"); // XMR excluded, loudly
    expect(netWorth.unconverted).toEqual([
      {
        currency: "XMR",
        balanceMinor: "5000000000000",
        decimals: 12,
        reason,
      },
    ]);
    expect(netWorth.warnings).toContain(reason);

    // The unpriced group still renders — balance intact, valuation null.
    const xmr = groupFor(netWorth, RailEnum.CRYPTO, "XMR");
    expect(xmr.formatted).toBe("5.000000000000");
    expect(xmr.rate).toBeNull();
    expect(xmr.rateSource).toBeNull();
    expect(xmr.homeValueMinor).toBeNull();
    expect(xmr.homeValueFormatted).toBeNull();

    // Its rail still reports the account, with zero converted value.
    expect(railFor(netWorth, RailEnum.CRYPTO)).toMatchObject({
      homeValueMinor: "0",
      accountCount: 1,
    });
  });

  it("attributes each unpriced group its OWN reason — USD never borrows USDC's failure text (currency codes are not substring-safe)", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, {
      rail: RailEnum.STRIPE,
      currency: "USD",
      balanceMinor: "10000",
    });
    await seedAccount(me, {
      rail: RailEnum.PLATFORM_CREDIT,
      currency: "USDC",
      decimals: 6,
      balanceMinor: "5000000",
    });

    // The USDC reason comes FIRST and embeds "USD" as a substring of its pair
    // ("USDC→GBP" contains "USD") — exactly the ordering that made a naive
    // substring match label the USD group with USDC's failure.
    const usdcReason =
      "frankfurter request for USDC→GBP failed with HTTP 404 (GET /latest)";
    const usdReason =
      "frankfurter request for USD→GBP failed with HTTP 503 (GET /latest)";
    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1", "identity"), USDC: null, USD: null }, [
        usdcReason,
        usdReason,
      ])
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(netWorth.complete).toBe(false);
    const usd = netWorth.unconverted.find((e) => e.currency === "USD");
    const usdc = netWorth.unconverted.find((e) => e.currency === "USDC");
    expect(usd?.reason).toBe(usdReason);
    expect(usdc?.reason).toBe(usdcReason);
  });

  it("survives a total rate-layer failure as a 200-shaped result, never a throw", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, { rail: RailEnum.BANK, balanceMinor: "10000" });
    await seedAccount(me, {
      rail: RailEnum.CRYPTO,
      currency: "BTC",
      decimals: 8,
      balanceMinor: "100000000",
    });

    const reason =
      "coingecko rate limited (HTTP 429) on GET /api/v3/simple/price — deliberately not retried";
    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1", "identity"), BTC: null }, [reason])
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(netWorth.complete).toBe(false);
    expect(netWorth.totalHomeMinor).toBe("10000"); // crypto unpriced, fiat intact
    expect(netWorth.unconverted).toHaveLength(1);
    expect(netWorth.unconverted[0].currency).toBe("BTC");
    expect(netWorth.warnings).toContain(reason);
  });

  it("flags the whole valuation stale when any applied quote is stale", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, {
      rail: RailEnum.STRIPE,
      currency: "USD",
      balanceMinor: "10000",
    });

    const reason =
      "frankfurter request for USD→GBP failed with HTTP 503 (GET /latest) — serving rates from 2026-06-11T12:00:00.000Z";
    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ USD: quote("0.79", "frankfurter", { stale: true }) }, [
        reason,
      ])
    );

    const netWorth = await netWorthValuationService(String(me), "GBP");

    expect(netWorth.stale).toBe(true);
    const usd = groupFor(netWorth, RailEnum.STRIPE, "USD");
    expect(usd.rateStale).toBe(true);
    expect(usd.homeValueMinor).toBe("7900"); // stale still values
    expect(netWorth.complete).toBe(true); // stale ≠ unpriced
    expect(netWorth.warnings).toContain(reason);
  });
});

describe("netWorthValuationService — home currency resolution & formatting", () => {
  it("homeOverride wins over the user's stored display currency", async () => {
    const me = await seedUser("usd");
    await seedAccount(me, { balanceMinor: "10000" });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("1.17", "frankfurter") })
    );

    const netWorth = await netWorthValuationService(String(me), "EUR");

    expect(netWorth.home).toBe("EUR");
    expect(mockedGetRatesToHome).toHaveBeenCalledWith("EUR", ["GBP"]);
    expect(netWorth.totalHomeMinor).toBe("11700"); // £100 × 1.17 = €117.00
  });

  it("formats a JPY home (0 decimals) via formatMinor — no decimal point", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, { balanceMinor: "10000" }); // £100 × 190.5 = ¥19050

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ GBP: quote("190.5", "frankfurter") })
    );

    const netWorth = await netWorthValuationService(String(me), "JPY");

    expect(netWorth.homeDecimals).toBe(0);
    expect(netWorth.totalHomeMinor).toBe("19050");
    expect(netWorth.totalFormatted).toBe("19050");
    expect(groupFor(netWorth, RailEnum.BANK, "GBP").homeValueFormatted).toBe(
      "19050"
    );
  });

  it("formats a BHD home (3 decimals) via formatMinor", async () => {
    const me = new mongoose.Types.ObjectId();
    await seedAccount(me, {
      rail: RailEnum.STRIPE,
      currency: "USD",
      balanceMinor: "10000", // $100 × 0.376 = 37.600 BHD = 37600 fils
    });

    mockedGetRatesToHome.mockResolvedValue(
      ratesResult({ USD: quote("0.376", "frankfurter") })
    );

    const netWorth = await netWorthValuationService(String(me), "BHD");

    expect(netWorth.homeDecimals).toBe(3);
    expect(netWorth.totalHomeMinor).toBe("37600");
    expect(netWorth.totalFormatted).toBe("37.600");
  });
});
