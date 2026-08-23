import { describe, expect, it } from "bun:test";
import { toHex, type Address } from "viem";
import {
  BASE_ETH_ASSET_ID,
  BASE_NATIVE_USDC_ADDRESS,
  BASE_USDC_ASSET_ID,
  createBasePositionObserver,
  type BasePositionRpcProviderConfig,
} from "./base-position-observer.ts";

const account = `0x${"a1".repeat(20)}` as Address;
const commonHash = `0x${"b2".repeat(32)}` as const;
const alternateHash = `0x${"c3".repeat(32)}` as const;
const targetNumber = 9_007_199_254_740_993n;
const targetTag = toHex(targetNumber);
const timestamp = 1_777_777_777n;
const ethBalance = 9_007_199_254_740_993_123_456_789n;
const usdcBalance = 9_007_199_254_740_993n;
const providers: readonly BasePositionRpcProviderConfig[] = [
  { id: "provider-one", url: "https://one.invalid/rpc?private=alpha" },
  { id: "provider-two", url: "https://two.invalid/rpc?private=beta" },
];

type RpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: readonly unknown[];
};

type RpcRoute = (
  request: RpcRequest,
  providerId: string,
) => unknown | Response | Promise<unknown | Response>;

const rpcFetch = (route: RpcRoute): typeof fetch =>
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

const block = (
  number: bigint,
  hash: `0x${string}`,
  blockTimestamp = timestamp,
): Record<string, unknown> => ({
  number: toHex(number),
  hash,
  timestamp: toHex(blockTimestamp),
  transactions: [],
});
interface RouteOptions {
  readonly chainFor?: (providerId: string) => string;
  readonly headFor?: (providerId: string) => Record<string, unknown> | null;
  readonly blockFor?: (
    providerId: string,
    readIndex: number,
  ) => Record<string, unknown> | null;
  readonly ethFor?: (providerId: string) => bigint | string;
  readonly usdcFor?: (providerId: string) => bigint | string;
}

const standardRoute = (
  options: RouteOptions = {},
  calls: RpcRequest[] = [],
): RpcRoute => {
  const blockReads = new Map<string, number>();
  return (request, providerId) => {
    calls.push(request);
    switch (request.method) {
      case "eth_chainId":
        return options.chainFor?.(providerId) ?? "0x2105";
      case "eth_getBlockByNumber": {
        if (request.params[0] === "finalized") {
          return options.headFor?.(providerId) ?? block(targetNumber, commonHash);
        }
        const readIndex = (blockReads.get(providerId) ?? 0) + 1;
        blockReads.set(providerId, readIndex);
        return options.blockFor?.(providerId, readIndex) ?? block(targetNumber, commonHash);
      }
      case "eth_getBalance": {
        const result = options.ethFor?.(providerId) ?? ethBalance;
        return typeof result === "bigint" ? toHex(result) : result;
      }
      case "eth_call": {
        const result = options.usdcFor?.(providerId) ?? usdcBalance;
        return typeof result === "bigint" ? toHex(result, { size: 32 }) : result;
      }
      default:
        throw new Error(`unexpected RPC method ${request.method}`);
    }
  };
};

const makeObserver = (
  fetcher: typeof fetch,
  overrides: { readonly deadline_ms?: number; readonly max_response_bytes?: number } = {},
) => createBasePositionObserver({
  providers,
  fetch: fetcher,
  now: () => Date.parse("2026-08-23T12:00:00.000Z"),
  ...overrides,
});

