import { describe, it, expect, vi, afterEach } from "vitest";
import { inspect } from "node:util";
import axios, { AxiosResponse } from "axios";
import { esploraConnector } from "./esplora.connector";
import { ConnectorContext } from "./types";
import { InternalServerException } from "../utils/app-error";

// All HTTP is mocked at the axios boundary — these tests never touch the
// network. Fixtures mirror real Esplora payload shapes (blockstream.info /
// mempool.space); addresses and txids are obviously-fake placeholders.
vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);

const BASE = "https://blockstream.info/api";
const ADDR = "bc1qfakewatchaddress0000000000000000000000";

const ctx: ConnectorContext = {
  credentialRef: null,
  externalAccountId: ADDR,
};

// Minimal-but-valid AxiosResponse so the mock satisfies the real signature.
const esploraResponse = (
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

/* -------------------------------- fixtures -------------------------------- */

const TIP_HEIGHT = 900000;

const since = new Date("2026-06-01T00:00:00Z");
const sinceUnix = Math.floor(since.getTime() / 1000);

// Block times inside the sync window (after `since`).
const T_RECENT = sinceUnix + 5 * 86400;
const T_OLDER = sinceUnix + 2 * 86400;
// Strictly before the window — triggers the page-level stop.
const T_BEFORE = sinceUnix - 86400;

// Heights chosen against TIP_HEIGHT: confirmations = tip - height + 1.
const HEIGHT_DEEP = TIP_HEIGHT - 100; // 101 confirmations
const HEIGHT_6_CONF = TIP_HEIGHT - 5; // exactly 6 — included
const HEIGHT_5_CONF = TIP_HEIGHT - 4; // exactly 5 — excluded

const OTHER_ADDR = "bc1qsomeoneelse00000000000000000000000000";

const TXID_RECEIVE =
  "aaaa000000000000000000000000000000000000000000000000000000000001";
const TXID_SEND =
  "bbbb000000000000000000000000000000000000000000000000000000000002";
const TXID_SELF =
  "cccc000000000000000000000000000000000000000000000000000000000003";
const TXID_SHALLOW =
  "dddd000000000000000000000000000000000000000000000000000000000004";
const TXID_UNCONFIRMED =
  "eeee000000000000000000000000000000000000000000000000000000000005";

const confirmedStatus = (height: number, time: number) => ({
  confirmed: true,
  block_height: height,
  block_hash: "00000000fakefakefakefakefakefakefakefakefakefakefakefakefake00",
  block_time: time,
});

// Incoming payment: 70000 sats to ADDR, 30000 change back to the (foreign)
// sender; one input is coinbase-style (prevout null) to prove null handling.
// Net for ADDR = +70000.
const receiveTx = {
  txid: TXID_RECEIVE,
  version: 2,
  locktime: 0,
  vin: [
    {
      txid: "ffff00000000000000000000000000000000000000000000000000000000000a",
      vout: 0,
      prevout: { scriptpubkey_address: OTHER_ADDR, value: 101000 },
      is_coinbase: false,
    },
    { prevout: null, is_coinbase: true },
  ],
  vout: [
    { scriptpubkey_address: ADDR, value: 70000 },
    { scriptpubkey_address: OTHER_ADDR, value: 30000 },
  ],
  size: 222,
  fee: 1000,
  status: confirmedStatus(HEIGHT_DEEP, T_RECENT),
};

// Outgoing spend with multi-vin + change back to self: ADDR funds two inputs
// (50000 + 30000 = 80000), a foreign input contributes 999 (ignored); outputs
// pay 60000 to OTHER_ADDR and 19000 change back to ADDR; 1999 fee.
// Net for ADDR = 19000 - 80000 = -61000.
const sendTx = {
  txid: TXID_SEND,
  version: 2,
  locktime: 0,
  vin: [
    {
      prevout: { scriptpubkey_address: ADDR, value: 50000 },
      is_coinbase: false,
    },
    {
      prevout: { scriptpubkey_address: ADDR, value: 30000 },
      is_coinbase: false,
    },
    {
      prevout: { scriptpubkey_address: OTHER_ADDR, value: 999 },
      is_coinbase: false,
    },
  ],
  vout: [
    { scriptpubkey_address: OTHER_ADDR, value: 60000 },
    { scriptpubkey_address: ADDR, value: 19000 },
  ],
  size: 333,
  fee: 1999,
  status: confirmedStatus(HEIGHT_DEEP, T_OLDER),
};

// Pure self-spend: 5000 in from ADDR, 5000 back to ADDR — nets to zero and
// must be skipped (no value moved for this address).
const selfSpendTx = {
  txid: TXID_SELF,
  vin: [
    {
      prevout: { scriptpubkey_address: ADDR, value: 5000 },
      is_coinbase: false,
    },
    {
      prevout: { scriptpubkey_address: OTHER_ADDR, value: 1000 },
      is_coinbase: false,
    },
  ],
  vout: [
    { scriptpubkey_address: ADDR, value: 5000 },
    { scriptpubkey_address: OTHER_ADDR, value: 500 },
  ],
  status: confirmedStatus(HEIGHT_DEEP, T_RECENT),
};

// Confirmed but only 5 blocks deep — below MIN_CONFIRMATIONS, excluded.
const shallowTx = {
  txid: TXID_SHALLOW,
  vin: [],
  vout: [{ scriptpubkey_address: ADDR, value: 12345 }],
  status: confirmedStatus(HEIGHT_5_CONF, T_RECENT),
};

// Exactly 6 confirmations — the boundary case that must be INCLUDED.
const sixConfTx = {
  txid: TXID_SHALLOW.replace("dddd", "d6d6"),
  vin: [],
  vout: [{ scriptpubkey_address: ADDR, value: 22222 }],
  status: confirmedStatus(HEIGHT_6_CONF, T_RECENT),
};

// Unconfirmed (shouldn't appear on /txs/chain, but trust the status field).
const unconfirmedTx = {
  txid: TXID_UNCONFIRMED,
  vin: [],
  vout: [{ scriptpubkey_address: ADDR, value: 99999 }],
  status: { confirmed: false },
};

// Tip-height response, then one transactions page.
const mockTipThenPages = (...pages: unknown[]) => {
  mockedGet.mockResolvedValueOnce(esploraResponse(200, TIP_HEIGHT));
  for (const page of pages) {
    mockedGet.mockResolvedValueOnce(esploraResponse(200, page));
  }
};

/* --------------------------------------------------------------------------- */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("esploraConnector", () => {
  it('has type "esplora"', () => {
    expect(esploraConnector.type).toBe("esplora");
  });
});

describe("keyless guard (credentialRef must be absent)", () => {
  // Esplora needs no credential: a stored STRIPE_*/ALCHEMY_* pointer reaching
  // this connector means the Account is wired to the wrong rail. Refusal must
  // happen BEFORE any env read or HTTP call — nothing leaves the box.
  it.each(["STRIPE_RESTRICTED_KEY", "ALCHEMY_API_KEY", "GOCARDLESS_SECRET_KEY"])(
    "fetchBalance refuses credentialRef %s with zero HTTP calls",
    async (ref) => {
      try {
        await esploraConnector.fetchBalance({ ...ctx, credentialRef: ref });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InternalServerException);
        expect((e as Error).message).toBe(
          `esplora is a keyless public-indexer connector; refusing unexpected credentialRef "${ref}"`
        );
      }
      expect(mockedGet).not.toHaveBeenCalled();
    }
  );

  it.each(["STRIPE_RESTRICTED_KEY", "ALCHEMY_API_KEY"])(
    "fetchTransactions refuses credentialRef %s with zero HTTP calls",
    async (ref) => {
      await expect(
        esploraConnector.fetchTransactions({ ...ctx, credentialRef: ref }, since)
      ).rejects.toThrow(ref);
      expect(mockedGet).not.toHaveBeenCalled();
    }
  );

  it("treats an absent credentialRef (undefined) the same as null — allowed", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 0 },
      })
    );

    const balance = await esploraConnector.fetchBalance({
      externalAccountId: ADDR,
    });
    expect(balance.balanceMinor).toBe("1000");
  });
});

