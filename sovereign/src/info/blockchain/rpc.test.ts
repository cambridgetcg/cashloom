import { describe, expect, it, vi } from "vitest";
import { BITCOIN_MAINNET_GENESIS, SOLANA_MAINNET_GENESIS } from "./registry.ts";
import {
  BlockchainRpcError,
  ResourceCache,
  createBlockchainRpcClient,
} from "./rpc.ts";
import type { EvmReferenceBlock } from "./types.ts";

function bodyOf(init?: RequestInit): any {
  return JSON.parse(String(init?.body));
}

function rpcResult(id: number, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: number, code: number, message = "upstream refused"): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function pinnedReference(): EvmReferenceBlock {
  return {
    chain_key: "ethereum",
    chain: "eip155:1",
    family: "evm",
    height: "16",
    height_hex: "0x10",
    height_kind: "block-number",
    hash: `0x${"ab".repeat(32)}`,
    block_time: { unix_seconds: "1700000000", iso: "2023-11-14T22:13:20.000Z" },
    fetched_at: "2026-08-20T00:00:00.000Z",
    finality: {
      claim: "upstream-safe",
      basis: "json-rpc-block-tag",
      requested_tag: "finalized",
      resolved_tag: "safe",
      fallback_used: true,
      attempts: [
        { tag: "finalized", outcome: "unsupported" },
        { tag: "safe", outcome: "selected" },
      ],
    },
    source: {
      chain: "eip155:1",
      provider: "Configured RPC provider",
      transport: "json-rpc",
      configuration: "environment",
      rpc_documentation_url: "https://ethereum.org/developers/docs/apis/json-rpc/",
      explorer_url: "https://etherscan.io/",
      endpoint_disclosed: false,
    },
  };
}

function ethereumReferenceResult(id: number, hash = pinnedReference().hash): Response {
  return rpcResult(id, {
    number: "0x10",
    hash,
    timestamp: "0x6553f100",
  });
}