describe("finalized Base position observer", () => {
  it("corroborates exact ETH and Circle USDC balances without Number coercion", async () => {
    const calls: RpcRequest[] = [];
    const route = standardRoute({
      // A faster provider may have a newer finalized head. Both must still
      // prove the lower common finalized height selected by the observer.
      headFor: (providerId) => providerId === "provider-one"
        ? block(targetNumber + 11n, alternateHash, timestamp + 11n)
        : block(targetNumber, commonHash),
    }, calls);
    const result = await makeObserver(rpcFetch(route)).observe({ account_address: account });

    expect(result.state).toBe("settled");
    expect(result.snapshot).toMatchObject({
      schema_version: "cashloom.base-position-snapshot/1",
      chain_id: "eip155:8453",
      account_address: account,
      security_level: "FINALIZED",
      block: {
        number: "9007199254740993",
        hash: commonHash,
        timestamp: timestamp.toString(),
      },
      provider_ids: ["provider-one", "provider-two"],
      quorum: "2",
    });
    expect(result.snapshot?.balances).toEqual([
      {
        asset: "ETH",
        asset_id: BASE_ETH_ASSET_ID,
        atomic: ethBalance.toString(),
        decimals: "18",
      },
      {
        asset: "USDC",
        asset_id: BASE_USDC_ASSET_ID,
        atomic: usdcBalance.toString(),
        decimals: "6",
        contract_address: BASE_NATIVE_USDC_ADDRESS,
      },
    ]);
    expect(result.snapshot?.evidence_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.sightings.map((sighting) => sighting.provider_trust_domain)).toEqual([
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    ]);
    expect(result.sightings[0]?.provider_trust_domain).not.toBe(
      result.sightings[1]?.provider_trust_domain,
    );
    expect(JSON.stringify(result)).not.toContain(".invalid");
    expect(JSON.stringify(result)).not.toContain("private=");

    const balanceCalls = calls.filter((request) => request.method === "eth_getBalance");
    expect(balanceCalls).toHaveLength(2);
    expect(balanceCalls.every((request) =>
      request.params[0] === account && request.params[1] === targetTag
    )).toBe(true);
    const tokenCalls = calls.filter((request) => request.method === "eth_call");
    expect(tokenCalls).toHaveLength(2);
    const expectedCalldata = `0x70a08231${account.slice(2).padStart(64, "0")}`;
    expect(tokenCalls.every((request) => {
      const call = request.params[0] as Record<string, unknown>;
      return Object.keys(call).sort().join(",") === "data,to" &&
        call.to === BASE_NATIVE_USDC_ADDRESS &&
        call.data === expectedCalldata &&
        request.params[1] === targetTag;
    })).toBe(true);
    expect(calls.filter((request) =>
      request.method === "eth_getBlockByNumber" && request.params[0] === targetTag
    )).toHaveLength(4);
  });

  it("never converts wrong-chain or unavailable providers into zero balances", async () => {
    const calls: RpcRequest[] = [];
    const result = await makeObserver(rpcFetch(standardRoute({
      chainFor: (providerId) => providerId === "provider-one" ? "0x1" : "0x2105",
    }, calls))).observe({ account_address: account });

    expect(result).toMatchObject({
      state: "partial",
      reason: "provider_unavailable",
      providers: [
        { provider_id: "provider-one", state: "unavailable", error_code: "wrong_chain" },
        { provider_id: "provider-two", state: "head_observed" },
      ],
      sightings: [],
    });
    expect(result.snapshot).toBeUndefined();
    expect(calls.some((request) =>
      request.method === "eth_getBalance" || request.method === "eth_call"
    )).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"atomic":"0"');
  });

  it("refuses mismatched finalized block identity and balance values", async () => {
    const splitCalls: RpcRequest[] = [];
    const blockSplit = await makeObserver(rpcFetch(standardRoute({
      headFor: (providerId) => block(
        targetNumber,
        providerId === "provider-one" ? commonHash : alternateHash,
      ),
      blockFor: (providerId) => block(
        targetNumber,
        providerId === "provider-one" ? commonHash : alternateHash,
      ),
    }, splitCalls))).observe({ account_address: account });
    expect(blockSplit.state).toBe("partial");
    expect(blockSplit.reason).toBe("provider_disagreement");
    expect(blockSplit.sightings).toHaveLength(0);
    expect(blockSplit.snapshot).toBeUndefined();
    expect(splitCalls.some((request) =>
      request.method === "eth_getBalance" || request.method === "eth_call"
    )).toBe(false);

    const valueSplit = await makeObserver(rpcFetch(standardRoute({
      ethFor: (providerId) => providerId === "provider-one"
        ? ethBalance
        : ethBalance + 1n,
    }))).observe({ account_address: account });
    expect(valueSplit.state).toBe("partial");
    expect(valueSplit.reason).toBe("provider_disagreement");
    expect(valueSplit.snapshot).toBeUndefined();
    expect(valueSplit.sightings[0]?.evidence_hash).not.toBe(
      valueSplit.sightings[1]?.evidence_hash,
    );
  });

  it("rejects a canonical block that changes while balances are being read", async () => {
    const result = await makeObserver(rpcFetch(standardRoute({
      blockFor: (providerId, readIndex) =>
        providerId === "provider-one" && readIndex === 2
          ? block(targetNumber, alternateHash)
          : block(targetNumber, commonHash),
    }))).observe({ account_address: account });

    expect(result.state).toBe("partial");
    expect(result.reason).toBe("provider_unavailable");
    expect(result.providers).toEqual([
      { provider_id: "provider-one", state: "unavailable", error_code: "block_mismatch" },
      expect.objectContaining({ provider_id: "provider-two", state: "observed" }),
    ]);
    expect(result.sightings).toHaveLength(1);
    expect(result.snapshot).toBeUndefined();
  });

  it("strictly bounds and validates JSON-RPC responses", async () => {
    const oversized = await makeObserver(rpcFetch((request) => {
      if (request.method === "eth_chainId") return "x".repeat(2_000);
      return null;
    }), { max_response_bytes: 1_024 }).observe({ account_address: account });
    expect(oversized.providers.every((provider) =>
      provider.state === "unavailable" && provider.error_code === "response_too_large"
    )).toBe(true);

    const malformed = await makeObserver(rpcFetch((request) => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: `${request.id}:wrong`,
      result: "0x2105",
    }), { headers: { "content-type": "application/json" } }))).observe({
      account_address: account,
    });
    expect(malformed.providers.every((provider) =>
      provider.state === "unavailable" && provider.error_code === "malformed_rpc"
    )).toBe(true);

    const badWord = await makeObserver(rpcFetch(standardRoute({
      usdcFor: () => "0x1",
    }))).observe({ account_address: account });
    expect(badWord.providers.every((provider) =>
      provider.state === "unavailable" && provider.error_code === "malformed_rpc"
    )).toBe(true);
    expect(badWord.snapshot).toBeUndefined();
  });

  it("sanitizes partial failures, enforces deadlines, and honors caller abort", async () => {
    const secret = "https://apikey@secret.invalid/do-not-leak";
    const healthy = rpcFetch(standardRoute());
    const partialFetcher = (async (input, init) => {
      if (String(input).includes("one.invalid")) throw new Error(secret);
      return healthy(input, init);
    }) as typeof fetch;
    const partial = await makeObserver(partialFetcher).observe({ account_address: account });
    expect(partial.state).toBe("partial");
    expect(partial.providers[0]).toEqual({
      provider_id: "provider-one",
      state: "unavailable",
      error_code: "network_unavailable",
    });
    expect(JSON.stringify(partial)).not.toContain(secret);

    const hangingFetch = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
    })) as typeof fetch;
    const deadlineObserver = createBasePositionObserver({
      providers,
      fetch: hangingFetch,
      deadline_ms: 100,
    });
    const expired = await deadlineObserver.observe({ account_address: account });
    expect(expired.providers.every((provider) =>
      provider.state === "unavailable" && provider.error_code === "deadline_exceeded"
    )).toBe(true);

    const controller = new AbortController();
    const pending = createBasePositionObserver({ providers, fetch: hangingFetch }).observe(
      { account_address: account },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires exactly two provider IDs and independent HTTPS origins", () => {
    expect(() => createBasePositionObserver({
      providers: [
        { id: "same", url: "https://one.invalid/a" },
        { id: "same", url: "https://two.invalid/b" },
      ],
    })).toThrow(/distinct IDs/);
    expect(() => createBasePositionObserver({
      providers: [
        { id: "same-origin-a", url: "https://same.invalid/a?secret=one" },
        { id: "same-origin-b", url: "https://same.invalid/b?secret=two" },
      ],
    })).toThrow(/network origins/);
    expect(() => createBasePositionObserver({
      providers: [{ id: "only-one", url: "https://one.invalid" }],
    })).toThrow(/exactly two/);
    expect(() => createBasePositionObserver({
      providers: [
        { id: "insecure-a", url: "http://one.invalid" },
        { id: "secure-b", url: "https://two.invalid" },
      ],
    })).toThrow("Base position observer provider configuration is invalid.");
  });

  it("normalizes the account once and refuses malformed observation input", async () => {
    const mixed = account.toUpperCase().replace("0X", "0x");
    const calls: RpcRequest[] = [];
    const result = await makeObserver(rpcFetch(standardRoute({}, calls))).observe({
      account_address: mixed,
    });
    expect(result.account_address).toBe(account);
    expect(calls.filter((request) => request.method === "eth_getBalance").every(
      (request) => request.params[0] === account,
    )).toBe(true);

    await expect(makeObserver(rpcFetch(standardRoute())).observe({
      account_address: "not-an-address",
    })).rejects.toThrow("Base position observation request is invalid.");
  });
});
