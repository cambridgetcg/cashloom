import { describe, expect, it } from "bun:test";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_NATIVE_USDC_ADDRESS,
  createBaseEvidenceObserver,
  type BaseRpcProviderConfig,
  type BaseTransactionObservationRequest,
} from "./base-observer.ts";

const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const beneficiary = `0x${"2".repeat(40)}` as Address;
const other = `0x${"3".repeat(40)}` as Address;
const blockHash = `0x${"a".repeat(64)}` as const;
const otherBlockHash = `0x${"b".repeat(64)}` as const;
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const providers: readonly BaseRpcProviderConfig[] = [
  { id: "provider-one", url: "https://one.invalid/rpc?private=alpha" },
  { id: "provider-two", url: "https://two.invalid/rpc?private=beta" },
];

interface Fixture {
  request: BaseTransactionObservationRequest;
  transaction: Record<string, unknown>;
  receipt: Record<string, unknown>;
  block: Record<string, unknown>;
  head: Record<string, unknown>;
  operatorResult: Hex;
}

const wordAddress = (address: Address) =>
  `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;

const makeFixture = async (
  asset: "ETH" | "USDC" = "ETH",
  status: "0x1" | "0x0" = "0x1",
  amount = 1_000_000n,
  hash = blockHash,
): Promise<Fixture> => {
  const data = asset === "USDC"
    ? encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [beneficiary, amount],
      })
    : "0x";
  const signed = await account.signTransaction({
    type: "eip1559",
    chainId: 8453,
    nonce: 7,
    to: asset === "USDC" ? BASE_NATIVE_USDC_ADDRESS : beneficiary,
    value: asset === "ETH" ? amount : 0n,
    data,
    gas: asset === "ETH" ? 21_000n : 65_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const parsed = parseTransaction(signed);
  if (
    parsed.type !== "eip1559" ||
    parsed.to === undefined ||
    parsed.r === undefined ||
    parsed.s === undefined ||
    parsed.yParity === undefined
  ) throw new Error("bad fixture");
  const transactionHash = keccak256(signed);
  const transaction = {
    hash: transactionHash,
    type: "0x2",
    chainId: "0x2105",
    from: account.address,
    to: parsed.to,
    nonce: "0x7",
    value: toHex(parsed.value ?? 0n),
    input: data,
    gas: toHex(parsed.gas ?? 0n),
    maxFeePerGas: toHex(parsed.maxFeePerGas ?? 0n),
    maxPriorityFeePerGas: toHex(parsed.maxPriorityFeePerGas ?? 0n),
    blockHash: hash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    accessList: [],
    r: typeof parsed.r === "string" ? parsed.r : toHex(parsed.r, { size: 32 }),
    s: typeof parsed.s === "string" ? parsed.s : toHex(parsed.s, { size: 32 }),
    v: toHex(parsed.yParity),
    yParity: toHex(parsed.yParity),
  };
  const logs = asset === "USDC" && status === "0x1"
    ? [{
        address: BASE_NATIVE_USDC_ADDRESS,
        topics: [transferTopic, wordAddress(account.address), wordAddress(beneficiary)],
        data: toHex(amount, { size: 32 }),
        blockHash: hash,
        blockNumber: "0x64",
        transactionHash,
        transactionIndex: "0x0",
        logIndex: "0x2",
        removed: false,
      }]
    : [];
  const receipt = {
    transactionHash,
    blockHash: hash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    from: account.address,
    to: parsed.to,
    type: "0x2",
    status,
    contractAddress: null,
    gasUsed: asset === "ETH" ? "0x5208" : "0xc350",
    effectiveGasPrice: "0x3b9aca00",
    l1Fee: "0x7b",
    logs,
  };
  return {
    request: {
      signed_transaction: signed,
      expected_transaction_hash: transactionHash,
      payment: {
        asset,
        from: account.address,
        beneficiary,
        amount_atomic: amount.toString(),
      },
    },
    transaction,
    receipt,
    block: { hash, number: "0x64", timestamp: "0x68aa7a00", transactions: [transactionHash] },
    head: {
      hash: `0x${"c".repeat(64)}`,
      number: "0xc8",
      timestamp: "0x68aa7a64",
      transactions: [],
    },
    operatorResult: toHex(17n, { size: 32 }),
  };
};

type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown[];
};

type Route = (
  request: RpcRequest,
  providerId: string,
) => unknown | Promise<unknown>;

const rpcFetch = (route: Route): typeof fetch =>
  (async (input, init) => {
    const url = String(input);
    const providerId = url.includes("one.invalid") ? "provider-one" : "provider-two";
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    const result = await route(request, providerId);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

const fixtureRoute = (
  fixtureFor: (providerId: string) => Fixture,
  options: { pending?: "null" | "mempool"; unsupportedTags?: boolean } = {},
): Route => (request, providerId) => {
  const fixture = fixtureFor(providerId);
  switch (request.method) {
    case "eth_chainId": return "0x2105";
    case "eth_getTransactionByHash": {
      if (options.pending === "null") return null;
      if (options.pending === "mempool") {
        return {
          ...fixture.transaction,
          blockHash: null,
          blockNumber: null,
          transactionIndex: null,
        };
      }
      return fixture.transaction;
    }
    case "eth_getTransactionReceipt": return options.pending ? null : fixture.receipt;
    case "eth_getBlockByHash": return fixture.block;
    case "eth_getBlockByNumber": {
      const tag = request.params[0];
      if (tag === "0x64") return fixture.block;
      if (options.unsupportedTags && (tag === "safe" || tag === "finalized")) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "secret unsupported URL" },
        }));
      }
      return fixture.head;
    }
    case "eth_call": return fixture.operatorResult;
    default: throw new Error(`unexpected ${request.method}`);
  }
};

const observer = (fetcher: typeof fetch, maxResponseBytes?: number) =>
  createBaseEvidenceObserver({
    providers,
    fetch: fetcher,
    now: () => Date.parse("2026-08-23T12:00:00.000Z"),
    max_response_bytes: maxResponseBytes,
  });

describe("Base evidence observer", () => {
  it("settles exact ETH evidence only after two finalized providers agree", async () => {
    const fixture = await makeFixture("ETH");
    const result = await observer(rpcFetch(fixtureRoute(() => fixture))).observe(fixture.request);

    expect(result.state).toBe("settled");
    expect(result.consensus).toMatchObject({
      provider_ids: ["provider-one", "provider-two"],
      quorum: "2",
      outcome: "SUCCESS",
      security_level: "FINALIZED",
      block_number: "100",
    });
    expect(result.evidence?.economic_effect).toEqual({
      asset: "ETH",
      beneficiary,
      amount_atomic: "1000000",
    });
    expect(result.evidence?.fees).toEqual({
      gas_used: "21000",
      effective_gas_price_wei: "1000000000",
      l2_execution_fee_wei: "21000000000000",
      l1_data_fee_wei: "123",
      operator_fee_wei: "17",
      total_fee_wei: "21000000000140",
    });
    expect(result.sightings.map((row) => row.security_level)).toEqual([
      "FINALIZED",
      "FINALIZED",
    ]);
    expect(result.evidence?.evidence_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("private=");
  });

  it("requires one exact nonremoved Circle USDC Transfer log", async () => {
    const fixture = await makeFixture("USDC", "0x1", 9_007_199_254_740_993n);
    const result = await observer(rpcFetch(fixtureRoute(() => fixture))).observe(fixture.request);
    expect(result.state).toBe("settled");
    expect(result.evidence?.economic_effect).toEqual({
      asset: "USDC",
      beneficiary,
      amount_atomic: "9007199254740993",
      transfer_log_index: "2",
    });

    const malformed = structuredClone(fixture) as Fixture;
    (malformed.receipt.logs as Array<Record<string, unknown>>)[0]!.topics = [
      transferTopic,
      wordAddress(account.address),
      wordAddress(other),
    ];
    const refused = await observer(rpcFetch(fixtureRoute(() => malformed))).observe(fixture.request);
    expect(refused.state).toBe("partial");
    expect(refused.providers.every((row) =>
      row.state === "unavailable" && row.error_code === "receipt_mismatch"
    )).toBe(true);
  });

  it("records a finalized revert with fee but no transfer effect", async () => {
    const fixture = await makeFixture("USDC", "0x0", 2_500_000n);
    const result = await observer(rpcFetch(fixtureRoute(() => fixture))).observe(fixture.request);
    expect(result.state).toBe("settled");
    expect(result.consensus?.outcome).toBe("REVERTED");
    expect(result.evidence?.economic_effect.amount_atomic).toBe("0");
    expect(BigInt(result.evidence!.fees.total_fee_wei)).toBeGreaterThan(0n);
  });

  it("keeps null and mempool provider results explicitly nonterminal", async () => {
    const fixture = await makeFixture();
    const invisible = await observer(
      rpcFetch(fixtureRoute(() => fixture, { pending: "null" })),
    ).observe(fixture.request);
    expect(invisible.state).toBe("pending");
    expect(invisible.sightings.map((row) => row.visibility)).toEqual([
      "NOT_FOUND",
      "NOT_FOUND",
    ]);
    expect(JSON.stringify(invisible)).not.toContain("DROPPED");

    const mempool = await observer(
      rpcFetch(fixtureRoute(() => fixture, { pending: "mempool" })),
    ).observe(fixture.request);
    expect(mempool.state).toBe("pending");
    expect(mempool.sightings.map((row) => row.visibility)).toEqual(["MEMPOOL", "MEMPOOL"]);
  });

  it("refuses wrong chain, transaction, receipt, and canonical block evidence", async () => {
    const fixture = await makeFixture();
    const cases: Array<[string, Route]> = [
      ["wrong_chain", (request) => request.method === "eth_chainId"
        ? "0x1"
        : fixtureRoute(() => fixture)(request, "provider-one")],
      ["transaction_mismatch", fixtureRoute(() => ({
        ...fixture,
        transaction: { ...fixture.transaction, hash: `0x${"f".repeat(64)}` },
      }))],
      ["receipt_mismatch", fixtureRoute(() => ({
        ...fixture,
        receipt: { ...fixture.receipt, gasUsed: toHex(21_001n) },
      }))],
      ["block_mismatch", fixtureRoute(() => ({
        ...fixture,
        block: { ...fixture.block, transactions: [] },
      }))],
      ["block_mismatch", fixtureRoute(() => ({
        ...fixture,
        transaction: { ...fixture.transaction, transactionIndex: "0x1" },
        receipt: { ...fixture.receipt, transactionIndex: "0x1" },
      }))],
    ];
    for (const [code, route] of cases) {
      const result = await observer(rpcFetch(route)).observe(fixture.request);
      expect(result.state).toBe("partial");
      expect(result.providers.every((row) =>
        row.state === "unavailable" && row.error_code === code
      )).toBe(true);
    }
  });

  it("rejects signer and calldata substitution locally before RPC", async () => {
    const eth = await makeFixture("ETH");
    let calls = 0;
    const fetcher = rpcFetch((request, providerId) => {
      calls += 1;
      return fixtureRoute(() => eth)(request, providerId);
    });
    await expect(observer(fetcher).observe({
      ...eth.request,
      payment: { ...eth.request.payment, from: other },
    })).rejects.toThrow(/signer/);
    await expect(observer(fetcher).observe({
      ...eth.request,
      payment: { ...eth.request.payment, beneficiary: other },
    })).rejects.toThrow(/authorized ETH payment/);
    expect(calls).toBe(0);
  });

  it("does not settle split-brain evidence or providers without finality tags", async () => {
    const one = await makeFixture("ETH", "0x1", 1_000_000n, blockHash);
    const two = await makeFixture("ETH", "0x1", 1_000_000n, otherBlockHash);
    // Both fixtures have identical signed bytes/hash but claim different canonical blocks.
    const split = await observer(
      rpcFetch(fixtureRoute((providerId) => providerId === "provider-one" ? one : two)),
    ).observe(one.request);
    expect(split.state).toBe("partial");
    expect(split.quorum.groups).toHaveLength(2);
    expect(split.consensus).toBeUndefined();

    const unsupported = await observer(
      rpcFetch(fixtureRoute(() => one, { unsupportedTags: true })),
    ).observe(one.request);
    expect(unsupported.state).toBe("partial");
    expect(unsupported.providers.every((row) =>
      row.state === "included" && row.finality.finalized.status === "unavailable"
    )).toBe(true);
    expect(JSON.stringify(unsupported)).not.toContain("secret unsupported URL");
  });

  it("bounds responses, redacts provider failures, and honors caller abort", async () => {
    const fixture = await makeFixture();
    const oversized = await observer(rpcFetch((request) => {
      if (request.method === "eth_chainId") return "x".repeat(2_000);
      return null;
    }), 1_024).observe(fixture.request);
    expect(oversized.providers.every((row) =>
      row.state === "unavailable" && row.error_code === "response_too_large"
    )).toBe(true);

    const secret = "https://apikey@example.invalid/do-not-leak";
    const failed = await observer((async () => {
      throw new Error(secret);
    }) as unknown as typeof fetch).observe(fixture.request);
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failed.providers.every((row) =>
      row.state === "unavailable" && row.error_code === "network_unavailable"
    )).toBe(true);

    const controller = new AbortController();
    const hangingFetch = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
    })) as typeof fetch;
    const promise = observer(hangingFetch).observe(fixture.request, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires distinct provider origins and refuses redirect-capable RPC fetches", async () => {
    expect(() => createBaseEvidenceObserver({
      providers: [
        { id: "same-a", url: "https://same.invalid/a" },
        { id: "same-b", url: "https://same.invalid/b" },
      ],
      fetch: rpcFetch(() => null),
    })).toThrow(/network origins/);

    const fixture = await makeFixture();
    const routed = rpcFetch(fixtureRoute(() => fixture));
    let calls = 0;
    const fetcher = (async (input, init) => {
      calls += 1;
      expect(init?.redirect).toBe("error");
      return routed(input, init);
    }) as typeof fetch;
    expect((await observer(fetcher).observe(fixture.request)).state).toBe("settled");
    expect(calls).toBeGreaterThan(0);
  });
});