describe("bounded blockchain RPC", () => {
  it("refuses malformed JSON-RPC envelopes and wrong EVM chains", async () => {
    const malformed = createBlockchainRpcClient({
      env: { CASHLOOM_ETHEREUM_RPC_URL: "https://rpc.example/secret" },
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        return rpcResult(request.id + 1, "0x1");
      },
    });
    await expect(malformed.evmRead("ethereum", "eth_chainId")).rejects.toMatchObject({
      code: "RPC_MALFORMED_RESPONSE",
    });

    const wrongChain = createBlockchainRpcClient({
      fetch: async (_url, init) => rpcResult(bodyOf(init).id, "0xa"),
    });
    await expect(wrongChain.evmRead("ethereum", "eth_chainId")).rejects.toMatchObject({
      code: "RPC_CHAIN_MISMATCH",
      expected_chain_id: "1",
      actual_chain_id: "10",
    });
  });

  it("requires exactly one well-shaped JSON-RPC result or error", async () => {
    const invalidBodies = [
      (id: number) => ({ jsonrpc: "2.0", id, result: "0x1", error: { code: -32000, message: "both" } }),
      (id: number) => ({ jsonrpc: "2.0", id, error: null }),
      (id: number) => ({ jsonrpc: "2.0", id, error: { code: "-32000", message: "wrong code type" } }),
      (id: number) => ({ jsonrpc: "2.0", id, error: { code: -32000 } }),
    ];
    for (const makeBody of invalidBodies) {
      const client = createBlockchainRpcClient({
        fetch: async (_url, init) => Response.json(makeBody(bodyOf(init).id)),
      });
      await expect(client.evmRead("ethereum", "eth_chainId"))
        .rejects.toMatchObject({ code: "RPC_MALFORMED_RESPONSE" });
    }
  });

  it("classifies timeout and caller abort without exposing transport errors", async () => {
    // Deliberately ignore AbortSignal: the deadline itself must still settle.
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const client = createBlockchainRpcClient({ fetch: fetcher, timeout_ms: 10 });
    await expect(client.evmRead("ethereum", "eth_chainId")).rejects.toMatchObject({ code: "RPC_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(client.evmRead("ethereum", "eth_chainId", [], { signal: controller.signal }))
      .rejects.toMatchObject({ code: "RPC_ABORTED" });

    let bodyCancelled = false;
    const streamClient = createBlockchainRpcClient({
      timeout_ms: 10,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => { bodyCancelled = true; },
      })),
    });
    await expect(streamClient.evmRead("ethereum", "eth_chainId"))
      .rejects.toMatchObject({ code: "RPC_TIMEOUT" });
    expect(bodyCancelled).toBe(true);
  });

  it("rejects unbounded/extended generic EVM parameters before network I/O", async () => {
    const fetcher = vi.fn(async () => rpcResult(1, "0x1"));
    const client = createBlockchainRpcClient({ fetch: fetcher });
    await expect(client.evmRead("ethereum", "eth_call", [
      { to: `0x${"11".repeat(20)}`, data: "0x01" },
      "latest",
      { [`0x${"22".repeat(20)}`]: { balance: "0x1" } },
    ] as any)).rejects.toMatchObject({ code: "RPC_INVALID_CALL" });
    await expect(client.evmRead("ethereum", "eth_getBlockByNumber", ["latest", true]))
      .rejects.toMatchObject({ code: "RPC_INVALID_CALL" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces request and declared/streaming response caps", async () => {
    const client = createBlockchainRpcClient({
      fetch: async () => new Response("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}", {
        headers: { "content-length": "1024" },
      }),
    });
    await expect(client.evmRead("ethereum", "eth_chainId", [], { max_response_bytes: 64 }))
      .rejects.toMatchObject({ code: "RPC_RESPONSE_TOO_LARGE" });

    const streamed = createBlockchainRpcClient({
      fetch: async () => new Response("x".repeat(65)),
    });
    await expect(streamed.evmRead("ethereum", "eth_chainId", [], { max_response_bytes: 64 }))
      .rejects.toMatchObject({ code: "RPC_RESPONSE_TOO_LARGE" });

    const neverCalled = vi.fn(async () => rpcResult(1, "0x1"));
    const requestBounded = createBlockchainRpcClient({
      fetch: neverCalled,
      max_request_bytes: 8,
    });
    await expect(requestBounded.evmRead("ethereum", "eth_chainId"))
      .rejects.toMatchObject({ code: "RPC_REQUEST_TOO_LARGE" });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("never retains a configured credential or hostile upstream message in receipts/errors", async () => {
    const secret = "cashloom-super-secret-token";
    const client = createBlockchainRpcClient({
      env: { CASHLOOM_ETHEREUM_RPC_URL: `https://rpc.example/v2/${secret}` },
      fetch: async (_url, init) => rpcError(bodyOf(init).id, -32000, `failed ${secret}`),
    });
    let caught: unknown;
    try {
      await client.evmRead("ethereum", "eth_chainId");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockchainRpcError);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).stack).not.toContain(secret);
  });
});

