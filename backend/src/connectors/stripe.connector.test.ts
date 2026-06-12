import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import axios, { AxiosResponse } from "axios";
import { createStripeConnector } from "./stripe.connector";
import { ConnectorContext } from "./types";
import { InternalServerException } from "../utils/app-error";

// All HTTP is mocked at the axios boundary — these tests never touch the
// network. Fixtures mirror real Stripe payload shapes; the key is an
// obviously-fake placeholder, never a real key shape with entropy.
vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);

const FAKE_KEY = "rk_test_FAKE";
const DEFAULT_REF = "STRIPE_RESTRICTED_KEY";

const ctx: ConnectorContext = {
  credentialRef: null,
  externalAccountId: "acct_FAKE000000000001",
};

// Minimal-but-valid AxiosResponse so the mock satisfies the real signature.
const stripeResponse = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): AxiosResponse =>
  ({
    status,
    statusText: status === 200 ? "OK" : "",
    data,
    headers,
    config: {},
  } as AxiosResponse);

// --- Fixtures ----------------------------------------------------------------

// GET /v1/balance — multi-currency: USD and JPY present, GBP absent.
const balanceFixture = {
  object: "balance",
  available: [
    { amount: 125000, currency: "usd", source_types: { card: 125000 } },
    { amount: 80000, currency: "eur", source_types: { card: 80000 } },
    { amount: 54321, currency: "jpy", source_types: { card: 54321 } },
  ],
  livemode: false,
  pending: [
    { amount: -2500, currency: "usd", source_types: { card: -2500 } },
    { amount: 679, currency: "jpy", source_types: { card: 679 } },
  ],
};

const balanceTxn = (
  overrides: Partial<{
    id: string;
    amount: number;
    created: number;
    currency: string;
    description: string | null;
    reporting_category: string;
    type: string;
  }> = {}
) => ({
  id: "txn_FAKE0000000000000001",
  object: "balance_transaction",
  amount: 10000,
  available_on: 1749600000,
  created: 1749590000,
  currency: "usd",
  description: "Subscription payment — Acme Co",
  exchange_rate: null,
  fee: 320,
  fee_details: [
    {
      amount: 320,
      currency: "usd",
      description: "Stripe processing fees",
      type: "stripe_fee",
    },
  ],
  net: 9680,
  reporting_category: "charge",
  source: "ch_FAKE0000000000000001",
  status: "available",
  type: "charge",
  ...overrides,
});

// GET /v1/balance_transactions — page 1 of 2.
const txnPage1 = {
  object: "list",
  url: "/v1/balance_transactions",
  has_more: true,
  data: [
    balanceTxn(),
    balanceTxn({
      id: "txn_FAKE0000000000000002",
      amount: -50000,
      created: 1749500000,
      description: null,
      reporting_category: "payout",
      type: "payout",
    }),
  ],
};

// Page 2 of 2 — includes a zero-decimal (JPY) transaction.
const txnPage2 = {
  object: "list",
  url: "/v1/balance_transactions",
  has_more: false,
  data: [
    balanceTxn({
      id: "txn_FAKE0000000000000003",
      amount: 700,
      created: 1749400000,
      currency: "jpy",
      description: "JPY card charge",
    }),
  ],
};

const stripe401 = {
  error: {
    type: "invalid_request_error",
    message:
      "The provided key does not have access to this resource (or a similar Stripe message).",
  },
};

// ------------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv(DEFAULT_REF, FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("createStripeConnector", () => {
  it('has type "stripe"', () => {
    expect(createStripeConnector("USD").type).toBe("stripe");
  });

  it("rejects an empty account currency at construction", () => {
    expect(() => createStripeConnector("  ")).toThrow(InternalServerException);
  });
});

