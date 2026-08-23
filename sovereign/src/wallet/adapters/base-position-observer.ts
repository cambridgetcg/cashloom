/**
 * Read-only, finalized Base account position observer.
 *
 * The provider registry is fixed when this adapter is constructed. Observation
 * requests contain only an account address, so a caller cannot turn the
 * observer into an SSRF or credential-exfiltration capability. Two independent
 * RPC origins must prove the same canonical block and exact ETH/USDC balances
 * before this module emits a snapshot.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { isAddress, type Address } from "viem";
import { canonicalizeJson, type JsonValue } from "../domain/intent.ts";

export const BASE_POSITION_CHAIN_ID = "eip155:8453" as const;
export const BASE_POSITION_CHAIN_ID_HEX = "0x2105" as const;
export const BASE_ETH_ASSET_ID = "eip155:8453/slip44:60" as const;
export const BASE_NATIVE_USDC_ADDRESS =
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export const BASE_USDC_ASSET_ID =
  "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

const BASE_CHAIN_ID = 8453n;
const BALANCE_OF_SELECTOR = "70a08231";
const DEFAULT_PRIMARY_RPC = "https://mainnet.base.org";
const DEFAULT_CONFIRMATION_RPC = "https://base-rpc.publicnode.com";
const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface BasePositionRpcProviderConfig {
  readonly id: string;
  readonly url: string;
}

export interface BasePositionObserverDependencies {
  /** Fixed registry entries. They are never copied into observations/errors. */
  readonly providers?: readonly BasePositionRpcProviderConfig[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly deadline_ms?: number;
  readonly max_response_bytes?: number;
}

export interface BasePositionObservationRequest {
  readonly account_address: Address | string;
}

export interface BaseFinalizedBlockRef {
  /** Canonical unsigned base-10 integer. */
  readonly number: string;
  readonly hash: `0x${string}`;
  /** Exact Unix timestamp in seconds, as a canonical base-10 integer. */
  readonly timestamp: string;
}

export type BasePositionBalance =
  | {
      readonly asset: "ETH";
      readonly asset_id: typeof BASE_ETH_ASSET_ID;
      readonly atomic: string;
      readonly decimals: "18";
    }
  | {
      readonly asset: "USDC";
      readonly asset_id: typeof BASE_USDC_ASSET_ID;
      readonly atomic: string;
      readonly decimals: "6";
      readonly contract_address: typeof BASE_NATIVE_USDC_ADDRESS;
    };

export type BasePositionBalances = readonly [
  Extract<BasePositionBalance, { readonly asset: "ETH" }>,
  Extract<BasePositionBalance, { readonly asset: "USDC" }>,
];

export interface BasePositionEvidenceFields {
  readonly chain_id: typeof BASE_POSITION_CHAIN_ID;
  readonly account_address: Address;
  readonly security_level: "FINALIZED";
  readonly block: BaseFinalizedBlockRef;
  /** Stable order: native ETH, then native Circle USDC. */
  readonly balances: BasePositionBalances;
}

export interface BasePositionEvidence extends BasePositionEvidenceFields {
  readonly schema_version: "cashloom.base-position-evidence/1";
  readonly evidence_hash: `sha256:${string}`;
}

export interface BasePositionProviderSighting extends BasePositionEvidenceFields {
  readonly schema_version: "cashloom.base-position-sighting/1";
  readonly provider_id: string;
  /** SHA-256 of the normalized HTTPS origin; never the origin or RPC URL. */
  readonly provider_trust_domain: `sha256:${string}`;
  readonly evidence_hash: `sha256:${string}`;
  readonly observed_at: string;
  readonly fetched_at: string;
}

export type BasePositionProviderErrorCode =
  | "deadline_exceeded"
  | "network_unavailable"
  | "response_too_large"
  | "malformed_rpc"
  | "rpc_error"
  | "wrong_chain"
  | "finalized_head_unavailable"
  | "block_mismatch";

export type BasePositionProviderObservation =
  | {
      readonly provider_id: string;
      readonly state: "unavailable";
      readonly error_code: BasePositionProviderErrorCode;
    }
  | {
      /** A valid head was seen, but a peer failed before a common read began. */
      readonly provider_id: string;
      readonly state: "head_observed";
      readonly finalized_head: BaseFinalizedBlockRef;
    }
  | {
      readonly provider_id: string;
      readonly state: "observed";
      readonly sighting: BasePositionProviderSighting;
    };