describe("reference blocks and pinned EVM calls", () => {
  it("records finalized→safe fallback and batches every read by canonical block hash", async () => {
    const requests: any[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = bodyOf(init);
      requests.push(request);
      if (Array.isArray(request)) {
        return Response.json(request.slice().reverse().map((item: any) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: item.params[0].data === "0x01" ? "0xaaaa" : "0xbbbb",
        })));
      }
      if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
      if (request.method === "eth_getBlockByNumber" && request.params[0] === "finalized") {
        return rpcError(request.id, -32602, "unsupported tag");
      }
      if (request.method === "eth_getBlockByNumber" && request.params[0] === "safe") {
        return rpcResult(request.id, {
          number: "0x10",
          hash: `0x${"ab".repeat(32)}`,
          timestamp: "0x6553f100",
        });
      }
      throw new Error("unexpected request");
    });
    const client = createBlockchainRpcClient({
      fetch: fetcher,
      clock: () => Date.parse("2026-08-20T00:00:00.000Z"),
    });
    const reference = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    expect(reference).toMatchObject({
      height: "16",
      height_hex: "0x10",
      hash: `0x${"ab".repeat(32)}`,
      block_time: { unix_seconds: "1700000000", iso: "2023-11-14T22:13:20.000Z" },
      finality: {
        claim: "upstream-safe",
        requested_tag: "finalized",
        resolved_tag: "safe",
        fallback_used: true,
        attempts: [
          { tag: "finalized", outcome: "unsupported" },
          { tag: "safe", outcome: "selected" },
        ],
      },
    });

    const snapshot = await client.evmCallsAtReference("ethereum", [
      { key: "usdc.supply", to: `0x${"11".repeat(20)}`, data: "0x01" },
      { key: "aave.liquidity", to: `0x${"22".repeat(20)}`, data: "0x02" },
    ], reference);
    expect(snapshot.transport).toBe("json-rpc-batch");
    expect(snapshot.pinning).toBe("block-hash-canonical");
    expect(snapshot.reference).not.toBe(reference);
    expect(snapshot.reference).toEqual(reference);
    expect(snapshot.results).toEqual([
      { key: "usdc.supply", data: "0xaaaa" },
      { key: "aave.liquidity", data: "0xbbbb" },
    ]);
    const batch = requests.find(Array.isArray);
    expect(batch).toBeDefined();
    expect(batch!.every((item: any) =>
      item.params[1].blockHash === reference.hash && item.params[1].requireCanonical === true)).toBe(true);
    expect(requests.filter((request) => !Array.isArray(request) && request.method === "eth_getBlockByNumber"))
      .toHaveLength(2);
  });

  it("falls back safely on Base-style batch entry errors while individual reads succeed", async () => {
    const requestedBlocks: unknown[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = bodyOf(init);
      if (Array.isArray(request)) {
        return Response.json(request.map((item: any) => ({
          jsonrpc: "2.0",
          id: item.id,
          error: { code: -32016, message: "provider batch entry refused" },
        })));
      }
      if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
      if (request.method === "eth_getBlockByNumber") return ethereumReferenceResult(request.id);
      if (request.method === "eth_call") {
        requestedBlocks.push(request.params[1]);
        return rpcResult(request.id, request.params[0].data === "0x01" ? "0x11" : "0x22");
      }
      throw new Error("unexpected request");
    });
    const client = createBlockchainRpcClient({ fetch: fetcher });
    const reference = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    const result = await client.evmCallsAtReference("ethereum", [
      { key: "one", to: `0x${"11".repeat(20)}`, data: "0x01" },
      { key: "two", to: `0x${"22".repeat(20)}`, data: "0x02" },
    ], reference);
    expect(result.transport).toBe("parallel-fallback");
    expect(result.pinning).toBe("block-hash-canonical");
    expect(requestedBlocks).toEqual([
      { blockHash: reference.hash, requireCanonical: true },
      { blockHash: reference.hash, requireCanonical: true },
    ]);
  });

  it("also falls back on one well-shaped batch-level provider error", async () => {
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (Array.isArray(request)) return rpcError(0, -32016, "batch refused");
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
        if (request.method === "eth_getBlockByNumber") return ethereumReferenceResult(request.id);
        if (request.method === "eth_call") return rpcResult(request.id, "0x11");
        throw new Error("unexpected request");
      },
    });
    const reference = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    const result = await client.evmCallsAtReference("ethereum", [{
      key: "one",
      to: `0x${"11".repeat(20)}`,
      data: "0x01",
    }], reference);
    expect(result).toMatchObject({
      transport: "parallel-fallback",
      pinning: "block-hash-canonical",
      results: [{ key: "one", data: "0x11" }],
    });
  });

  it("still surfaces a true individual contract revert after a batch error", async () => {
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (Array.isArray(request)) {
          return Response.json(request.map((item: any) => ({
            jsonrpc: "2.0",
            id: item.id,
            error: { code: -32016, message: "batch entry refused" },
          })));
        }
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
        if (request.method === "eth_getBlockByNumber") return ethereumReferenceResult(request.id);
        if (request.method === "eth_call" &&
            request.params[0].to === "0x0000000000000000000000000000000000000000") {
          return rpcResult(request.id, "0x");
        }
        if (request.method === "eth_call") return rpcError(request.id, -32015, "execution reverted");
        throw new Error("unexpected request");
      },
    });
    const reference = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    await expect(client.evmCallsAtReference("ethereum", [{
      key: "reverting",
      to: `0x${"11".repeat(20)}`,
      data: "0x01",
    }], reference)).rejects.toMatchObject({
      code: "RPC_REMOTE_ERROR",
      remote_code: -32015,
    });
  });

  it("uses canonical pre/post hash checks when EIP-1898 is unsupported and refuses a reorg", async () => {
    let canonicalChecks = 0;
    const expectedHash = pinnedReference().hash;
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (Array.isArray(request)) {
          const hashPinned = typeof request[0].params[1] === "object";
          return Response.json(request.map((item: any) => hashPinned
            ? { jsonrpc: "2.0", id: item.id, error: { code: -32602, message: "object selector unsupported" } }
            : { jsonrpc: "2.0", id: item.id, result: "0x11" }));
        }
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
        if (request.method === "eth_call") return rpcError(request.id, -32602, "object selector unsupported");
        if (request.method === "eth_getBlockByNumber") {
          if (request.params[0] === "finalized") return ethereumReferenceResult(request.id, expectedHash);
          canonicalChecks += 1;
          return rpcResult(request.id, {
            number: "0x10",
            hash: canonicalChecks === 1 ? expectedHash : `0x${"cd".repeat(32)}`,
          });
        }
        throw new Error("unexpected request");
      },
    });
    const reference = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    await expect(client.evmCallsAtReference("ethereum", [{
      key: "one",
      to: `0x${"11".repeat(20)}`,
      data: "0x01",
    }], reference)).rejects.toMatchObject({ code: "RPC_REFERENCE_UNAVAILABLE" });
    expect(canonicalChecks).toBe(2);
  });

  it("never accepts copied reference metadata pairing a real hash with an invented height", async () => {
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
        if (request.method === "eth_getBlockByNumber") return ethereumReferenceResult(request.id);
        throw new Error("unexpected request");
      },
    });
    const issued = await client.getReferenceBlock("ethereum") as EvmReferenceBlock;
    const fake = { ...issued, height: "17", height_hex: "0x11" } as EvmReferenceBlock;
    await expect(client.evmCallsAtReference("ethereum", [{
      key: "one",
      to: `0x${"11".repeat(20)}`,
      data: "0x01",
    }], fake)).rejects.toMatchObject({ code: "RPC_INVALID_CALL" });
  });

  it("does not downgrade finalized reads on ambiguous -32000/-32001 server errors", async () => {
    const tags: string[] = [];
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x1");
        tags.push(request.params[0]);
        return rpcError(request.id, -32000, "backend unavailable");
      },
    });
    await expect(client.getReferenceBlock("ethereum")).rejects.toMatchObject({
      code: "RPC_REMOTE_ERROR",
      remote_code: -32000,
    });
    expect(tags).toEqual(["finalized"]);
  });

  it("deduplicates concurrent reference loads per chain resource", async () => {
    let blockCalls = 0;
    const client = createBlockchainRpcClient({
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        if (request.method === "eth_chainId") return rpcResult(request.id, "0x2105");
        blockCalls += 1;
        return rpcResult(request.id, {
          number: "0x123",
          hash: `0x${"cd".repeat(32)}`,
          timestamp: "0x6553f100",
        });
      },
    });
    const [a, b] = await Promise.all([
      client.getReferenceBlock("base"),
      client.getReferenceBlock("eip155:8453"),
    ]);
    expect(blockCalls).toBe(1);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => { (a as any).height = "999"; }).toThrow();
    const cached = await client.getReferenceBlock("base");
    expect(cached.height).toBe("291");
  });
});