describe("fetchBalance", () => {
  it("sums available + pending for the account currency only (USD, 2 decimals)", async () => {
    mockedGet.mockResolvedValueOnce(stripeResponse(200, balanceFixture));

    const balance = await createStripeConnector("USD").fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("122500"); // 125000 - 2500; EUR/JPY ignored
    expect(balance.currency).toBe("USD");
    expect(balance.decimals).toBe(2);
    expect(balance.asOf).toBeInstanceOf(Date);
  });

  it("calls GET /v1/balance with a Bearer header and no params", async () => {
    mockedGet.mockResolvedValueOnce(stripeResponse(200, balanceFixture));

    await createStripeConnector("USD").fetchBalance(ctx);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockedGet.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/balance");
    expect(config?.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` });
    expect(config?.params).toBeUndefined();
  });

  it("handles zero-decimal currencies: JPY amounts pass through with decimals 0", async () => {
    mockedGet.mockResolvedValueOnce(stripeResponse(200, balanceFixture));

    const balance = await createStripeConnector("JPY").fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("55000"); // 54321 + 679, whole yen
    expect(balance.currency).toBe("JPY");
    expect(balance.decimals).toBe(0);
  });

  it("fails loud when the pinned currency has no entries but other currencies do (misconfigured account currency)", async () => {
    // Without this, a wrong account currency would confidently sync a false
    // "0" over a real balance on every run — the never-mix-currencies guard
    // in the sync service can't fire for Stripe (the connector always reports
    // the pinned currency back).
    mockedGet.mockResolvedValueOnce(stripeResponse(200, balanceFixture));

    try {
      await createStripeConnector("GBP").fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("GBP");
      expect(message).toMatch(/EUR, JPY, USD/); // what Stripe actually holds
      expect(message).not.toContain(FAKE_KEY);
    }
  });

  it('reports "0" when the balance has no entries at all (account genuinely holds nothing)', async () => {
    mockedGet.mockResolvedValueOnce(
      stripeResponse(200, { object: "balance", available: [], pending: [] })
    );

    const balance = await createStripeConnector("GBP").fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("0");
    expect(balance.currency).toBe("GBP");
    expect(balance.decimals).toBe(2);
  });

  it("throws (naming the env var) when the credential env var is unset", async () => {
    vi.stubEnv(DEFAULT_REF, "");

    await expect(createStripeConnector("USD").fetchBalance(ctx)).rejects.toThrow(
      DEFAULT_REF
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });
});

describe("fetchTransactions", () => {
  const since = new Date("2026-06-01T00:00:00Z");
  const sinceUnix = Math.floor(since.getTime() / 1000);

  it("paginates via starting_after until has_more is false and maps every field", async () => {
    mockedGet
      .mockResolvedValueOnce(stripeResponse(200, txnPage1))
      .mockResolvedValueOnce(stripeResponse(200, txnPage2));

    const txns = await createStripeConnector("USD").fetchTransactions(
      ctx,
      since
    );

    expect(txns).toHaveLength(3);

    // Page 1, item 1: description wins the title; sign + units untouched.
    expect(txns[0]).toMatchObject({
      externalId: "txn_FAKE0000000000000001",
      title: "Subscription payment — Acme Co",
      amountMinor: "10000",
      currency: "USD",
    });
    expect(txns[0].date).toEqual(new Date(1749590000 * 1000));
    expect(txns[0].raw).toEqual(txnPage1.data[0]);

    // Page 1, item 2: null description falls back to the reporting category;
    // Stripe's signed amount (money out) is preserved as-is.
    expect(txns[1]).toMatchObject({
      externalId: "txn_FAKE0000000000000002",
      title: "Stripe: payout",
      amountMinor: "-50000",
      currency: "USD",
    });

    // Page 2: zero-decimal currency transaction comes through untouched.
    expect(txns[2]).toMatchObject({
      externalId: "txn_FAKE0000000000000003",
      amountMinor: "700",
      currency: "JPY",
    });
  });

  it("sends created[gte]/limit on every page and starting_after only after page 1", async () => {
    mockedGet
      .mockResolvedValueOnce(stripeResponse(200, txnPage1))
      .mockResolvedValueOnce(stripeResponse(200, txnPage2));

    await createStripeConnector("USD").fetchTransactions(ctx, since);

    expect(mockedGet).toHaveBeenCalledTimes(2);

    const [url1, config1] = mockedGet.mock.calls[0];
    expect(url1).toBe("https://api.stripe.com/v1/balance_transactions");
    expect(config1?.params).toEqual({
      "created[gte]": sinceUnix,
      limit: 100,
    });
    expect(config1?.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` });

    const [, config2] = mockedGet.mock.calls[1];
    expect(config2?.params).toEqual({
      "created[gte]": sinceUnix,
      limit: 100,
      starting_after: "txn_FAKE0000000000000002", // last id of page 1
    });
  });

  it("returns an empty list for an empty single page", async () => {
    mockedGet.mockResolvedValueOnce(
      stripeResponse(200, { object: "list", data: [], has_more: false })
    );

    const txns = await createStripeConnector("USD").fetchTransactions(
      ctx,
      since
    );
    expect(txns).toEqual([]);
  });
});