describe("fetchBalance", () => {
  it("reports funded - spent from chain_stats as an exact BigInt string", async () => {
    // Values near max supply (2.1e15 sats) — exact in BigInt, no float path.
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: {
          funded_txo_count: 4,
          funded_txo_sum: 2100000000000000,
          spent_txo_count: 1,
          spent_txo_sum: 99999999999999,
          tx_count: 5,
        },
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0,
        },
      })
    );

    const balance = await esploraConnector.fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("2000000000000001"); // hand-computed
    expect(balance.currency).toBe("BTC");
    expect(balance.decimals).toBe(8);
    expect(balance.asOf).toBeInstanceOf(Date);
  });

  it("excludes mempool_stats entirely — unconfirmed funds never count", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 50000, spent_txo_sum: 20000 },
        // A huge pending inflow and outflow: both must be invisible.
        mempool_stats: { funded_txo_sum: 777777777, spent_txo_sum: 30000 },
      })
    );

    const balance = await esploraConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("30000"); // 50000 - 20000, chain only
  });

  it("calls GET /address/{addr} on the default base URL with the 10s timeout", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 1, spent_txo_sum: 0 },
      })
    );

    await esploraConnector.fetchBalance(ctx);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockedGet.mock.calls[0];
    expect(url).toBe(`${BASE}/address/${ADDR}`);
    expect(config?.timeout).toBe(10_000);
    expect(typeof config?.validateStatus).toBe("function");
  });

  it("uses ESPLORA_BASE_URL (trimmed) when set", async () => {
    vi.stubEnv("ESPLORA_BASE_URL", "  https://mempool.space/api  ");
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 1, spent_txo_sum: 0 },
      })
    );

    await esploraConnector.fetchBalance(ctx);

    const [url] = mockedGet.mock.calls[0];
    expect(url).toBe(`https://mempool.space/api/address/${ADDR}`);
  });

  it("falls back to the default base URL when ESPLORA_BASE_URL is blank", async () => {
    vi.stubEnv("ESPLORA_BASE_URL", "   ");
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 1, spent_txo_sum: 0 },
      })
    );

    await esploraConnector.fetchBalance(ctx);

    const [url] = mockedGet.mock.calls[0];
    expect(url).toBe(`${BASE}/address/${ADDR}`);
  });

  it("throws on a negative confirmed balance (indexer inconsistency)", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 100, spent_txo_sum: 200 },
      })
    );

    await expect(esploraConnector.fetchBalance(ctx)).rejects.toThrow(
      /indexer inconsistency/
    );
  });

  it("throws the shape error when chain_stats is missing, without echoing the payload", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, { unexpected: "SHOULD_NEVER_APPEAR_IN_ERRORS" })
    );

    try {
      await esploraConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("unexpected Esplora response shape");
      expect(message).toContain("/address/:addr");
      expect(message).not.toContain("SHOULD_NEVER_APPEAR_IN_ERRORS");
    }
  });

  it("guards every sat field with Number.isSafeInteger: 2^53 throws instead of rounding", async () => {
    const unsafe = 2 ** 53; // 9007199254740992 — not a safe integer
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: unsafe, spent_txo_sum: 0 },
      })
    );

    try {
      await esploraConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("unexpected Esplora response shape");
      expect(message).toContain("funded_txo_sum");
      expect(message).not.toContain(String(unsafe)); // no payload echo
    }
  });
});