describe("Bitcoin and Solana fixed primitives", () => {
  it("refuses configured Bitcoin/Solana endpoints for the wrong genesis", async () => {
    const bitcoin = createBlockchainRpcClient({
      fetch: async () => new Response("ff".repeat(32)),
    });
    await expect(bitcoin.bitcoinMempool()).rejects.toMatchObject({ code: "RPC_CHAIN_MISMATCH" });

    const solana = createBlockchainRpcClient({
      fetch: async (_url, init) => rpcResult(bodyOf(init).id, "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC"),
    });
    await expect(solana.getReferenceBlock("solana")).rejects.toMatchObject({ code: "RPC_CHAIN_MISMATCH" });
  });

  it("returns exact Bitcoin mempool/3-block fee fields and a pinned tip", async () => {
    const tipHash = "00".repeat(32);
    const paths: string[] = [];
    const client = createBlockchainRpcClient({
      clock: () => Date.parse("2026-08-20T12:00:00.000Z"),
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("/block-height/0")) return new Response(BITCOIN_MAINNET_GENESIS);
        if (path.endsWith("/mempool")) {
          return Response.json({ count: 1234, vsize: 567890, total_fee: 998877, fee_histogram: [] });
        }
        if (path.endsWith("/fee-estimates")) return new Response('{"1":12,"3":1.0050,"6":0.9}');
        if (path.endsWith("/blocks/tip/hash")) return new Response(tipHash);
        if (path.endsWith(`/block/${tipHash}`)) {
          return Response.json({ id: tipHash, height: 900001, timestamp: 1700000000 });
        }
        return new Response("missing", { status: 404 });
      },
    });
    await expect(client.bitcoinMempool()).resolves.toMatchObject({
      transaction_count: "1234",
      virtual_size_bytes: "567890",
      total_fee_sats: "998877",
    });
    await expect(client.bitcoinFeeEstimate()).resolves.toMatchObject({
      target_blocks: "3",
      sat_per_vbyte: "1.0050",
    });
    const reference = await client.getReferenceBlock("bitcoin");
    expect(reference).toMatchObject({
      height: "900001",
      hash: tipHash,
      finality: { claim: "bitcoin-proof-of-work-tip" },
    });
    expect(paths.filter((path) => path.endsWith("/block-height/0"))).toHaveLength(1);
  });

  it("extracts only one exact top-level Bitcoin 3-block fee token", async () => {
    const clientFor = (feeBody: string) => createBlockchainRpcClient({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/block-height/0")) return new Response(BITCOIN_MAINNET_GENESIS);
        if (path.endsWith("/fee-estimates")) return new Response(feeBody);
        return new Response("missing", { status: 404 });
      },
    });
    await expect(clientFor('{"nested":{"3":1.0050},"3":99}').bitcoinFeeEstimate())
      .resolves.toMatchObject({ sat_per_vbyte: "99" });
    await expect(clientFor('{"3":1.0050,"3":99}').bitcoinFeeEstimate())
      .rejects.toMatchObject({ code: "RPC_MALFORMED_RESPONSE" });
  });

  it("verifies Solana genesis, pins a finalized non-skipped slot, and shapes pulse reads", async () => {
    const methods: string[] = [];
    const client = createBlockchainRpcClient({
      clock: () => Date.parse("2026-08-20T12:00:00.000Z"),
      fetch: async (_url, init) => {
        const request = bodyOf(init);
        methods.push(request.method);
        if (request.method === "getGenesisHash") return rpcResult(request.id, SOLANA_MAINNET_GENESIS);
        if (request.method === "getSlot") return rpcResult(request.id, 420);
        if (request.method === "getBlock" && request.params[0] === 420) return rpcResult(request.id, null);
        if (request.method === "getBlock") {
          return rpcResult(request.id, {
            blockhash: "11111111111111111111111111111111",
            blockTime: 1700000000,
          });
        }
        if (request.method === "getRecentPerformanceSamples") {
          return rpcResult(request.id, [{
            slot: 419,
            numTransactions: 987654,
            numNonVoteTransactions: 876543,
            numSlots: 120,
            samplePeriodSecs: 60,
          }]);
        }
        if (request.method === "getRecentPrioritizationFees") {
          return rpcResult(request.id, [{ slot: 419, prioritizationFee: 2500 }]);
        }
        throw new Error("unexpected request");
      },
    });
    const reference = await client.getReferenceBlock("solana");
    expect(reference).toMatchObject({
      height: "419",
      hash: "11111111111111111111111111111111",
      finality: { claim: "solana-finalized-commitment", fallback_used: true },
    });
    await expect(client.solanaPerformanceSamples("solana", 12)).resolves.toMatchObject({
      samples: [{
        slot: "419",
        transactions: "987654",
        non_vote_transactions: "876543",
        slots: "120",
        sample_period_seconds: "60",
      }],
    });
    await expect(client.solanaPrioritizationFees()).resolves.toMatchObject({
      fees: [{ slot: "419", micro_lamports_per_compute_unit: "2500" }],
    });
    expect(methods.filter((method) => method === "getGenesisHash")).toHaveLength(1);
    await expect(client.solanaPerformanceSamples("solana", 61)).rejects.toMatchObject({ code: "RPC_INVALID_CALL" });
    await expect(client.solanaPrioritizationFees("solana", ["not-a-public-key"]))
      .rejects.toMatchObject({ code: "RPC_INVALID_CALL" });
  });
});

