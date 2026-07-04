import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

// Mock the entire axios surface the connector touches — every test runs
// against fixtures, nothing ever hits the network.
vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import axios from "axios";
import {
  gocardlessConnector,
  decimalToMinor,
  resetGoCardlessTokenCache,
  listInstitutions,
  createRequisition,
  getRequisition,
} from "./gocardless.connector";
import {
  AppError,
  HttpException,
  InternalServerException,
} from "../utils/app-error";
import { HTTPSTATUS } from "../config/http.config";

const mockedGet = axios.get as unknown as Mock;
const mockedPost = axios.post as unknown as Mock;

// Obviously-fake placeholders — never real key/token shapes with entropy.
const FAKE_SECRET_ID = "gc_secret_id_FAKE";
const FAKE_SECRET_KEY = "gc_secret_key_FAKE";
const FAKE_TOKEN = "gc_access_token_FAKE";
const FAKE_TOKEN_2 = "gc_access_token_FAKE_2";

const ctx = { credentialRef: null, externalAccountId: "acct-uuid-1" };

const tokenResponse = (access = FAKE_TOKEN, accessExpires = 86400) => ({
  data: { access, access_expires: accessExpires },
});

const balancesResponse = (
  balances: Array<{
    amount: string;
    currency?: string;
    balanceType?: string;
    referenceDate?: string;
  }>
) => ({
  data: {
    balances: balances.map((b) => ({
      balanceAmount: { amount: b.amount, currency: b.currency ?? "GBP" },
      balanceType: b.balanceType,
      referenceDate: b.referenceDate,
    })),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetGoCardlessTokenCache();
  vi.stubEnv("GOCARDLESS_SECRET_ID", FAKE_SECRET_ID);
  vi.stubEnv("GOCARDLESS_SECRET_KEY", FAKE_SECRET_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decimalToMinor", () => {
  it('converts a whole-number string: "5" @2 → "500"', () => {
    expect(decimalToMinor("5", 2)).toBe("500");
  });

  it('pads a short fraction: "5.5" @2 → "550"', () => {
    expect(decimalToMinor("5.5", 2)).toBe("550");
  });

  it('keeps the sign on sub-unit amounts: "-0.01" @2 → "-1"', () => {
    expect(decimalToMinor("-0.01", 2)).toBe("-1");
  });

  it('converts a full decimal: "123.45" @2 → "12345"', () => {
    expect(decimalToMinor("123.45", 2)).toBe("12345");
  });

  it("normalizes zero, including negative zero", () => {
    expect(decimalToMinor("0.00", 2)).toBe("0");
    expect(decimalToMinor("-0.00", 2)).toBe("0");
  });

  it("respects a decimals of 0", () => {
    expect(decimalToMinor("7", 0)).toBe("7");
  });

  it("throws InternalServerException on malformed strings", () => {
    for (const bad of ["", "12,34", "1.2.3", "abc", "1e2", " 5", "+5", "5."]) {
      expect(() => decimalToMinor(bad, 2)).toThrow(InternalServerException);
    }
  });

  it("refuses to round a fraction longer than the currency's decimals", () => {
    expect(() => decimalToMinor("1.234", 2)).toThrow(InternalServerException);
  });
});

describe("token handling", () => {
  it("POSTs the secret pair to /token/new/ and sends the bearer on data calls", async () => {
    mockedPost.mockResolvedValueOnce(tokenResponse());
    mockedGet.mockResolvedValueOnce(
      balancesResponse([{ amount: "10.00", balanceType: "interimAvailable" }])
    );

    await gocardlessConnector.fetchBalance(ctx);

    expect(mockedPost).toHaveBeenCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/token/new/",
      { secret_id: FAKE_SECRET_ID, secret_key: FAKE_SECRET_KEY }
    );
    expect(mockedGet).toHaveBeenCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/accounts/acct-uuid-1/balances/",
      { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }
    );
  });

  it("caches the token across calls (one token POST for two data calls)", async () => {
    mockedPost.mockResolvedValueOnce(tokenResponse());
    mockedGet.mockResolvedValue(
      balancesResponse([{ amount: "10.00", balanceType: "interimAvailable" }])
    );

    await gocardlessConnector.fetchBalance(ctx);
    await gocardlessConnector.fetchBalance(ctx);

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("refreshes by re-POSTing /token/new/ when under 60s of life remain", async () => {
    // First token expires in 30s — already inside the 60s refresh margin, so
    // the next call must fetch a fresh one and use it.
    mockedPost
      .mockResolvedValueOnce(tokenResponse(FAKE_TOKEN, 30))
      .mockResolvedValueOnce(tokenResponse(FAKE_TOKEN_2, 86400));
    mockedGet.mockResolvedValue(
      balancesResponse([{ amount: "10.00", balanceType: "interimAvailable" }])
    );

    await gocardlessConnector.fetchBalance(ctx);
    await gocardlessConnector.fetchBalance(ctx);

    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenLastCalledWith(expect.any(String), {
      headers: { Authorization: `Bearer ${FAKE_TOKEN_2}` },
    });
  });

  it("throws an AppError naming the env VAR when a secret is unconfigured", async () => {
    delete process.env.GOCARDLESS_SECRET_ID;

    await expect(gocardlessConnector.fetchBalance(ctx)).rejects.toThrow(
      "GOCARDLESS_SECRET_ID"
    );
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("throws when the token endpoint returns no usable token", async () => {
    mockedPost.mockResolvedValueOnce({ data: {} });

    await expect(gocardlessConnector.fetchBalance(ctx)).rejects.toThrow(
      InternalServerException
    );
  });
});

describe("fetchBalance", () => {
  beforeEach(() => {
    mockedPost.mockResolvedValue(tokenResponse());
  });

  it("prefers interimAvailable and converts the decimal string exactly", async () => {
    mockedGet.mockResolvedValueOnce(
      balancesResponse([
        { amount: "1234.56", balanceType: "expected", referenceDate: "2026-06-10" },
        {
          amount: "1230.00",
          balanceType: "interimAvailable",
          referenceDate: "2026-06-11",
        },
      ])
    );

    const balance = await gocardlessConnector.fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("123000");
    expect(balance.currency).toBe("GBP");
    expect(balance.decimals).toBe(2);
    expect(balance.asOf).toEqual(new Date("2026-06-11"));
  });

  it("falls back to expected when interimAvailable is absent", async () => {
    mockedGet.mockResolvedValueOnce(
      balancesResponse([
        { amount: "9.99", balanceType: "closingBooked" },
        { amount: "1234.56", balanceType: "expected" },
      ])
    );

    const balance = await gocardlessConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("123456");
  });

  it("falls back to the first balance when neither preferred type exists", async () => {
    mockedGet.mockResolvedValueOnce(
      balancesResponse([
        { amount: "-42.01", balanceType: "closingBooked", currency: "EUR" },
      ])
    );

    const balance = await gocardlessConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("-4201");
    expect(balance.currency).toBe("EUR");
  });

  it("throws InternalServerException when the bank returns no balances", async () => {
    mockedGet.mockResolvedValueOnce({ data: { balances: [] } });

    await expect(gocardlessConnector.fetchBalance(ctx)).rejects.toThrow(
      InternalServerException
    );
  });
});

describe("fetchTransactions", () => {
  const since = new Date("2026-06-01T15:30:00Z");

  const transactionsFixture = {
    data: {
      transactions: {
        booked: [
          {
            transactionId: "bank-tx-1",
            internalTransactionId: "gc-int-1",
            bookingDate: "2026-06-01",
            transactionAmount: { amount: "-25.50", currency: "GBP" },
            remittanceInformationUnstructured: "TESCO STORES 2238",
            creditorName: "Tesco",
          },
          {
            transactionId: "bank-tx-2",
            bookingDate: "2026-06-02",
            transactionAmount: { amount: "5", currency: "GBP" },
            creditorName: "Acme Refunds",
          },
          {
            // No internalTransactionId AND no transactionId: no stable
            // externalId is possible, so this row must be skipped.
            bookingDate: "2026-06-03",
            transactionAmount: { amount: "9.99", currency: "GBP" },
            remittanceInformationUnstructured: "UNIDENTIFIABLE ROW",
          },
          {
            internalTransactionId: "gc-int-4",
            bookingDate: "2026-06-04",
            transactionAmount: { amount: "-0.01", currency: "GBP" },
            debtorName: "Alex",
          },
          {
            internalTransactionId: "gc-int-5",
            bookingDate: "2026-06-05",
            transactionAmount: { amount: "1.00", currency: "GBP" },
          },
        ],
        pending: [
          {
            // Pending rows have no stable id and must never be returned.
            valueDate: "2026-06-06",
            transactionAmount: { amount: "-100.00", currency: "GBP" },
            remittanceInformationUnstructured: "PENDING CARD AUTH",
          },
        ],
      },
    },
  };

  beforeEach(() => {
    mockedPost.mockResolvedValue(tokenResponse());
  });

  it("requests with date_from formatted as YYYY-MM-DD", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    await gocardlessConnector.fetchTransactions(ctx, since);

    expect(mockedGet).toHaveBeenCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/accounts/acct-uuid-1/transactions/?date_from=2026-06-01",
      expect.anything()
    );
  });

  it("returns booked rows only — pending is excluded", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs).toHaveLength(4); // 5 booked - 1 id-less, 0 from pending
    expect(txs.map((t) => t.title)).not.toContain("PENDING CARD AUTH");
  });

  it("skips booked rows with neither internalTransactionId nor transactionId", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs.map((t) => t.title)).not.toContain("UNIDENTIFIABLE ROW");
  });

  it("prefers internalTransactionId and falls back to transactionId", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs[0].externalId).toBe("gc-int-1"); // both present → internal wins
    expect(txs[1].externalId).toBe("bank-tx-2"); // internal absent → bank id
  });

  it("converts signed decimal amounts to minor-unit strings", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs[0].amountMinor).toBe("-2550");
    expect(txs[1].amountMinor).toBe("500");
    expect(txs[2].amountMinor).toBe("-1");
  });

  it("walks the title fallback chain: remittance → creditor → debtor → default", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs[0].title).toBe("TESCO STORES 2238"); // remittance beats creditor
    expect(txs[1].title).toBe("Acme Refunds"); // creditorName
    expect(txs[2].title).toBe("Alex"); // debtorName
    expect(txs[3].title).toBe("Bank transaction"); // nothing → default
  });

  it("maps bookingDate and keeps the raw provider row", async () => {
    mockedGet.mockResolvedValueOnce(transactionsFixture);

    const txs = await gocardlessConnector.fetchTransactions(ctx, since);

    expect(txs[0].date).toEqual(new Date("2026-06-01"));
    expect(txs[0].currency).toBe("GBP");
    expect(txs[0].raw).toEqual(
      transactionsFixture.data.transactions.booked[0]
    );
  });

  it("handles an empty booked list", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { transactions: { booked: [], pending: [] } },
    });

    await expect(
      gocardlessConnector.fetchTransactions(ctx, since)
    ).resolves.toEqual([]);
  });
});