export interface BaseFinalizedPositionSnapshot extends BasePositionEvidenceFields {
  readonly schema_version: "cashloom.base-position-snapshot/1";
  readonly evidence_hash: `sha256:${string}`;
  readonly provider_ids: readonly [string, string];
  readonly quorum: "2";
  readonly observed_at: string;
}

export interface BasePositionObservation {
  readonly schema_version: "cashloom.base-position-observation/1";
  readonly state: "settled" | "partial";
  readonly reason?: "provider_unavailable" | "provider_disagreement";
  readonly chain_id: typeof BASE_POSITION_CHAIN_ID;
  readonly account_address: Address;
  readonly observed_at: string;
  readonly providers: readonly [
    BasePositionProviderObservation,
    BasePositionProviderObservation,
  ];
  readonly sightings: readonly BasePositionProviderSighting[];
  readonly snapshot?: BaseFinalizedPositionSnapshot;
}

export interface BasePositionObserver {
  observe(
    request: BasePositionObservationRequest,
    signal?: AbortSignal,
  ): Promise<BasePositionObservation>;
}

interface ProviderContext {
  readonly config: ValidatedProvider;
  readonly rpc: JsonRpcClient;
}

interface ValidatedProvider extends BasePositionRpcProviderConfig {
  readonly trust_domain: `sha256:${string}`;
}

interface ProviderHead {
  readonly provider_id: string;
  readonly block: ParsedBlock;
}

type ProviderHeadResult =
  | { readonly state: "available"; readonly value: ProviderHead }
  | {
      readonly state: "unavailable";
      readonly provider_id: string;
      readonly error_code: BasePositionProviderErrorCode;
    };

type ProviderSightingResult =
  | { readonly state: "observed"; readonly sighting: BasePositionProviderSighting }
  | {
      readonly state: "unavailable";
      readonly provider_id: string;
      readonly error_code: BasePositionProviderErrorCode;
    };

type ProviderBlockResult =
  | {
      readonly state: "available";
      readonly provider_id: string;
      readonly block: ParsedBlock;
    }
  | {
      readonly state: "unavailable";
      readonly provider_id: string;
      readonly error_code: BasePositionProviderErrorCode;
    };

interface ParsedBlock {
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly timestamp: bigint;
}

class PositionEvidenceFault extends Error {
  constructor(readonly code: BasePositionProviderErrorCode) {
    super(code);
    this.name = "PositionEvidenceFault";
  }
}

class ExplicitAbort extends Error {
  constructor() {
    super("The operation was aborted.");
    this.name = "AbortError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

const parseQuantity = (
  value: unknown,
  code: BasePositionProviderErrorCode,
): bigint => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new PositionEvidenceFault(code);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new PositionEvidenceFault(code);
  }
  if (parsed < 0n || parsed > MAX_UINT256) throw new PositionEvidenceFault(code);
  return parsed;
};

const parseUint256Word = (
  value: unknown,
  code: BasePositionProviderErrorCode,
): bigint => {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new PositionEvidenceFault(code);
  }
  return BigInt(value);
};

const parseBlock = (
  value: unknown,
  code: BasePositionProviderErrorCode,
): ParsedBlock => {
  if (!isPlainObject(value)) throw new PositionEvidenceFault(code);
  if (typeof value.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(value.hash)) {
    throw new PositionEvidenceFault(code);
  }
  return {
    number: parseQuantity(value.number, code),
    hash: value.hash as `0x${string}`,
    timestamp: parseQuantity(value.timestamp, code),
  };
};

const blockRef = (block: ParsedBlock): BaseFinalizedBlockRef => ({
  number: block.number.toString(),
  hash: block.hash,
  timestamp: block.timestamp.toString(),
});

const sameBlock = (left: ParsedBlock, right: ParsedBlock): boolean =>
  left.number === right.number &&
  left.hash === right.hash &&
  left.timestamp === right.timestamp;