describe("watch-address canonicalization (BIP-173 case rules)", () => {
  // BIP-173 allows bech32 as all-lowercase OR ALL-UPPERCASE (the QR form) —
  // but Esplora reports scriptpubkey_address in canonical lowercase only, and
  // netSatsFor compares with strict ===. Without folding, an uppercase paste
  // would sync a correct balance while every transaction netted to zero and
  // was silently skipped: balance fine, history permanently empty.
  it("folds a uniform-UPPERCASE bech32 address to lowercase for the URL and the netting compare", async () => {
    const upperCtx: ConnectorContext = {
      credentialRef: null,
      externalAccountId: ADDR.toUpperCase(), // what a QR scan pastes
    };

    mockTipThenPages([receiveTx, sendTx, selfSpendTx], []);

    const txns = await esploraConnector.fetchTransactions(upperCtx, since);

    // Identical result to the lowercase-address run: netting matched the
    // canonical lowercase addresses Esplora actually returns.
    expect(txns.map((t) => [t.externalId, t.amountMinor])).toEqual([
      [TXID_RECEIVE, "70000"],
      [TXID_SEND, "-61000"],
    ]);

    // Every request used the canonical lowercase address.
    const [page1Url] = mockedGet.mock.calls[1];
    expect(page1Url).toBe(`${BASE}/address/${ADDR}/txs/chain`);
  });

  it("folds the uppercase form for fetchBalance's URL too", async () => {
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 0 },
      })
    );

    const balance = await esploraConnector.fetchBalance({
      credentialRef: null,
      externalAccountId: ADDR.toUpperCase(),
    });

    expect(balance.balanceMinor).toBe("1000");
    const [url] = mockedGet.mock.calls[0];
    expect(url).toBe(`${BASE}/address/${ADDR}`);
  });

  it("refuses MIXED-case bech32 loudly, before any HTTP — BIP-173 forbids it", async () => {
    const mixed = "bc1Qfakewatchaddress0000000000000000000000";

    for (const call of [
      () =>
        esploraConnector.fetchBalance({
          credentialRef: null,
          externalAccountId: mixed,
        }),
      () =>
        esploraConnector.fetchTransactions(
          { credentialRef: null, externalAccountId: mixed },
          since
        ),
    ]) {
      try {
        await call();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InternalServerException);
        const message = (e as Error).message;
        expect(message).toContain("mixed-case bech32");
        expect(message).not.toContain(mixed); // address never echoed
      }
    }
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("passes legacy Base58 addresses through VERBATIM — they are case-sensitive", async () => {
    const legacy = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"; // mixed case is meaningful
    mockedGet.mockResolvedValueOnce(
      esploraResponse(200, {
        chain_stats: { funded_txo_sum: 42, spent_txo_sum: 0 },
      })
    );

    await esploraConnector.fetchBalance({
      credentialRef: null,
      externalAccountId: legacy,
    });

    const [url] = mockedGet.mock.calls[0];
    expect(url).toBe(`${BASE}/address/${legacy}`); // not lowercased
  });
});

