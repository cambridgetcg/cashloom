import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import axios, { AxiosResponse } from "axios";
import { agenttoolConnector } from "./agenttool.connector";
import { ConnectorContext } from "./types";
import { InternalServerException } from "../utils/app-error";

// All HTTP is mocked at the axios boundary — these tests never touch the
// network. The key is an obviously-fake placeholder. resolveCredentialRef is
// the REAL implementation (the AGENTTOOL_* namespace was widened in
// credentials.ts by this same work item — these tests are its regression
// pin), driven via vi.stubEnv — no credential mocking.
vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);

const FAKE_KEY = "FAKE-agenttool-key-not-real";
const REF = "AGENTTOOL_API_KEY";

const WALLET_ID = "588f0589-ea00-4489-a6ba-0713f6988086";
const ctx: ConnectorContext = { credentialRef: REF, externalAccountId: WALLET_ID };

const since = new Date("2026-07-01T00:00:00Z");

// Minimal-but-valid AxiosResponse so the mock satisfies the real signature.
const httpResponse = (
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

// agenttool envelopes: { success: true, data } plus decorative fields the
// connector must ignore (_welcomed rides on every production response).
const walletResponse = (overrides: Record<string, unknown> = {}): AxiosResponse =>
  httpResponse(200, {
    success: true,
    data: { id: WALLET_ID, currency: "GBP", balance: 500, ...overrides },
    _welcomed: { walls_intact: true },
  });

type LedgerFixture = Record<string, unknown>;

const ledgerRow = (overrides: LedgerFixture = {}): LedgerFixture => ({
  id: "a72d4737-940d-46a6-984a-53aff5d9997f",
  walletId: WALLET_ID,
  type: "fund",
  amount: 500,
  counterparty: null,
  description: "Ring-2 birth credit (free at birth)",
  escrowId: null,
  metadata: {},
  createdAt: "2026-07-04T20:32:03.944Z",
  ...overrides,
});

const txPage = (rows: LedgerFixture[]): AxiosResponse =>
  httpResponse(200, { success: true, data: rows, meta: {} });

beforeEach(() => {
  vi.stubEnv("AGENTTOOL_API_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("agenttool connector — credential discipline", () => {
  it('has type "agenttool"', () => {
    expect(agenttoolConnector.type).toBe("agenttool");
  });

  it("refuses a non-AGENTTOOL_* credentialRef before any HTTP, in both methods", async () => {
    const bad: ConnectorContext = {
      credentialRef: "STRIPE_RESTRICTED_KEY",
      externalAccountId: WALLET_ID,
    };
    await expect(agenttoolConnector.fetchBalance(bad)).rejects.toBeInstanceOf(
      InternalServerException
    );
    await expect(
      agenttoolConnector.fetchTransactions(bad, since)
    ).rejects.toBeInstanceOf(InternalServerException);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("sends the key as an Authorization header, never in the URL", async () => {
    mockedGet.mockResolvedValueOnce(walletResponse());
    await agenttoolConnector.fetchBalance(ctx);
    const [url, config] = mockedGet.mock.calls[0];
    expect(String(url)).not.toContain(FAKE_KEY);
    expect(String(url)).toBe(`https://api.agenttool.dev/v1/wallets/${WALLET_ID}`);
    expect(config?.headers?.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // The invariants a mocked suite can silently lose: the timeout and the
    // pass-every-status validateStatus that keeps keyed configs out of axios
    // throws.
    expect(config?.timeout).toBe(10_000);
    expect(config?.validateStatus?.(500)).toBe(true);
  });

  it("honors AGENTTOOL_BASE_URL as a base override (trailing slash trimmed)", async () => {
    vi.stubEnv("AGENTTOOL_BASE_URL", "https://staging.agenttool.dev/");
    mockedGet.mockResolvedValueOnce(walletResponse());
    await agenttoolConnector.fetchBalance(ctx);
    expect(String(mockedGet.mock.calls[0][0])).toBe(
      `https://staging.agenttool.dev/v1/wallets/${WALLET_ID}`
    );
  });

  it("names the env VARIABLE on 401 and never leaks the key value", async () => {
    mockedGet.mockResolvedValueOnce(httpResponse(401, { error: "unauthorized" }));
    let caught: unknown;
    try {
      await agenttoolConnector.fetchBalance(ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InternalServerException);
    const dumped = inspect(caught, { depth: 20 });
    expect(dumped).toContain(REF);
    expect(dumped).not.toContain(FAKE_KEY);
  });

  it("re-wraps a below-HTTP failure without the axios config (no key leak)", async () => {
    const netError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      config: { url: "should-never-surface", headers: { Authorization: `Bearer ${FAKE_KEY}` } },
    });
    mockedGet.mockRejectedValueOnce(netError);
    let caught: unknown;
    try {
      await agenttoolConnector.fetchBalance(ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InternalServerException);
    const dumped = inspect(caught, { depth: 20 });
    expect(dumped).toContain("ECONNRESET");
    expect(dumped).not.toContain(FAKE_KEY);
    expect(dumped).not.toContain("should-never-surface");
  });
});

describe("agenttool connector — fetchBalance", () => {
  it("maps balance to a minor string with per-wallet currency and fixed decimals", async () => {
    mockedGet.mockResolvedValueOnce(walletResponse({ currency: " gbp ", balance: 500 }));
    const balance = await agenttoolConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("500");
    expect(balance.currency).toBe("GBP");
    expect(balance.decimals).toBe(2);
    expect(balance.asOf).toBeInstanceOf(Date);
  });

  it("refuses a non-integer balance rather than rounding money", async () => {
    mockedGet.mockResolvedValueOnce(walletResponse({ balance: 500.25 }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(
      /non-integer amount/
    );
  });

  it("refuses a string balance (misread payload, not money)", async () => {
    mockedGet.mockResolvedValueOnce(walletResponse({ balance: "500" }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(
      /non-integer amount/
    );
  });

  it("refuses a wallet with no currency rather than guessing", async () => {
    mockedGet.mockResolvedValueOnce(walletResponse({ currency: "" }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(
      /no currency/
    );
  });

  it("refuses a currency whose minor-unit scale it does not know (no 10-100x mis-scaling)", async () => {
    // A 0-decimal currency reported with the pinned 2-decimal scale would be
    // misread 100x — and self-consistently, so sync's decimals-mismatch guard
    // could never fire. Refusal is the only safe answer.
    mockedGet.mockResolvedValueOnce(walletResponse({ currency: "JPY" }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(
      /minor-unit scale/
    );
  });

  it("rejects an unexpected envelope shape", async () => {
    mockedGet.mockResolvedValueOnce(httpResponse(200, { success: false, data: null }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(
      /unexpected response shape/
    );
  });

  it("retries once on 429 honoring Retry-After, then succeeds", async () => {
    mockedGet
      .mockResolvedValueOnce(httpResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(walletResponse());
    const balance = await agenttoolConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("500");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("fails when 429 persists past one backoff", async () => {
    mockedGet
      .mockResolvedValueOnce(httpResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(httpResponse(429, {}, { "retry-after": "0" }));
    await expect(agenttoolConnector.fetchBalance(ctx)).rejects.toThrow(/rate limit/);
  });
});

describe("agenttool connector — fetchTransactions", () => {
  it("copies signed ledger amounts digit-for-digit and stamps the wallet currency", async () => {
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(
        txPage([
          ledgerRow(),
          ledgerRow({
            id: "b0000000-0000-0000-0000-000000000001",
            type: "spend",
            amount: -120,
            counterparty: "did:at:mindicraft",
            description: "living index invocation",
            createdAt: "2026-07-04T21:00:00.000Z",
          }),
        ])
      );

    const txs = await agenttoolConnector.fetchTransactions(ctx, since);

    expect(txs).toHaveLength(2);
    const fund = txs.find((t) => t.externalId === "a72d4737-940d-46a6-984a-53aff5d9997f");
    const spend = txs.find((t) => t.externalId === "b0000000-0000-0000-0000-000000000001");
    expect(fund?.amountMinor).toBe("500");
    expect(fund?.title).toBe("fund · Ring-2 birth credit (free at birth)");
    expect(spend?.amountMinor).toBe("-120");
    // counterparty outranks description in the title.
    expect(spend?.title).toBe("spend · did:at:mindicraft");
    for (const tx of txs) {
      expect(tx.currency).toBe("GBP");
      expect(tx.date).toBeInstanceOf(Date);
      expect(tx.raw).toBeDefined();
    }
    // Wallet read + one short page — no extra paging on a short page.
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("drops rows with no stable id rather than inventing one", async () => {
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(txPage([ledgerRow({ id: "" }), ledgerRow({ id: undefined })]));
    const txs = await agenttoolConnector.fetchTransactions(ctx, since);
    expect(txs).toHaveLength(0);
  });

  it("refuses a non-integer row amount", async () => {
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(txPage([ledgerRow({ amount: 1.5 })]));
    await expect(agenttoolConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /non-integer amount/
    );
  });

  it("refuses an unparseable createdAt (windowing would fly blind)", async () => {
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(txPage([ledgerRow({ createdAt: "not-a-date" })]));
    await expect(agenttoolConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /parseable createdAt/
    );
  });

  it("pages newest-first and stops once a page crosses the since-window", async () => {
    // Page 0: exactly PAGE_LIMIT (200) in-window rows → keep paging.
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      ledgerRow({
        id: `c0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        createdAt: "2026-07-04T12:00:00.000Z",
      })
    );
    // Page 1: one in-window row, then one older than `since` → stop, no page 2.
    const straddlingPage = [
      ledgerRow({
        id: "d0000000-0000-0000-0000-000000000001",
        createdAt: "2026-07-02T00:00:00.000Z",
      }),
      ledgerRow({
        id: "d0000000-0000-0000-0000-000000000002",
        createdAt: "2026-06-01T00:00:00.000Z",
      }),
    ];
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(txPage(fullPage))
      .mockResolvedValueOnce(txPage(straddlingPage));

    const txs = await agenttoolConnector.fetchTransactions(ctx, since);

    expect(txs).toHaveLength(201);
    expect(txs.some((t) => t.externalId.startsWith("d0000000") && t.externalId.endsWith("2"))).toBe(false);
    // Wallet + page 0 + page 1; the window boundary stopped page 2.
    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(String(mockedGet.mock.calls[1][0])).toContain("limit=200&offset=0");
    expect(String(mockedGet.mock.calls[2][0])).toContain("limit=200&offset=200");
  });

  it("throws loudly when the page ceiling is hit before the window start (no silent truncation)", async () => {
    // Every page full and in-window: the walk can never reach the window
    // boundary, so it must refuse the whole window rather than return the
    // newest N rows — the sync watermark would advance past the dropped
    // old-side rows forever.
    const endlessPage = Array.from({ length: 200 }, (_, i) =>
      ledgerRow({
        id: `e0000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        createdAt: "2026-07-04T12:00:00.000Z",
      })
    );
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValue(txPage(endlessPage));
    await expect(agenttoolConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /page ceiling before reaching the sync window start/
    );
  });

  it("rejects an unexpected transactions envelope shape", async () => {
    mockedGet
      .mockResolvedValueOnce(walletResponse())
      .mockResolvedValueOnce(httpResponse(200, { success: true, data: "nope" }));
    await expect(agenttoolConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /unexpected response shape/
    );
  });
});