const hashEvidence = (
  value: Omit<BasePositionEvidence, "evidence_hash">,
): `sha256:${string}` =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(
    canonicalizeJson(value as unknown as JsonValue),
  )))}`;

const hashTrustDomain = (origin: string): `sha256:${string}` =>
  `sha256:${bytesToHex(sha256(utf8ToBytes(origin)))}`;

const toIso = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds)) throw new TypeError("Base position observer clock is invalid.");
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new TypeError("Base position observer clock is invalid.");
  }
};

const parseRequest = (request: BasePositionObservationRequest): Address => {
  if (
    !isPlainObject(request) ||
    !exactKeys(request, ["account_address"]) ||
    typeof request.account_address !== "string" ||
    !isAddress(request.account_address, { strict: false })
  ) {
    throw new TypeError("Base position observation request is invalid.");
  }
  return request.account_address.toLowerCase() as Address;
};

class JsonRpcClient {
  #id = 0;

  constructor(
    private readonly provider: ValidatedProvider,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly now: () => number,
    private readonly deadlineAt: number,
    private readonly maxResponseBytes: number,
    private readonly externalSignal?: AbortSignal,
  ) {}

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    if (this.externalSignal?.aborted) throw new ExplicitAbort();
    const remaining = this.deadlineAt - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new PositionEvidenceFault("deadline_exceeded");
    }
    const controller = new AbortController();
    let deadlineElapsed = false;
    const onExternalAbort = () => controller.abort();
    this.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
    }, remaining);
    const id = `${this.provider.id}:${++this.#id}`;
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.provider.url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        if (this.externalSignal?.aborted) throw new ExplicitAbort();
        if (deadlineElapsed) throw new PositionEvidenceFault("deadline_exceeded");
        throw new PositionEvidenceFault("network_unavailable");
      }
      if (!response.ok) throw new PositionEvidenceFault("network_unavailable");
      const contentType = response.headers.get("content-type");
      if (
        contentType === null ||
        !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)
      ) {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
          throw new PositionEvidenceFault("malformed_rpc");
        }
        if (BigInt(declaredLength) > BigInt(this.maxResponseBytes)) {
          throw new PositionEvidenceFault("response_too_large");
        }
      }
      const text = await this.#boundedText(
        response,
        () => deadlineElapsed,
      );
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      if (!isPlainObject(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id) {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      const keys = Object.keys(envelope);
      if (keys.some((key) => !["jsonrpc", "id", "result", "error"].includes(key))) {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      const hasResult = Object.prototype.hasOwnProperty.call(envelope, "result");
      const hasError = Object.prototype.hasOwnProperty.call(envelope, "error");
      if (hasResult === hasError || keys.length !== 3) {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      if (hasError) throw new PositionEvidenceFault("rpc_error");
      return envelope.result;
    } finally {
      clearTimeout(timeout);
      this.externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async #boundedText(
    response: Response,
    deadlineElapsed: () => boolean,
  ): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let output = "";
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          if (this.externalSignal?.aborted) throw new ExplicitAbort();
          if (deadlineElapsed()) throw new PositionEvidenceFault("deadline_exceeded");
          throw new PositionEvidenceFault("network_unavailable");
        }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new PositionEvidenceFault("response_too_large");
        }
        try {
          output += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new PositionEvidenceFault("malformed_rpc");
        }
      }
      try {
        output += decoder.decode();
      } catch {
        throw new PositionEvidenceFault("malformed_rpc");
      }
      return output;
    } finally {
      reader.releaseLock();
    }
  }
}

const defaultProviders = (): readonly BasePositionRpcProviderConfig[] => [
  {
    id: "base-primary",
    url: process.env.CASHLOOM_BASE_RPC_URL?.trim() || DEFAULT_PRIMARY_RPC,
  },
  {
    id: "base-confirmation",
    url: process.env.CASHLOOM_BASE_CONFIRMATION_RPC_URL?.trim() || DEFAULT_CONFIRMATION_RPC,
  },
];