describe("ResourceCache", () => {
  it("deduplicates by exact key while isolating resources and cache instances", async () => {
    let now = 1_000;
    const first = new ResourceCache({ clock: () => now, max_entries: 4 });
    const second = new ResourceCache({ clock: () => now, max_entries: 4 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = vi.fn(async () => { await gate; return { value: "a" }; });
    const a = first.get("ethereum:block", 100, load);
    const duplicate = first.get("ethereum:block", 100, load);
    const other = first.get("base:block", 100, async () => ({ value: "b" }));
    const isolated = second.get("ethereum:block", 100, async () => ({ value: "other-instance" }));
    expect(load).toHaveBeenCalledTimes(1);
    release();
    expect(await a).toBe(await duplicate);
    await expect(other).resolves.toEqual({ value: "b" });
    await expect(isolated).resolves.toEqual({ value: "other-instance" });

    now += 101;
    await first.get("ethereum:block", 100, async () => ({ value: "fresh" }));
    expect(first.size).toBeGreaterThan(0);
  });

  it("does not cache rejected loads", async () => {
    const cache = new ResourceCache();
    let attempts = 0;
    await expect(cache.get("failure", 1000, async () => {
      attempts += 1;
      throw new Error("nope");
    })).rejects.toThrow("nope");
    await cache.get("failure", 1000, async () => {
      attempts += 1;
      return "ok";
    });
    expect(attempts).toBe(2);
  });

  it("does not let a deleted in-flight load repopulate newer cache state", async () => {
    const cache = new ResourceCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const old = cache.get("reference", 1_000, async () => {
      await gate;
      return "old";
    });
    cache.delete("reference");
    await expect(cache.get("reference", 1_000, async () => "new")).resolves.toBe("new");
    release();
    await expect(old).resolves.toBe("old");
    await expect(cache.get("reference", 1_000, async () => "wrong")).resolves.toBe("new");
  });
});