describe("rate limiting (429)", () => {
  beforeEach(() => {
    mockedPost.mockResolvedValue(tokenResponse());
  });

  it("throws a 429 HttpException saying the account is rate limited until tomorrow", async () => {
    mockedGet.mockRejectedValueOnce({ response: { status: 429 } });

    try {
      await gocardlessConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).statusCode).toBe(
        HTTPSTATUS.TOO_MANY_REQUESTS
      );
      expect((e as Error).message).toMatch(/rate limited until tomorrow/i);
    }
  });

  it("never retries after a 429 — the quota is per-account-per-day", async () => {
    mockedGet.mockRejectedValue({ response: { status: 429 } });

    await expect(gocardlessConnector.fetchBalance(ctx)).rejects.toThrow(
      AppError
    );
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("wraps non-429 HTTP failures without leaking the bearer token", async () => {
    // A real axios error drags the request config (incl. the Authorization
    // header) along with it; the connector must strip all of that.
    mockedGet.mockRejectedValueOnce({
      response: { status: 500 },
      config: { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } },
    });

    try {
      await gocardlessConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).not.toContain(FAKE_TOKEN);
      expect((e as Error).message).toContain("500");
    }
  });
});

describe("onboarding client", () => {
  beforeEach(() => {
    mockedPost.mockResolvedValue(tokenResponse());
  });

  it("listInstitutions queries by country and returns the institutions", async () => {
    const institutions = [
      {
        id: "MONZO_MONZGB2L",
        name: "Monzo",
        bic: "MONZGB2L",
        transaction_total_days: "730",
        countries: ["GB"],
      },
    ];
    mockedGet.mockResolvedValueOnce({ data: institutions });

    const result = await listInstitutions("GB");

    expect(mockedGet).toHaveBeenCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/institutions/?country=GB",
      expect.anything()
    );
    expect(result).toEqual(institutions);
  });

  it("createRequisition POSTs redirect + institution_id and returns { id, link }", async () => {
    mockedPost
      .mockResolvedValueOnce(tokenResponse()) // token
      .mockResolvedValueOnce({
        data: {
          id: "req-1",
          link: "https://ob.gocardless.com/psd2/start/req-1/MONZO_MONZGB2L",
          status: "CR",
          accounts: [],
        },
      });

    const result = await createRequisition(
      "MONZO_MONZGB2L",
      "https://cashloom.local/linked"
    );

    expect(mockedPost).toHaveBeenLastCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/requisitions/",
      {
        redirect: "https://cashloom.local/linked",
        institution_id: "MONZO_MONZGB2L",
      },
      { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }
    );
    expect(result).toEqual({
      id: "req-1",
      link: "https://ob.gocardless.com/psd2/start/req-1/MONZO_MONZGB2L",
    });
  });

  it("getRequisition returns id, status, and linked account ids", async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        id: "req-1",
        status: "LN",
        accounts: ["acct-uuid-1", "acct-uuid-2"],
        redirect: "https://cashloom.local/linked",
      },
    });

    const result = await getRequisition("req-1");

    expect(mockedGet).toHaveBeenCalledWith(
      "https://bankaccountdata.gocardless.com/api/v2/requisitions/req-1/",
      expect.anything()
    );
    expect(result).toEqual({
      id: "req-1",
      status: "LN",
      accounts: ["acct-uuid-1", "acct-uuid-2"],
    });
  });
});