const validateProviders = (
  providers: readonly BasePositionRpcProviderConfig[],
): readonly [ValidatedProvider, ValidatedProvider] => {
  if (!Array.isArray(providers) || providers.length !== 2) {
    throw new TypeError("Base position observer requires exactly two fixed providers.");
  }
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const origins = new Set<string>();
  const normalized = providers.map((provider) => {
    if (
      !isPlainObject(provider) ||
      !exactKeys(provider, ["id", "url"]) ||
      typeof provider.id !== "string" ||
      typeof provider.url !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(provider.id)
    ) {
      throw new TypeError("Base position observer provider configuration is invalid.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(provider.url);
    } catch {
      throw new TypeError("Base position observer provider configuration is invalid.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.hash !== ""
    ) {
      throw new TypeError("Base position observer provider configuration is invalid.");
    }
    if (
      ids.has(provider.id) ||
      endpoints.has(endpoint.href) ||
      origins.has(endpoint.origin)
    ) {
      throw new TypeError(
        "Base position observer providers must have distinct IDs, endpoints, and network origins.",
      );
    }
    ids.add(provider.id);
    endpoints.add(endpoint.href);
    origins.add(endpoint.origin);
    return Object.freeze({
      id: provider.id,
      url: endpoint.href,
      trust_domain: hashTrustDomain(endpoint.origin),
    });
  });
  return Object.freeze(normalized) as unknown as readonly [
    ValidatedProvider,
    ValidatedProvider,
  ];
};

const providerFailure = (
  providerId: string,
  error: unknown,
): ProviderHeadResult | ProviderSightingResult => ({
  state: "unavailable",
  provider_id: providerId,
  error_code: error instanceof PositionEvidenceFault ? error.code : "malformed_rpc",
});

const readFinalizedHead = async (context: ProviderContext): Promise<ProviderHeadResult> => {
  try {
    const rawChainId = await context.rpc.call("eth_chainId", []);
    if (parseQuantity(rawChainId, "wrong_chain") !== BASE_CHAIN_ID) {
      throw new PositionEvidenceFault("wrong_chain");
    }
    const rawHead = await context.rpc.call("eth_getBlockByNumber", ["finalized", false]);
    if (rawHead === null) throw new PositionEvidenceFault("finalized_head_unavailable");
    return {
      state: "available",
      value: {
        provider_id: context.config.id,
        block: parseBlock(rawHead, "finalized_head_unavailable"),
      },
    };
  } catch (error) {
    if (error instanceof ExplicitAbort) throw error;
    return providerFailure(context.config.id, error) as ProviderHeadResult;
  }
};

const balanceOfCalldata = (account: Address): `0x${string}` =>
  `0x${BALANCE_OF_SELECTOR}${account.slice(2).padStart(64, "0")}`;

const readTargetBlock = async (
  context: ProviderContext,
  targetNumber: bigint,
  finalizedHead: ParsedBlock,
): Promise<ProviderBlockResult> => {
  try {
    if (targetNumber > finalizedHead.number) {
      throw new PositionEvidenceFault("block_mismatch");
    }
    const targetTag = `0x${targetNumber.toString(16)}`;
    const rawBlock = await context.rpc.call("eth_getBlockByNumber", [targetTag, false]);
    if (rawBlock === null) throw new PositionEvidenceFault("block_mismatch");
    const candidate = parseBlock(rawBlock, "block_mismatch");
    if (candidate.number !== targetNumber) throw new PositionEvidenceFault("block_mismatch");
    if (targetNumber === finalizedHead.number && !sameBlock(candidate, finalizedHead)) {
      throw new PositionEvidenceFault("block_mismatch");
    }
    return {
      state: "available",
      provider_id: context.config.id,
      block: candidate,
    };
  } catch (error) {
    if (error instanceof ExplicitAbort) throw error;
    return providerFailure(context.config.id, error) as ProviderBlockResult;
  }
};

const evidenceBody = (
  account: Address,
  block: ParsedBlock,
  eth: bigint,
  usdc: bigint,
): Omit<BasePositionEvidence, "evidence_hash"> => ({
  schema_version: "cashloom.base-position-evidence/1",
  chain_id: BASE_POSITION_CHAIN_ID,
  account_address: account,
  security_level: "FINALIZED",
  block: blockRef(block),
  balances: [
    {
      asset: "ETH",
      asset_id: BASE_ETH_ASSET_ID,
      atomic: eth.toString(),
      decimals: "18",
    },
    {
      asset: "USDC",
      asset_id: BASE_USDC_ASSET_ID,
      atomic: usdc.toString(),
      decimals: "6",
      contract_address: BASE_NATIVE_USDC_ADDRESS,
    },
  ],
});

const readPositionSighting = async (
  context: ProviderContext,
  account: Address,
  targetBlock: ParsedBlock,
  observedAt: string,
  now: () => number,
): Promise<ProviderSightingResult> => {
  try {
    const targetTag = `0x${targetBlock.number.toString(16)}`;
    const [rawEth, rawUsdc] = await Promise.all([
      context.rpc.call("eth_getBalance", [account, targetTag]),
      context.rpc.call("eth_call", [{
        to: BASE_NATIVE_USDC_ADDRESS,
        data: balanceOfCalldata(account),
      }, targetTag]),
    ]);
    const eth = parseQuantity(rawEth, "malformed_rpc");
    const usdc = parseUint256Word(rawUsdc, "malformed_rpc");

    // Re-read the exact numbered block after both balances. A changed hash or
    // timestamp means the read straddled a reorg and cannot be persisted.
    const rawAfter = await context.rpc.call("eth_getBlockByNumber", [targetTag, false]);
    if (rawAfter === null) throw new PositionEvidenceFault("block_mismatch");
    const after = parseBlock(rawAfter, "block_mismatch");
    if (!sameBlock(targetBlock, after)) throw new PositionEvidenceFault("block_mismatch");

    const body = evidenceBody(account, targetBlock, eth, usdc);
    const sighting: BasePositionProviderSighting = {
      ...body,
      schema_version: "cashloom.base-position-sighting/1",
      provider_id: context.config.id,
      provider_trust_domain: context.config.trust_domain,
      evidence_hash: hashEvidence(body),
      observed_at: observedAt,
      fetched_at: toIso(now()),
    };
    return { state: "observed", sighting };
  } catch (error) {
    if (error instanceof ExplicitAbort) throw error;
    return providerFailure(context.config.id, error) as ProviderSightingResult;
  }
};

const unavailableObservation = (
  result: Extract<ProviderHeadResult | ProviderSightingResult, { readonly state: "unavailable" }>,
): BasePositionProviderObservation => ({
  provider_id: result.provider_id,
  state: "unavailable",
  error_code: result.error_code,
});

const partialFromHeads = (
  address: Address,
  observedAt: string,
  heads: readonly [ProviderHeadResult, ProviderHeadResult],
): BasePositionObservation => {
  const providers = heads.map((head): BasePositionProviderObservation =>
    head.state === "unavailable"
      ? unavailableObservation(head)
      : {
          provider_id: head.value.provider_id,
          state: "head_observed",
          finalized_head: blockRef(head.value.block),
        }
  ) as [BasePositionProviderObservation, BasePositionProviderObservation];
  return {
    schema_version: "cashloom.base-position-observation/1",
    state: "partial",
    reason: "provider_unavailable",
    chain_id: BASE_POSITION_CHAIN_ID,
    account_address: address,
    observed_at: observedAt,
    providers,
    sightings: [],
  };
};

const headObservations = (
  heads: readonly [
    Extract<ProviderHeadResult, { readonly state: "available" }>,
    Extract<ProviderHeadResult, { readonly state: "available" }>,
  ],
): [BasePositionProviderObservation, BasePositionProviderObservation] =>
  heads.map((head): BasePositionProviderObservation => ({
    provider_id: head.value.provider_id,
    state: "head_observed",
    finalized_head: blockRef(head.value.block),
  })) as [BasePositionProviderObservation, BasePositionProviderObservation];

export const createBasePositionObserver = (
  dependencies: BasePositionObserverDependencies = {},
): BasePositionObserver => {
  const providers = validateProviders(dependencies.providers ?? defaultProviders());
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const deadlineMs = dependencies.deadline_ms ?? DEFAULT_DEADLINE_MS;
  const maxResponseBytes = dependencies.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (typeof fetcher !== "function") {
    throw new TypeError("Base position observer fetch implementation is unavailable.");
  }
  if (typeof now !== "function") throw new TypeError("Base position observer clock is invalid.");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) {
    throw new TypeError("Base position observer deadline is invalid.");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < MIN_RESPONSE_BYTES ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new TypeError("Base position observer response limit is invalid.");
  }

  return Object.freeze({
    async observe(
      request: BasePositionObservationRequest,
      signal?: AbortSignal,
    ): Promise<BasePositionObservation> {
      if (signal?.aborted) throw new ExplicitAbort();
      const address = parseRequest(request);
      const startedAt = now();
      const observedAt = toIso(startedAt);
      const deadlineAt = startedAt + deadlineMs;
      if (!Number.isFinite(deadlineAt)) {
        throw new TypeError("Base position observer clock is invalid.");
      }
      const contexts = providers.map((provider): ProviderContext => ({
        config: provider,
        rpc: new JsonRpcClient(
          provider,
          fetcher,
          now,
          deadlineAt,
          maxResponseBytes,
          signal,
        ),
      })) as [ProviderContext, ProviderContext];

      const heads = await Promise.all(contexts.map(readFinalizedHead)) as [
        ProviderHeadResult,
        ProviderHeadResult,
      ];
      if (signal?.aborted) throw new ExplicitAbort();
      if (heads.some((head) => head.state === "unavailable")) {
        return partialFromHeads(address, observedAt, heads);
      }
      const firstHead = (heads[0] as Extract<ProviderHeadResult, { state: "available" }>).value;
      const secondHead = (heads[1] as Extract<ProviderHeadResult, { state: "available" }>).value;
      const targetNumber = firstHead.block.number < secondHead.block.number
        ? firstHead.block.number
        : secondHead.block.number;
      const availableHeads = heads as [
        Extract<ProviderHeadResult, { state: "available" }>,
        Extract<ProviderHeadResult, { state: "available" }>,
      ];
      const targetBlocks = await Promise.all([
        readTargetBlock(contexts[0], targetNumber, firstHead.block),
        readTargetBlock(contexts[1], targetNumber, secondHead.block),
      ]) as [ProviderBlockResult, ProviderBlockResult];
      if (signal?.aborted) throw new ExplicitAbort();
      if (targetBlocks.some((result) => result.state === "unavailable")) {
        const blockProviders = targetBlocks.map((result, index): BasePositionProviderObservation =>
          result.state === "unavailable"
            ? unavailableObservation(result)
            : headObservations(availableHeads)[index]!
        ) as [BasePositionProviderObservation, BasePositionProviderObservation];
        return {
          schema_version: "cashloom.base-position-observation/1",
          state: "partial",
          reason: "provider_unavailable",
          chain_id: BASE_POSITION_CHAIN_ID,
          account_address: address,
          observed_at: observedAt,
          providers: blockProviders,
          sightings: [],
        };
      }
      const firstTarget = (targetBlocks[0] as Extract<ProviderBlockResult, {
        state: "available";
      }>).block;
      const secondTarget = (targetBlocks[1] as Extract<ProviderBlockResult, {
        state: "available";
      }>).block;
      if (!sameBlock(firstTarget, secondTarget)) {
        return {
          schema_version: "cashloom.base-position-observation/1",
          state: "partial",
          reason: "provider_disagreement",
          chain_id: BASE_POSITION_CHAIN_ID,
          account_address: address,
          observed_at: observedAt,
          providers: headObservations(availableHeads),
          sightings: [],
        };
      }
      const results = await Promise.all([
        readPositionSighting(
          contexts[0],
          address,
          firstTarget,
          observedAt,
          now,
        ),
        readPositionSighting(
          contexts[1],
          address,
          firstTarget,
          observedAt,
          now,
        ),
      ]) as [ProviderSightingResult, ProviderSightingResult];
      if (signal?.aborted) throw new ExplicitAbort();
      const sightings = results.flatMap((result) =>
        result.state === "observed" ? [result.sighting] : []
      );
      const providerObservations = results.map((result): BasePositionProviderObservation =>
        result.state === "observed"
          ? {
              provider_id: result.sighting.provider_id,
              state: "observed",
              sighting: result.sighting,
            }
          : unavailableObservation(result)
      ) as [BasePositionProviderObservation, BasePositionProviderObservation];
      if (results.some((result) => result.state === "unavailable")) {
        return {
          schema_version: "cashloom.base-position-observation/1",
          state: "partial",
          reason: "provider_unavailable",
          chain_id: BASE_POSITION_CHAIN_ID,
          account_address: address,
          observed_at: observedAt,
          providers: providerObservations,
          sightings,
        };
      }
      const first = (results[0] as Extract<ProviderSightingResult, { state: "observed" }>).sighting;
      const second = (results[1] as Extract<ProviderSightingResult, { state: "observed" }>).sighting;
      if (first.evidence_hash !== second.evidence_hash) {
        return {
          schema_version: "cashloom.base-position-observation/1",
          state: "partial",
          reason: "provider_disagreement",
          chain_id: BASE_POSITION_CHAIN_ID,
          account_address: address,
          observed_at: observedAt,
          providers: providerObservations,
          sightings,
        };
      }
      const providerIds = [first.provider_id, second.provider_id].sort() as [string, string];
      const snapshot: BaseFinalizedPositionSnapshot = {
        schema_version: "cashloom.base-position-snapshot/1",
        chain_id: BASE_POSITION_CHAIN_ID,
        account_address: address,
        security_level: "FINALIZED",
        block: first.block,
        balances: first.balances,
        evidence_hash: first.evidence_hash,
        provider_ids: providerIds,
        quorum: "2",
        observed_at: observedAt,
      };
      return {
        schema_version: "cashloom.base-position-observation/1",
        state: "settled",
        chain_id: BASE_POSITION_CHAIN_ID,
        account_address: address,
        observed_at: observedAt,
        providers: providerObservations,
        sightings,
        snapshot,
      };
    },
  });
};