describe("fetchTransactions", () => {
  it("nets multi-vin/vout per address, signs both directions, skips net-zero self-spends", async () => {
    mockTipThenPages([receiveTx, sendTx, selfSpendTx], []);

    const txns = await esploraConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(2);

    // Incoming: +70000 (the 30000 change output belongs to the sender).
    expect(txns[0]).toMatchObject({
      externalId: TXID_RECEIVE,
      title: `BTC received · ${TXID_RECEIVE.slice(0, 12)}`,
      amountMinor: "70000",
      currency: "BTC",
    });
    expect(txns[0].date).toEqual(new Date(T_RECENT * 1000));
    expect(txns[0].raw).toEqual(receiveTx);

    // Outgoing with change back to self: 19000 - (50000 + 30000) = -61000;
    // the foreign 999-sat input is someone else's money and is ignored.
    expect(txns[1]).toMatchObject({
      externalId: TXID_SEND,
      title: `BTC sent · ${TXID_SEND.slice(0, 12)}`,
      amountMinor: "-61000",
      currency: "BTC",
    });
    expect(txns[1].date).toEqual(new Date(T_OLDER * 1000));

    // The self-spend nets to zero and emitted no row.
    expect(txns.map((t) => t.externalId)).not.toContain(TXID_SELF);
  });

  it("applies the confirmation cutoff at exactly 6: 6-conf in, 5-conf out, unconfirmed out", async () => {
    mockTipThenPages([sixConfTx, shallowTx, unconfirmedTx], []);

    const txns = await esploraConnector.fetchTransactions(ctx, since);

    expect(txns.map((t) => t.externalId)).toEqual([sixConfTx.txid]);
    expect(txns[0].amountMinor).toBe("22222");
  });

  it("fetches the tip height once, then pages /txs/chain threading last_seen_txid", async () => {
    const page1 = [receiveTx, sendTx]; // last txid = TXID_SEND
    const page2 = [selfSpendTx]; // last txid = TXID_SELF (skipped row still threads)
    mockTipThenPages(page1, page2, []);

    const txns = await esploraConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(2);
    expect(mockedGet).toHaveBeenCalledTimes(4);

    const [tipUrl, tipConfig] = mockedGet.mock.calls[0];
    expect(tipUrl).toBe(`${BASE}/blocks/tip/height`);
    expect(tipConfig?.timeout).toBe(10_000);

    const [page1Url] = mockedGet.mock.calls[1];
    expect(page1Url).toBe(`${BASE}/address/${ADDR}/txs/chain`);

    const [page2Url] = mockedGet.mock.calls[2];
    expect(page2Url).toBe(`${BASE}/address/${ADDR}/txs/chain/${TXID_SEND}`);

    const [page3Url] = mockedGet.mock.calls[3];
    expect(page3Url).toBe(`${BASE}/address/${ADDR}/txs/chain/${TXID_SELF}`);
  });

  it("accepts a plain-text (string) tip height — Esplora serves it as text/plain", async () => {
    mockedGet.mockResolvedValueOnce(esploraResponse(200, `${TIP_HEIGHT}\n`));
    mockedGet.mockResolvedValueOnce(esploraResponse(200, [sixConfTx]));
    mockedGet.mockResolvedValueOnce(esploraResponse(200, []));

    const txns = await esploraConnector.fetchTransactions(ctx, since);
    expect(txns).toHaveLength(1); // 6-conf math worked off the parsed tip
  });

  it("stops paging when a page reaches back past `since` and drops the out-of-window rows", async () => {
    const oldTx = {
      ...sendTx,
      txid: TXID_SEND.replace("bbbb", "01d0"),
      status: confirmedStatus(HEIGHT_DEEP, T_BEFORE),
    };
    // Page contains one in-window row and one pre-window row (newest-first):
    // the old row both stops pagination and is excluded from the result.
    mockTipThenPages([receiveTx, oldTx]);

    const txns = await esploraConnector.fetchTransactions(ctx, since);

    expect(txns.map((t) => t.externalId)).toEqual([TXID_RECEIVE]);
    expect(mockedGet).toHaveBeenCalledTimes(2); // tip + ONE page, no follow-up
  });

  it("stops at the MAX_PAGES ceiling (400) and returns what it collected", async () => {
    let pageCount = 0;
    mockedGet.mockImplementation(async (url) => {
      if (String(url).endsWith("/blocks/tip/height")) {
        return esploraResponse(200, TIP_HEIGHT);
      }
      pageCount += 1;
      // Every page returns one fresh in-window tx — without the ceiling this
      // would paginate forever.
      return esploraResponse(200, [
        {
          ...receiveTx,
          txid: `${String(pageCount).padStart(8, "0")}${TXID_RECEIVE.slice(8)}`,
        },
      ]);
    });

    const txns = await esploraConnector.fetchTransactions(ctx, since);

    expect(pageCount).toBe(400);
    expect(mockedGet).toHaveBeenCalledTimes(401); // 1 tip + 400 pages
    expect(txns).toHaveLength(400);
  });

  it("returns an empty list when the first page is empty", async () => {
    mockTipThenPages([]);

    const txns = await esploraConnector.fetchTransactions(ctx, since);
    expect(txns).toEqual([]);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("throws the safe-integer shape error on an anomalous vout value (2^53)", async () => {
    const corruptTx = {
      ...sixConfTx,
      vout: [{ scriptpubkey_address: ADDR, value: 2 ** 53 }],
    };
    mockTipThenPages([corruptTx]);

    await expect(esploraConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /unexpected Esplora response shape/
    );
  });
});

describe("rate limiting (429)", () => {
  it("retries once after Retry-After, then succeeds", async () => {
    mockedGet
      .mockResolvedValueOnce(esploraResponse(429, "", { "retry-after": "0" }))
      .mockResolvedValueOnce(
        esploraResponse(200, {
          chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000 },
        })
      );

    const balance = await esploraConnector.fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("4000");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("fails loud after a second consecutive 429", async () => {
    mockedGet
      .mockResolvedValueOnce(esploraResponse(429, "", { "retry-after": "0" }))
      .mockResolvedValueOnce(esploraResponse(429, "", { "retry-after": "0" }));

    await expect(esploraConnector.fetchBalance(ctx)).rejects.toThrow(/429/);
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });
});

describe("network-level failures", () => {
  it("re-wraps a transport error keeping only the code + path template — no axios config survives", async () => {
    // validateStatus only absorbs HTTP statuses — DNS/TLS/ECONNRESET failures
    // still reject with a raw AxiosError whose config carries the full
    // request (URL with the watched address, headers...). The connector must
    // re-wrap it: the errorHandler middleware console.logs raw error objects.
    const transportError = Object.assign(
      new Error("connect ECONNRESET 127.0.0.1:443"),
      {
        isAxiosError: true,
        code: "ECONNRESET",
        config: {
          url: `${BASE}/address/${ADDR}`,
          headers: { "X-Sentinel": "SENTINEL_NEVER_IN_ERRORS" },
        },
      }
    );
    mockedGet.mockRejectedValueOnce(transportError);

    try {
      await esploraConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("/address/:addr"); // template, not the real URL
      expect(message).toContain("ECONNRESET");
      expect(message).not.toContain(ADDR);
      // The wrapped error carries no axios request config at all, so even a
      // logger that deep-inspects the error object sees none of the request.
      expect((e as { config?: unknown }).config).toBeUndefined();
      const dump = inspect(e, { depth: 10 });
      expect(dump).not.toContain("SENTINEL_NEVER_IN_ERRORS");
      expect(dump).not.toContain(ADDR);
    }
  });

  it("re-wraps a transport error from fetchTransactions the same way", async () => {
    mockedGet.mockRejectedValueOnce(
      Object.assign(new Error("read ETIMEDOUT"), {
        isAxiosError: true,
        code: "ETIMEDOUT",
        config: { url: `${BASE}/blocks/tip/height` },
      })
    );

    try {
      await esploraConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("/blocks/tip/height");
      expect((e as Error).message).toContain("ETIMEDOUT");
      expect(inspect(e, { depth: 10 })).not.toContain("axios");
    }
  });
});

describe("other HTTP failures", () => {
  it("names only the status and the path TEMPLATE for a non-2xx — never the address", async () => {
    mockedGet.mockResolvedValueOnce(esploraResponse(503, "upstream unhappy"));

    try {
      await esploraConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("503");
      expect(message).toContain("/address/:addr");
      expect(message).not.toContain(ADDR);
      expect(message).not.toContain("upstream unhappy"); // no payload echo
    }
  });

  it("throws the shape error when a transactions page is not an array", async () => {
    mockTipThenPages({ not: "an array" });

    await expect(esploraConnector.fetchTransactions(ctx, since)).rejects.toThrow(
      /unexpected Esplora response shape/
    );
  });
});