describe("auth failures (401/403)", () => {
  it("throws InternalServerException naming the env var and the missing scope, never the key", async () => {
    mockedGet.mockResolvedValueOnce(stripeResponse(401, stripe401));

    try {
      await createStripeConnector("USD").fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain(DEFAULT_REF);
      expect(message).toContain("balance:read");
      expect(message).toContain("balance_transactions:read");
      expect(message).not.toContain(FAKE_KEY);
    }
  });

  it("treats 403 the same way for fetchTransactions", async () => {
    mockedGet.mockResolvedValueOnce(stripeResponse(403, stripe401));

    await expect(
      createStripeConnector("USD").fetchTransactions(ctx, new Date(0))
    ).rejects.toThrow(DEFAULT_REF);
  });

  it("names a custom credentialRef from the context instead of the default", async () => {
    const ALT_REF = "STRIPE_CASHLOOM_TEST_ALT_KEY";
    vi.stubEnv(ALT_REF, FAKE_KEY);
    mockedGet.mockResolvedValueOnce(stripeResponse(401, stripe401));

    await expect(
      createStripeConnector("USD").fetchBalance({
        ...ctx,
        credentialRef: ALT_REF,
      })
    ).rejects.toThrow(ALT_REF);
  });
});

describe("credentialRef namespace (defence in depth)", () => {
  // The Stripe connector must only ever resolve STRIPE_* env vars: a stored
  // ref naming any OTHER secret would be read and transmitted to Stripe as a
  // bearer token — blind exfiltration of server secrets.
  it.each(["GOCARDLESS_SECRET_KEY", "JWT_SECRET", "DATABASE_URL"])(
    "refuses credentialRef %s without reading the env or calling Stripe",
    async (ref) => {
      vi.stubEnv(ref, "super_secret_FAKE");

      try {
        await createStripeConnector("USD").fetchBalance({
          ...ctx,
          credentialRef: ref,
        });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InternalServerException);
        // Names the refused VARIABLE, never any value; nothing left the box.
        expect((e as Error).message).toContain(ref);
        expect((e as Error).message).not.toContain("super_secret_FAKE");
      }
      expect(mockedGet).not.toHaveBeenCalled();
    }
  );
});

describe("network-level failures", () => {
  it("re-wraps a transport error so the axios config (and bearer token) never escapes", async () => {
    // validateStatus only absorbs HTTP statuses — ECONNRESET/DNS/TLS failures
    // still reject with a raw AxiosError whose config carries the
    // Authorization header. The connector must re-wrap it, or the errorHandler
    // middleware's console.log would print the live key to the server logs.
    const transportError = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
      {
        isAxiosError: true,
        code: "ECONNREFUSED",
        config: { headers: { Authorization: `Bearer ${FAKE_KEY}` } },
      }
    );
    mockedGet.mockRejectedValueOnce(transportError);

    try {
      await createStripeConnector("USD").fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("/v1/balance");
      expect(message).toContain("ECONNREFUSED");
      expect(message).not.toContain(FAKE_KEY);
      // The wrapped error carries no axios request config at all, so even a
      // logger that deep-inspects the error object can never see the key.
      expect((e as { config?: unknown }).config).toBeUndefined();
      expect(inspect(e, { depth: 10 })).not.toContain(FAKE_KEY);
    }
  });

  it("re-wraps a transport error from fetchTransactions the same way", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("read ETIMEDOUT"), {
        isAxiosError: true,
        code: "ETIMEDOUT",
        config: { headers: { Authorization: `Bearer ${FAKE_KEY}` } },
      })
    );

    try {
      await createStripeConnector("USD").fetchTransactions(ctx, new Date(0));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("/v1/balance_transactions");
      expect((e as Error).message).toContain("ETIMEDOUT");
      expect(inspect(e, { depth: 10 })).not.toContain(FAKE_KEY);
    }
  });
});

describe("rate limiting (429)", () => {
  it("retries once after Retry-After, then succeeds", async () => {
    mockedGet
      .mockResolvedValueOnce(stripeResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(stripeResponse(200, balanceFixture));

    const balance = await createStripeConnector("USD").fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("122500");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("fails after a second consecutive 429", async () => {
    mockedGet
      .mockResolvedValueOnce(stripeResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(stripeResponse(429, {}, { "retry-after": "0" }));

    await expect(
      createStripeConnector("USD").fetchBalance(ctx)
    ).rejects.toThrow(/429/);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });
});

describe("other HTTP failures", () => {
  it("throws InternalServerException with the status for a 500", async () => {
    mockedGet.mockResolvedValueOnce(
      stripeResponse(500, { error: { type: "api_error" } })
    );

    await expect(
      createStripeConnector("USD").fetchBalance(ctx)
    ).rejects.toThrow(/500/);
  });
});
