import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import axios, { AxiosResponse } from "axios";
import { alchemyConnector } from "./alchemy.connector";
import { ConnectorContext } from "./types";
import { InternalServerException } from "../utils/app-error";
import { HTTPSTATUS } from "../config/http.config";

// All HTTP is mocked at the axios boundary — these tests never touch the
// network. The key is an obviously-fake placeholder, never a real key shape
// with entropy. resolveCredentialRef is the REAL implementation (the
// ALCHEMY_* namespace was widened in credentials.ts by this same work item),
// driven via vi.stubEnv — no credential mocking.
vi.mock("axios", () => ({
  default: { post: vi.fn() },
}));

const mockedPost = vi.mocked(axios.post);

const FAKE_KEY = "FAKE-alchemy-key-not-real";
const REF = "ALCHEMY_API_KEY";
// The key rides in the URL PATH — this exact string must never surface in any
// error message, error config, or deep-inspected error object.
const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${FAKE_KEY}`;

// Mixed-case address so every from/to comparison exercises the
// case-insensitive 0x compare.
const ADDR = "0xAbCdEf0123456789abcdef0123456789AbCdEf01";
const OTHER = "0x1111111111111111111111111111111111111111";

const SENT_HASH =
  "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
const RECV_HASH =
  "0xffffeeeeddddccccbbbbaaaa000099998888777766665555444433332222aaaa";

const ctx: ConnectorContext = { credentialRef: REF, externalAccountId: ADDR };

const since = new Date("2026-06-01T00:00:00Z");

// Minimal-but-valid AxiosResponse so the mock satisfies the real signature.
const rpcResponse = (
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

const rpcResult = (result: unknown): AxiosResponse =>
  rpcResponse(200, { jsonrpc: "2.0", id: 1, result });

// The finalized head the connector resolves ONCE per fetchTransactions via
// eth_getBlockByNumber: the 'finalized' tag is standard JSON-RPC but is NOT a
// documented toBlock form for the proprietary alchemy_getAssetTransfers
// endpoint, so the transfers requests must carry this hex height instead.
const FINALIZED_BLOCK_HEX = "0x14a5b40";

const finalizedBlockPage = (): AxiosResponse =>
  rpcResult({ number: FINALIZED_BLOCK_HEX, hash: SENT_HASH });

// --- Fixtures ----------------------------------------------------------------

type TransferFixture = Record<string, unknown>;

// One alchemy_getAssetTransfers row. The `value` field is a DECIMAL FLOAT and
// must never be read for money — rawContract.value (hex wei) is the truth.
const transfer = (overrides: TransferFixture = {}): TransferFixture => ({
  uniqueId: `${SENT_HASH}:external`,
  hash: SENT_HASH,
  blockNum: "0x14a5b3c",
  from: ADDR.toLowerCase(),
  to: OTHER,
  value: 1,
  asset: "ETH",
  category: "external",
  rawContract: { value: "0xde0b6b3a7640000", address: null, decimal: "0x12" },
  metadata: { blockTimestamp: "2026-06-05T12:00:00.000Z" },
  ...overrides,
});

const transfersPage = (
  transfers: TransferFixture[],
  pageKey?: string
): AxiosResponse =>
  rpcResult(pageKey === undefined ? { transfers } : { transfers, pageKey });

// Routes the finalized-head resolution plus the two direction sweeps so tests
// don't depend on call order: eth_getBlockByNumber gets the block fixture,
// fromAddress requests get `sent` pages in sequence, toAddress requests get
// `received` pages in sequence.
const routeDirections = (
  sentPages: AxiosResponse[],
  receivedPages: AxiosResponse[]
): void => {
  let sentIdx = 0;
  let receivedIdx = 0;
  mockedPost.mockImplementation(async (_url, body) => {
    const { method, params } = body as {
      method: string;
      params: Array<Record<string, unknown>>;
    };
    if (method === "eth_getBlockByNumber") {
      return finalizedBlockPage();
    }
    if (params[0].fromAddress !== undefined) {
      return sentPages[Math.min(sentIdx++, sentPages.length - 1)];
    }
    return receivedPages[Math.min(receivedIdx++, receivedPages.length - 1)];
  });
};

const emptyPage = (): AxiosResponse => transfersPage([]);

// The MARQUEE invariant: no error path may surface the key or any /v2/ URL —
// not in the message, not in a config property, not anywhere a deep-inspecting
// logger could reach (errorHandler console.logs raw error objects).
const expectNoSecrets = (e: unknown): void => {
  const message = (e as Error).message;
  expect(message).not.toContain(FAKE_KEY);
  expect(message).not.toContain("/v2/");
  expect((e as { config?: unknown }).config).toBeUndefined();
  const dump = inspect(e, { depth: 10 });
  expect(dump).not.toContain(FAKE_KEY);
  expect(dump).not.toContain("/v2/");
};

// ------------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv(REF, FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("alchemyConnector", () => {
  it('has type "alchemy"', () => {
    expect(alchemyConnector.type).toBe("alchemy");
  });
});

describe("credentialRef namespace guard", () => {
  // The Alchemy connector must only ever resolve ALCHEMY_* env vars: a stored
  // ref naming any OTHER secret would otherwise be read and ride to Alchemy
  // inside the URL path — blind exfiltration of server secrets.
  it.each(["STRIPE_RESTRICTED_KEY", "GOCARDLESS_SECRET_KEY", "JWT_SECRET"])(
    "refuses credentialRef %s without reading the env or calling Alchemy",
    async (ref) => {
      vi.stubEnv(ref, "super_secret_FAKE");

      for (const call of [
        () => alchemyConnector.fetchBalance({ ...ctx, credentialRef: ref }),
        () =>
          alchemyConnector.fetchTransactions(
            { ...ctx, credentialRef: ref },
            since
          ),
      ]) {
        try {
          await call();
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(InternalServerException);
          // Names the refused VARIABLE, never any value; nothing left the box.
          expect((e as Error).message).toContain(ref);
          expect((e as Error).message).not.toContain("super_secret_FAKE");
          expectNoSecrets(e);
        }
      }
      expect(mockedPost).not.toHaveBeenCalled();
    }
  );

  it("refuses a null credentialRef (no keyless default for Alchemy) with zero HTTP", async () => {
    await expect(
      alchemyConnector.fetchBalance({ ...ctx, credentialRef: null })
    ).rejects.toThrow(InternalServerException);
    await expect(
      alchemyConnector.fetchTransactions({ ...ctx, credentialRef: null }, since)
    ).rejects.toThrow(/ALCHEMY_/);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("throws (naming the env var) when the credential env var is unset", async () => {
    vi.stubEnv(REF, "");

    await expect(alchemyConnector.fetchBalance(ctx)).rejects.toThrow(REF);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe("fetchBalance", () => {
  it("converts hex wei to an exact decimal string, far above 2^53", async () => {
    // 0xde0b6b3a7640000 = 10^18 wei = 1 ETH — a value a double cannot count
    // in. The conversion must be BigInt end to end.
    mockedPost.mockResolvedValueOnce(rpcResult("0xde0b6b3a7640000"));

    const balance = await alchemyConnector.fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("1000000000000000000");
    expect(balance.currency).toBe("ETH");
    expect(balance.decimals).toBe(18);
    expect(balance.asOf).toBeInstanceOf(Date);
  });

  it("preserves the last wei digit on a non-round amount (no float hop anywhere)", async () => {
    // 2 ETH + 1 wei: a float would round the trailing 1 away.
    mockedPost.mockResolvedValueOnce(rpcResult("0x1bc16d674ec80001"));

    const balance = await alchemyConnector.fetchBalance(ctx);
    expect(balance.balanceMinor).toBe("2000000000000000001");
  });

  it("POSTs eth_getBalance at the 'finalized' tag with the exact body and timeout", async () => {
    mockedPost.mockResolvedValueOnce(rpcResult("0x0"));

    await alchemyConnector.fetchBalance(ctx);

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedPost.mock.calls[0];
    expect(url).toBe(RPC_URL);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [ADDR, "finalized"],
    });
    expect(config?.timeout).toBe(10_000);
    // Every HTTP status must flow into the connector's own mapping, never an
    // axios throw (whose config would carry the keyed URL).
    expect(config?.validateStatus?.(500)).toBe(true);
  });

  it("refuses a non-hex balance result without echoing it", async () => {
    mockedPost.mockResolvedValueOnce(rpcResult("1000000000000000000"));

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("non-hex");
      expectNoSecrets(e);
    }
  });
});

describe("fetchTransactions", () => {
  it("merges both directions, signs by from-address, and reads money from rawContract.value only", async () => {
    const sent = transfer(); // from ADDR (lowercase) — case-insensitive match
    const received = transfer({
      uniqueId: `${RECV_HASH}:external`,
      hash: RECV_HASH,
      from: OTHER,
      to: ADDR, // mixed case on the wire
      rawContract: { value: "0x2386f26fc10000", address: null, decimal: "0x12" },
      metadata: { blockTimestamp: "2026-06-07T09:30:00.000Z" },
    });
    routeDirections([transfersPage([sent])], [transfersPage([received])]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(2);

    expect(txns[0]).toMatchObject({
      externalId: `${SENT_HASH}:external`,
      title: `ETH sent · ${SENT_HASH.slice(0, 12)}`,
      amountMinor: "-1000000000000000000", // negative = money out
      currency: "ETH",
    });
    expect(txns[0].date).toEqual(new Date("2026-06-05T12:00:00.000Z"));
    expect(txns[0].raw).toEqual(sent);

    expect(txns[1]).toMatchObject({
      externalId: `${RECV_HASH}:external`,
      title: `ETH received · ${RECV_HASH.slice(0, 12)}`,
      amountMinor: "10000000000000000", // 0.01 ETH in
      currency: "ETH",
    });
    expect(txns[1].date).toEqual(new Date("2026-06-07T09:30:00.000Z"));
  });

  it("sends the exact alchemy_getAssetTransfers body for each direction (resolved hex toBlock, both categories, desc, 0x3e8)", async () => {
    routeDirections([emptyPage()], [emptyPage()]);

    await alchemyConnector.fetchTransactions(ctx, since);

    expect(mockedPost).toHaveBeenCalledTimes(3);

    // The finalized head is resolved FIRST, through the standard method that
    // actually supports the tag…
    const [url0, body0] = mockedPost.mock.calls[0];
    expect(url0).toBe(RPC_URL);
    expect(body0).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
    });

    // …and the transfers requests carry the resolved HEX height, never the
    // tag (a documented toBlock form for the proprietary Transfers endpoint).
    const expectedBase = {
      category: ["external", "internal"],
      withMetadata: true,
      excludeZeroValue: true,
      order: "desc",
      maxCount: "0x3e8",
      toBlock: FINALIZED_BLOCK_HEX,
    };
    const [url1, body1, config1] = mockedPost.mock.calls[1];
    expect(url1).toBe(RPC_URL);
    expect(body1).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{ fromAddress: ADDR, ...expectedBase }],
    });
    expect(config1?.timeout).toBe(10_000);

    const [, body2] = mockedPost.mock.calls[2];
    expect(body2).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{ toAddress: ADDR, ...expectedBase }],
    });
  });

  it("resolves the finalized head ONCE and shares the hex toBlock across both sweeps — no transfers request ever carries a block tag", async () => {
    routeDirections(
      [transfersPage([transfer()], "pk-1"), emptyPage()],
      [emptyPage()]
    );

    await alchemyConnector.fetchTransactions(ctx, since);

    const blockCalls = mockedPost.mock.calls.filter(
      ([, body]) => (body as { method: string }).method === "eth_getBlockByNumber"
    );
    expect(blockCalls).toHaveLength(1); // once per fetchTransactions, not per page/direction

    const transferCalls = mockedPost.mock.calls.filter(
      ([, body]) =>
        (body as { method: string }).method === "alchemy_getAssetTransfers"
    );
    expect(transferCalls.length).toBeGreaterThanOrEqual(3); // 2 sent pages + 1 received
    for (const [, body] of transferCalls) {
      const params = (body as { params: Array<Record<string, unknown>> })
        .params[0];
      expect(params.toBlock).toBe(FINALIZED_BLOCK_HEX);
    }
  });

  it("refuses an eth_getBlockByNumber response without a hex block number, secret-free", async () => {
    mockedPost.mockResolvedValueOnce(rpcResult({ number: 21650240 })); // not hex

    try {
      await alchemyConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("eth_getBlockByNumber");
      expect((e as Error).message).toContain("finalized");
      expectNoSecrets(e);
    }
    expect(mockedPost).toHaveBeenCalledTimes(1); // nothing paged off a bad head
  });

  it("takes the amount from rawContract.value hex even when the float `value` field disagrees", async () => {
    // 1 ETH + 1 wei: the float field collapses it to exactly 1 — reading it
    // would silently destroy the trailing wei. The hex field must win.
    const diverging = transfer({
      value: 1, // what a double makes of 1.000000000000000001
      rawContract: {
        value: "0xde0b6b3a7640001",
        address: null,
        decimal: "0x12",
      },
    });
    routeDirections([transfersPage([diverging])], [emptyPage()]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);
    expect(txns).toHaveLength(1);
    expect(txns[0].amountMinor).toBe("-1000000000000000001");
  });

  it("skips self-transfers (net zero for the address), case-insensitively, across both sweeps", async () => {
    const self = transfer({
      from: ADDR.toLowerCase(),
      to: ADDR.toUpperCase().replace("0X", "0x"),
    });
    // A self-transfer surfaces in BOTH direction sweeps with the SAME uniqueId.
    routeDirections([transfersPage([self])], [transfersPage([self])]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);
    expect(txns).toEqual([]);
  });

  it("collapses a transfer present in both sweeps to one row (merge keyed on uniqueId)", async () => {
    const row = transfer();
    routeDirections([transfersPage([row])], [transfersPage([row])]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);
    expect(txns).toHaveLength(1);
    expect(txns[0].externalId).toBe(`${SENT_HASH}:external`);
  });

  it("drops rows lacking a uniqueId instead of fabricating an id", async () => {
    const anonymous = transfer({ uniqueId: undefined });
    const identified = transfer({
      uniqueId: `${RECV_HASH}:external`,
      hash: RECV_HASH,
    });
    routeDirections([transfersPage([anonymous, identified])], [emptyPage()]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);
    expect(txns).toHaveLength(1);
    expect(txns[0].externalId).toBe(`${RECV_HASH}:external`);
  });

  it("drops ERC-20 rows in the connector (asset !== 'ETH')", async () => {
    const erc20 = transfer({
      uniqueId: `${RECV_HASH}:log:42`,
      asset: "USDC",
      category: "erc20",
      rawContract: {
        value: "0xf4240",
        address: "0x2222222222222222222222222222222222222222",
        decimal: "0x6",
      },
    });
    routeDirections([transfersPage([erc20, transfer()])], [emptyPage()]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);
    expect(txns).toHaveLength(1);
    expect(txns[0].currency).toBe("ETH");
  });

  it("threads pageKey through subsequent pages of one direction", async () => {
    const page1Row = transfer();
    const page2Row = transfer({
      uniqueId: `${RECV_HASH}:internal`,
      hash: RECV_HASH,
      category: "internal",
      metadata: { blockTimestamp: "2026-06-03T00:00:00.000Z" },
    });
    routeDirections(
      [transfersPage([page1Row], "pk-1"), transfersPage([page2Row])],
      [emptyPage()]
    );

    const txns = await alchemyConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(2);
    expect(mockedPost).toHaveBeenCalledTimes(4); // 1 block + 2 sent pages + 1 received

    const [, body1] = mockedPost.mock.calls[1];
    expect(
      (body1 as { params: Array<Record<string, unknown>> }).params[0].pageKey
    ).toBeUndefined();
    const [, body2] = mockedPost.mock.calls[2];
    expect(
      (body2 as { params: Array<Record<string, unknown>> }).params[0]
    ).toMatchObject({ fromAddress: ADDR, pageKey: "pk-1" });
  });

  it("stops paging once a page's oldest row predates `since`, and post-filters the stragglers", async () => {
    const fresh = transfer();
    const stale = transfer({
      uniqueId: `${RECV_HASH}:external`,
      hash: RECV_HASH,
      metadata: { blockTimestamp: "2026-05-20T00:00:00.000Z" }, // before since
    });
    // pageKey is present, but the oldest row already predates the window —
    // the connector must NOT follow it.
    routeDirections([transfersPage([fresh, stale], "pk-next")], [emptyPage()]);

    const txns = await alchemyConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(1);
    expect(txns[0].externalId).toBe(`${SENT_HASH}:external`);
    expect(mockedPost).toHaveBeenCalledTimes(3); // 1 block + 1 sent page + 1 received
  });

  it("stops at the MAX_PAGES ceiling (20/direction) instead of looping forever", async () => {
    let page = 0;
    mockedPost.mockImplementation(async (_url, body) => {
      const { method, params } = body as {
        method: string;
        params: Array<Record<string, unknown>>;
      };
      if (method === "eth_getBlockByNumber") {
        return finalizedBlockPage();
      }
      if (params[0].fromAddress !== undefined) {
        page++;
        return transfersPage(
          [transfer({ uniqueId: `${SENT_HASH}:external:${page}` })],
          `pk-${page}` // always another page on offer
        );
      }
      return emptyPage();
    });

    const txns = await alchemyConnector.fetchTransactions(ctx, since);

    expect(txns).toHaveLength(20);
    expect(mockedPost).toHaveBeenCalledTimes(22); // 1 block + 20 sent pages + 1 received
  });

  it("refuses a transfers payload without a transfers array", async () => {
    routeDirections([rpcResult({})], [emptyPage()]);

    try {
      await alchemyConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("unexpected response shape");
      expectNoSecrets(e);
    }
  });

  it("refuses a non-hex rawContract.value without echoing the payload", async () => {
    const corrupt = transfer({
      rawContract: { value: "1.5", address: null, decimal: "0x12" },
    });
    routeDirections([transfersPage([corrupt])], [emptyPage()]);

    try {
      await alchemyConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("non-hex");
      expect((e as Error).message).not.toContain("1.5");
      expectNoSecrets(e);
    }
  });
});

describe("auth failures (401/403)", () => {
  it("names the env VARIABLE, the method and the status — never the key or URL", async () => {
    mockedPost.mockResolvedValueOnce(rpcResponse(401, "Must be authenticated!"));

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      // 500-family: a rejected credential is OUR misconfiguration, not a
      // user error (house rule).
      expect((e as InternalServerException).statusCode).toBe(
        HTTPSTATUS.INTERNAL_SERVER_ERROR
      );
      const message = (e as Error).message;
      expect(message).toContain(REF);
      expect(message).toContain("eth_getBalance");
      expect(message).toContain("401");
      expectNoSecrets(e);
    }
  });

  it("treats 403 the same way for fetchTransactions", async () => {
    mockedPost
      .mockResolvedValueOnce(finalizedBlockPage()) // head resolution succeeds
      .mockResolvedValueOnce(rpcResponse(403, "Forbidden"));

    try {
      await alchemyConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain(REF);
      expect((e as Error).message).toContain("alchemy_getAssetTransfers");
      expectNoSecrets(e);
    }
  });
});

describe("JSON-RPC error objects", () => {
  it("maps to fixed prose + numeric code, never echoing the upstream message", async () => {
    // Hostile-ish fixture: the upstream message embeds the keyed URL, as real
    // rpc errors sometimes echo the request. None of it may survive the wrap.
    mockedPost.mockResolvedValueOnce(
      rpcResponse(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: `invalid request to ${RPC_URL}` },
      })
    );

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("eth_getBalance");
      expect(message).toContain("-32600");
      expect(message).not.toContain("invalid request to");
      expectNoSecrets(e);
    }
  });

  it("refuses an envelope with neither result nor error", async () => {
    mockedPost.mockResolvedValueOnce(rpcResponse(200, { jsonrpc: "2.0", id: 1 }));

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("unexpected response shape");
      expectNoSecrets(e);
    }
  });
});

describe("rate limiting (429)", () => {
  it("retries once after Retry-After, then succeeds", async () => {
    mockedPost
      .mockResolvedValueOnce(rpcResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(rpcResult("0xde0b6b3a7640000"));

    const balance = await alchemyConnector.fetchBalance(ctx);

    expect(balance.balanceMinor).toBe("1000000000000000000");
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it("fails after a second consecutive 429, with no secret in any surface", async () => {
    mockedPost
      .mockResolvedValueOnce(rpcResponse(429, {}, { "retry-after": "0" }))
      .mockResolvedValueOnce(rpcResponse(429, {}, { "retry-after": "0" }));

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toMatch(/429/);
      expectNoSecrets(e);
    }
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });
});

describe("network-level failures", () => {
  it("re-wraps a transport error so the keyed URL in the axios config never escapes", async () => {
    // validateStatus only absorbs HTTP statuses — DNS/TLS/reset failures still
    // reject with a raw AxiosError whose config.url IS /v2/{key}. One such
    // error reaching errorHandler's console.log prints the live key.
    const transportError = Object.assign(
      new Error(`connect ECONNREFUSED ${RPC_URL}`),
      {
        isAxiosError: true,
        code: "ECONNREFUSED",
        config: { url: RPC_URL, method: "post" },
      }
    );
    mockedPost.mockRejectedValueOnce(transportError);

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      const message = (e as Error).message;
      expect(message).toContain("eth_getBalance");
      expect(message).toContain("ECONNREFUSED");
      expectNoSecrets(e);
    }
  });

  it("re-wraps a timeout from fetchTransactions the same way", async () => {
    mockedPost
      .mockResolvedValueOnce(finalizedBlockPage()) // head resolution succeeds
      .mockRejectedValueOnce(
        Object.assign(new Error(`timeout of 10000ms exceeded for ${RPC_URL}`), {
          isAxiosError: true,
          code: "ECONNABORTED",
          config: { url: RPC_URL, method: "post" },
        })
      );

    try {
      await alchemyConnector.fetchTransactions(ctx, since);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toContain("alchemy_getAssetTransfers");
      expect((e as Error).message).toContain("ECONNABORTED");
      expectNoSecrets(e);
    }
  });
});

describe("other HTTP failures", () => {
  it("throws with the status only for a 500, secret-free", async () => {
    mockedPost.mockResolvedValueOnce(rpcResponse(500, "Internal error"));

    try {
      await alchemyConnector.fetchBalance(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as Error).message).toMatch(/500/);
      expectNoSecrets(e);
    }
  });
});
