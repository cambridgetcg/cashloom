/**
 * Bounded, registry-routed, read-only chain transports.
 *
 * This module intentionally has no API that accepts an endpoint URL. Endpoints
 * are resolved only through the fixed registry and server environment. Errors,
 * receipts, and JSON representations never include configured connection data.
 */

import {
  blockchainRpcReceipt,
  isEvmChain,
  requireBlockchainChain,
} from "./registry.ts";
import type {
  BitcoinFeeEstimate,
  BitcoinMempoolSnapshot,
  BitcoinReferenceBlock,
  BlockchainRpcErrorCode,
  ChainRegistryEntry,
  EvmCallsAtReference,
  EvmReadCall,
  EvmReadMethod,
  EvmReadResult,
  EvmReferenceBlock,
  EvmReferenceTag,
  HexData,
  HexQuantity,
  JsonValue,
  ReferenceBlock,
  RpcCallOptions,
  SolanaPerformanceSamples,
  SolanaPrioritizationFees,
  SolanaReadMethod,
  SolanaReferenceBlock,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const IDENTITY_CACHE_MS = 5 * 60_000;
const MAX_EVM_CALLS = 32;
const MAX_CALLDATA_BYTES = 64 * 1024;
const FALLBACK_CONCURRENCY = 4;
const TIMEOUT_SENTINEL = Symbol("rpc-timeout");
const ABORT_SENTINEL = Symbol("rpc-abort");

const DEFAULT_ENDPOINTS: Readonly<Record<ChainRegistryEntry["key"], string>> = Object.freeze({
  bitcoin: "https://blockstream.info/api",
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://optimism-rpc.publicnode.com",
  polygon: "https://polygon.drpc.org",
  bsc: "https://bsc-dataseed.bnbchain.org",
  solana: "https://api.mainnet.solana.com",
});

interface InternalRpcTarget {
  readonly entry: ChainRegistryEntry;
  readonly receipt: ReturnType<typeof blockchainRpcReceipt>;
  endpointForTransport(): string;
  cacheKeyForTransport(): string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BlockchainRpcRuntime {
  fetch?: FetchLike;
  env?: Readonly<Record<string, string | undefined>>;
  /** Millisecond Unix clock, injectable for deterministic receipts/cache tests. */
  clock?: () => number;
  timeout_ms?: number;
  max_request_bytes?: number;
  max_response_bytes?: number;
  cache_entries?: number;
}

interface SafeErrorContext {
  chain?: string;
  method?: string;
  http_status?: number;
  remote_code?: number;
  expected_chain_id?: string;
  actual_chain_id?: string;
}

export class BlockchainRpcError extends Error {
  readonly code: BlockchainRpcErrorCode;
  readonly chain?: string;
  readonly method?: string;
  readonly http_status?: number;
  readonly remote_code?: number;
  readonly expected_chain_id?: string;
  readonly actual_chain_id?: string;

  constructor(code: BlockchainRpcErrorCode, context: SafeErrorContext = {}) {
    // Only fixed codes and registry/method identifiers enter the message. In
    // particular, neither an endpoint nor an upstream error string is retained.
    super(`${code}${context.chain ? ` (${context.chain}${context.method ? ` ${context.method}` : ""})` : ""}`);
    this.name = "BlockchainRpcError";
    this.code = code;
    this.chain = context.chain;
    this.method = context.method;
    this.http_status = context.http_status;
    this.remote_code = context.remote_code;
    this.expected_chain_id = context.expected_chain_id;
    this.actual_chain_id = context.actual_chain_id;
  }

  toJSON() {
    return {
      error: this.code,
      ...(this.chain ? { chain: this.chain } : {}),
      ...(this.method ? { method: this.method } : {}),
      ...(this.http_status !== undefined ? { http_status: this.http_status } : {}),
      ...(this.remote_code !== undefined ? { remote_code: this.remote_code } : {}),
      ...(this.expected_chain_id ? { expected_chain_id: this.expected_chain_id } : {}),
      ...(this.actual_chain_id ? { actual_chain_id: this.actual_chain_id } : {}),
    };
  }
}

interface CachedValue {
  expiresAt: number;
  value: unknown;
}

interface InflightValue {
  token: object;
  promise: Promise<unknown>;
}

/**
 * Small bounded success cache with in-flight de-duplication per exact resource
 * key. Failed loads are never cached. Instances are isolated from one another.
 */
export class ResourceCache {
  readonly #values = new Map<string, CachedValue>();
  readonly #inflight = new Map<string, InflightValue>();
  readonly #maxEntries: number;
  readonly #clock: () => number;

  constructor(options: { max_entries?: number; clock?: () => number } = {}) {
    const max = options.max_entries ?? 256;
    if (!Number.isSafeInteger(max) || max < 1 || max > 10_000) {
      throw new Error("cache max_entries must be an integer from 1 to 10000");
    }
    this.#maxEntries = max;
    this.#clock = options.clock ?? Date.now;
  }

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (!key || key.length > 8192 || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
      throw new Error("invalid cache resource key or ttl");
    }
    const now = this.#clock();
    const hit = this.#values.get(key);
    if (hit && hit.expiresAt > now) {
      // LRU touch.
      this.#values.delete(key);
      this.#values.set(key, hit);
      return hit.value as T;
    }
    if (hit) this.#values.delete(key);

    const active = this.#inflight.get(key);
    if (active) return active.promise as Promise<T>;

    const token = {};
    let promise: Promise<T>;
    promise = load()
      .then((value) => {
        // A delete/clear removes the token. An older loader can then settle for
        // its original caller, but it cannot repopulate or evict newer state.
        if (ttlMs > 0 && this.#inflight.get(key)?.token === token) {
          this.#values.set(key, { expiresAt: this.#clock() + ttlMs, value });
          while (this.#values.size > this.#maxEntries) {
            const oldest = this.#values.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#values.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        if (this.#inflight.get(key)?.token === token) this.#inflight.delete(key);
      });
    this.#inflight.set(key, { token, promise });
    return promise;
  }

  delete(key: string): void {
    this.#values.delete(key);
    this.#inflight.delete(key);
  }

  clear(): void {
    this.#values.clear();
    this.#inflight.clear();
  }

  get size(): number {
    return this.#values.size;
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: readonly JsonValue[];
}

interface JsonRpcObject {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

const EVM_METHODS = new Set<EvmReadMethod>([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
]);

const SOLANA_METHODS = new Set<SolanaReadMethod>([
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockTime",
  "getGenesisHash",
  "getLatestBlockhash",
  "getRecentPerformanceSamples",
  "getRecentPrioritizationFees",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenSupply",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_TIMEOUT_MS) {
    throw new BlockchainRpcError("RPC_INVALID_CALL");
  }
  return selected;
}

function normalizeResponseCap(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > HARD_MAX_RESPONSE_BYTES) {
    throw new BlockchainRpcError("RPC_INVALID_CALL");
  }
  return selected;
}

function parseHexQuantity(value: unknown, context: SafeErrorContext): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  return BigInt(value);
}

export function hexQuantityToBigInt(value: HexQuantity): bigint {
  return parseHexQuantity(value, {});
}

export function bigIntToHexQuantity(value: bigint): HexQuantity {
  if (value < 0n) throw new BlockchainRpcError("RPC_INVALID_CALL");
  return `0x${value.toString(16)}`;
}

function parseHexData(value: unknown, context: SafeErrorContext, bytes?: number): HexData {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  return value.toLowerCase() as HexData;
}

function safeUnixTime(seconds: bigint, context: SafeErrorContext): { unix_seconds: `${bigint}`; iso: string } {
  if (seconds < 0n || seconds > 8_640_000_000_000n) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  const date = new Date(Number(seconds * 1000n));
  if (Number.isNaN(date.getTime())) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  return { unix_seconds: seconds.toString() as `${bigint}`, iso: date.toISOString() };
}

function safeJsonInteger(value: unknown, context: SafeErrorContext): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  return BigInt(value);
}

function parseJsonObject(text: string, context: SafeErrorContext): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  if (!isObject(parsed)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  return parsed;
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function jsonStringEnd(text: string, start: number, context: SafeErrorContext): number {
  if (text[start] !== '"') throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index + 1;
  }
  throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
}

function jsonValueEnd(text: string, start: number, context: SafeErrorContext): number {
  if (text[start] === '"') return jsonStringEnd(text, start, context);
  if (text[start] === "{" || text[start] === "[") {
    const stack = [text[start]];
    let inString = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        const open = stack.pop();
        if ((open === "{" && char !== "}") || (open === "[" && char !== "]")) {
          throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
        }
        if (stack.length === 0) return index + 1;
      }
    }
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  let index = start;
  while (index < text.length && text[index] !== "," && text[index] !== "}") index += 1;
  return index;
}

function exactTopLevelNumberToken(
  text: string,
  wantedKey: string,
  context: SafeErrorContext,
): string {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  index += 1;
  let found: string | undefined;
  while (true) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") break;
    const keyStart = index;
    const keyEnd = jsonStringEnd(text, keyStart, context);
    let key: unknown;
    try { key = JSON.parse(text.slice(keyStart, keyEnd)); } catch {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    index = skipJsonWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = jsonValueEnd(text, valueStart, context);
    if (key === wantedKey) {
      if (found !== undefined) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      found = text.slice(valueStart, valueEnd).trim();
    }
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") break;
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  if (found === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(found)) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  return found;
}

function exactFeeEstimateAtThreeBlocks(text: string, context: SafeErrorContext): string {
  const body = parseJsonObject(text, context);
  if (typeof body["3"] !== "number" || !Number.isFinite(body["3"]) || body["3"] < 0) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  // Preserve the top-level source token without round-tripping through a
  // binary float. The scanner skips nested values and rejects duplicate keys.
  return exactTopLevelNumberToken(text, "3", context);
}

function validateBoundedSolanaParams(
  method: SolanaReadMethod,
  params: readonly JsonValue[],
  context: SafeErrorContext,
): void {
  if (method === "getRecentPerformanceSamples") {
    if (params.length !== 1 || typeof params[0] !== "number" ||
        !Number.isSafeInteger(params[0]) || params[0] < 1 || params[0] > 60) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", context);
    }
  }
  if (method === "getRecentPrioritizationFees") {
    if (params.length !== 1 || !Array.isArray(params[0]) || params[0].length > 16 ||
        params[0].some((address) => typeof address !== "string" ||
          !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", context);
    }
  }
}

function validRemoteError(error: unknown): error is { code: number; message: string } {
  return isObject(error) && typeof error.code === "number" && Number.isSafeInteger(error.code) &&
    typeof error.message === "string";
}

function remoteCode(error: unknown): number | undefined {
  return validRemoteError(error) ? error.code : undefined;
}

function assertJsonRpcResult(value: unknown, id: number, context: SafeErrorContext): unknown {
  if (!isObject(value)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  const body = value as JsonRpcObject;
  if (body.jsonrpc !== "2.0" || body.id !== id) {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
  const hasError = Object.prototype.hasOwnProperty.call(body, "error");
  const hasResult = Object.prototype.hasOwnProperty.call(body, "result");
  if (hasError === hasResult) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  if (hasError) {
    if (!validRemoteError(body.error)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    throw new BlockchainRpcError("RPC_REMOTE_ERROR", {
      ...context,
      remote_code: body.error.code,
    });
  }
  return body.result;
}

async function readBounded(
  response: Response,
  cap: number,
  context: SafeErrorContext,
  signal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(cap)) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new BlockchainRpcError("RPC_RESPONSE_TOO_LARGE", context);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new BlockchainRpcError("RPC_RESPONSE_TOO_LARGE", context);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BlockchainRpcError) throw error;
    throw new BlockchainRpcError("RPC_NETWORK_ERROR", context);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
}

interface TransportRuntime {
  fetch: FetchLike;
  clock: () => number;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  env: Readonly<Record<string, string | undefined>>;
}

async function boundedFetch(
  runtime: TransportRuntime,
  target: InternalRpcTarget,
  url: string,
  init: RequestInit,
  options: RpcCallOptions,
  context: SafeErrorContext,
): Promise<{ response: Response; text: string }> {
  const timeoutMs = normalizeTimeout(options.timeout_ms, runtime.timeoutMs);
  const responseCap = normalizeResponseCap(options.max_response_bytes, runtime.maxResponseBytes);
  if (options.signal?.aborted) throw new BlockchainRpcError("RPC_ABORTED", context);

  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: ((reason: symbol) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort?.(ABORT_SENTINEL);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let rejectTimeout: ((reason: symbol) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(TIMEOUT_SENTINEL);
    }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await Promise.race([
        runtime.fetch(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
        aborted,
      ]);
    } catch (error) {
      if (error === ABORT_SENTINEL || options.signal?.aborted) {
        throw new BlockchainRpcError("RPC_ABORTED", context);
      }
      if (error === TIMEOUT_SENTINEL || timedOut) throw new BlockchainRpcError("RPC_TIMEOUT", context);
      throw new BlockchainRpcError("RPC_NETWORK_ERROR", context);
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new BlockchainRpcError("RPC_HTTP_STATUS", {
        ...context,
        http_status: response.status,
      });
    }
    const text = await Promise.race([
      readBounded(response, responseCap, context, controller.signal),
      deadline,
      aborted,
    ]);
    return { response, text };
  } catch (error) {
    if (error === ABORT_SENTINEL || options.signal?.aborted) {
      throw new BlockchainRpcError("RPC_ABORTED", context);
    }
    if (error === TIMEOUT_SENTINEL || timedOut) throw new BlockchainRpcError("RPC_TIMEOUT", context);
    if (error instanceof BlockchainRpcError) throw error;
    throw new BlockchainRpcError("RPC_NETWORK_ERROR", context);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    // Keep `target` in the signature to make endpoint provenance explicit; do
    // not interpolate or attach it to an error.
    void target;
  }
}

async function postJson(
  runtime: TransportRuntime,
  target: InternalRpcTarget,
  payload: JsonRpcRequest | readonly JsonRpcRequest[],
  options: RpcCallOptions,
  context: SafeErrorContext,
): Promise<unknown> {
  let encoded: string;
  try { encoded = JSON.stringify(payload); } catch {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  if (new TextEncoder().encode(encoded).byteLength > runtime.maxRequestBytes) {
    throw new BlockchainRpcError("RPC_REQUEST_TOO_LARGE", context);
  }
  const { text } = await boundedFetch(
    runtime,
    target,
    target.endpointForTransport(),
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: encoded,
    },
    options,
    context,
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
  }
}

function appendFixedPath(endpoint: string, path: string): string {
  // `path` is always a literal generated inside this module, never user input.
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url.toString();
}

function checkedTransportEndpoint(raw: string): string {
  if (!raw || raw.length > 4096) throw new Error("RPC_CONFIGURATION_INVALID");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("RPC_CONFIGURATION_INVALID"); }
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) throw new Error("RPC_CONFIGURATION_INVALID");
  if (url.username || url.password || url.hash) throw new Error("RPC_CONFIGURATION_INVALID");
  return raw.replace(/\/+$/, "");
}

function targetFor(runtime: TransportRuntime, selector: string): InternalRpcTarget {
  try {
    const entry = requireBlockchainChain(selector);
    const configured = runtime.env[entry.rpc_env]?.trim();
    const endpoint = checkedTransportEndpoint(configured || DEFAULT_ENDPOINTS[entry.key]);
    const receipt = blockchainRpcReceipt(selector, runtime.env);
    return Object.freeze({
      entry,
      receipt,
      endpointForTransport: () => endpoint,
      cacheKeyForTransport: () => `${entry.caip2}\u0000${endpoint}`,
    });
  } catch (error) {
    const code = error instanceof Error && error.message === "CHAIN_NOT_FOUND"
      ? "CHAIN_NOT_FOUND"
      : "RPC_CONFIGURATION_INVALID";
    throw new BlockchainRpcError(code);
  }
}

function familyTarget(
  runtime: TransportRuntime,
  selector: string,
  family: ChainRegistryEntry["family"],
): InternalRpcTarget {
  const target = targetFor(runtime, selector);
  if (target.entry.family !== family) {
    throw new BlockchainRpcError("CHAIN_FAMILY_MISMATCH", { chain: target.entry.caip2 });
  }
  return target;
}

function shouldFallbackTag(error: unknown): boolean {
  return error instanceof BlockchainRpcError &&
    error.code === "RPC_REMOTE_ERROR" &&
    error.remote_code === -32602;
}

function canFallbackBatch(error: unknown): boolean {
  return error instanceof BlockchainRpcError && (
    error.code === "RPC_BATCH_UNSUPPORTED" ||
    error.code === "RPC_REMOTE_ERROR" ||
    (error.code === "RPC_HTTP_STATUS" &&
      (error.http_status === 400 || error.http_status === 405 || error.http_status === 415))
  );
}

function validateEvmCall(call: EvmReadCall, seen: Set<string>, chain: string): void {
  const context = { chain, method: "eth_call" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(call.key) || seen.has(call.key)) {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  seen.add(call.key);
  if (!/^0x[0-9a-fA-F]{40}$/.test(call.to)) {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data) || (call.data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
}

function isEvmBlockSelector(value: JsonValue | undefined): boolean {
  if (typeof value === "string") {
    return value === "finalized" || value === "safe" || value === "latest" ||
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
  }
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("blockHash") && keys.includes("requireCanonical") &&
    typeof value.blockHash === "string" && /^0x[0-9a-f]{64}$/i.test(value.blockHash) &&
    value.requireCanonical === true;
}

function isAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

function validateEvmReadParams(
  method: EvmReadMethod,
  params: readonly JsonValue[],
  chain: string,
): void {
  const invalid = () => { throw new BlockchainRpcError("RPC_INVALID_CALL", { chain, method }); };
  if (method === "eth_chainId" || method === "eth_blockNumber" || method === "eth_gasPrice") {
    if (params.length !== 0) invalid();
    return;
  }
  if (method === "eth_getBlockByNumber") {
    if (params.length !== 2 || !isEvmBlockSelector(params[0]) || params[1] !== false) invalid();
    return;
  }
  if (method === "eth_call") {
    if (params.length !== 2 || !isObject(params[0]) || !isEvmBlockSelector(params[1])) invalid();
    const call = params[0] as Record<string, unknown>;
    if (Object.keys(call).some((key) => key !== "to" && key !== "data") ||
        !isAddress(call.to) || typeof call.data !== "string" ||
        !/^0x(?:[0-9a-f]{2})*$/i.test(call.data) || (call.data.length - 2) / 2 > MAX_CALLDATA_BYTES) invalid();
    return;
  }
  if (method === "eth_getBalance" || method === "eth_getCode" || method === "eth_getTransactionCount") {
    if (params.length !== 2 || !isAddress(params[0]) || !isEvmBlockSelector(params[1])) invalid();
    return;
  }
  if (method === "eth_getStorageAt") {
    if (params.length !== 3 || !isAddress(params[0]) ||
        typeof params[1] !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(params[1]) ||
        !isEvmBlockSelector(params[2])) invalid();
    return;
  }
  invalid();
}

function validateSuppliedReference(target: InternalRpcTarget, reference: EvmReferenceBlock): void {
  const context = { chain: target.entry.caip2, method: "eth_call" };
  if (reference.family !== "evm" || reference.chain !== target.entry.caip2 ||
      reference.chain_key !== target.entry.key || reference.height_kind !== "block-number") {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  const height = parseHexQuantity(reference.height_hex, context);
  if (height.toString() !== reference.height || !/^0x[0-9a-f]{64}$/i.test(reference.hash)) {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  if (reference.block_time !== null) {
    if (!/^\d+$/.test(reference.block_time.unix_seconds)) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", context);
    }
    const expected = safeUnixTime(BigInt(reference.block_time.unix_seconds), context);
    if (expected.iso !== reference.block_time.iso) throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
  const fetchedAt = typeof reference.fetched_at === "string" ? Date.parse(reference.fetched_at) : NaN;
  if (!Number.isFinite(fetchedAt) || new Date(fetchedAt).toISOString() !== reference.fetched_at) {
    throw new BlockchainRpcError("RPC_INVALID_CALL", context);
  }
}

function immutableReferenceCopy(
  target: InternalRpcTarget,
  reference: EvmReferenceBlock,
): EvmReferenceBlock {
  validateSuppliedReference(target, reference);
  return deepFreeze({
    ...reference,
    hash: reference.hash.toLowerCase() as HexData,
    block_time: reference.block_time ? { ...reference.block_time } : null,
    finality: {
      ...reference.finality,
      attempts: reference.finality.attempts.map((attempt) => ({ ...attempt })),
    },
    // Never propagate a caller-supplied provider receipt.
    source: target.receipt,
  });
}

async function parallelMapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await run(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export interface BlockchainRpcClient {
  getReferenceBlock(selector: string, options?: RpcCallOptions): Promise<ReferenceBlock>;
  evmRead(
    selector: string,
    method: EvmReadMethod,
    params?: readonly JsonValue[],
    options?: RpcCallOptions,
  ): Promise<unknown>;
  evmCallsAtReference(
    selector: string,
    calls: readonly EvmReadCall[],
    reference?: EvmReferenceBlock,
    options?: RpcCallOptions,
  ): Promise<EvmCallsAtReference>;
  bitcoinMempool(
    selector?: "bitcoin" | string,
    options?: RpcCallOptions,
  ): Promise<BitcoinMempoolSnapshot>;
  bitcoinFeeEstimate(
    selector?: "bitcoin" | string,
    options?: RpcCallOptions,
  ): Promise<BitcoinFeeEstimate>;
  solanaRead(
    selector: "solana" | string,
    method: SolanaReadMethod,
    params?: readonly JsonValue[],
    options?: RpcCallOptions,
  ): Promise<unknown>;
  solanaPerformanceSamples(
    selector?: "solana" | string,
    limit?: number,
    options?: RpcCallOptions,
  ): Promise<SolanaPerformanceSamples>;
  solanaPrioritizationFees(
    selector?: "solana" | string,
    writableAccounts?: readonly string[],
    options?: RpcCallOptions,
  ): Promise<SolanaPrioritizationFees>;
}

export function createBlockchainRpcClient(config: BlockchainRpcRuntime = {}): BlockchainRpcClient {
  const runtime: TransportRuntime = {
    fetch: config.fetch ?? fetch,
    env: config.env ?? process.env,
    clock: config.clock ?? Date.now,
    timeoutMs: normalizeTimeout(config.timeout_ms, DEFAULT_TIMEOUT_MS),
    maxRequestBytes: config.max_request_bytes ?? DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes: normalizeResponseCap(config.max_response_bytes, DEFAULT_MAX_RESPONSE_BYTES),
  };
  if (!Number.isSafeInteger(runtime.maxRequestBytes) || runtime.maxRequestBytes < 1 ||
      runtime.maxRequestBytes > DEFAULT_MAX_REQUEST_BYTES) {
    throw new BlockchainRpcError("RPC_INVALID_CALL");
  }
  const referenceCache = new ResourceCache({
    max_entries: config.cache_entries ?? 64,
    clock: runtime.clock,
  });
  const identityCache = new ResourceCache({
    max_entries: config.cache_entries ?? 64,
    clock: runtime.clock,
  });
  // Capability boundary: only immutable EVM references observed by this exact
  // client instance may be reused without another header/finality lookup.
  const issuedEvmReferences = new WeakSet<object>();
  let requestId = 0;

  function nextId(): number {
    requestId = requestId >= Number.MAX_SAFE_INTEGER - 1 ? 1 : requestId + 1;
    return requestId;
  }

  async function rawRpc(
    target: InternalRpcTarget,
    method: string,
    params: readonly JsonValue[] = [],
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    const id = nextId();
    const context = { chain: target.entry.caip2, method };
    const body = await postJson(runtime, target, { jsonrpc: "2.0", id, method, params }, options, context);
    return assertJsonRpcResult(body, id, context);
  }

  async function rawRpcBatch(
    target: InternalRpcTarget,
    calls: readonly EvmReadCall[],
    block: JsonValue,
    options: RpcCallOptions,
  ): Promise<EvmReadResult[]> {
    const context = { chain: target.entry.caip2, method: "eth_call(batch)" };
    const requests = calls.map((call) => ({
      jsonrpc: "2.0" as const,
      id: nextId(),
      method: "eth_call",
      params: [{ to: call.to, data: call.data }, block] as readonly JsonValue[],
    }));
    const body = await postJson(runtime, target, requests, options, context);
    if (isObject(body)) {
      const hasResult = Object.prototype.hasOwnProperty.call(body, "result");
      const hasError = Object.prototype.hasOwnProperty.call(body, "error");
      if (body.jsonrpc !== "2.0" || hasResult || !hasError || !validRemoteError(body.error)) {
        throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      }
      if (body.error.code === -32600 || body.error.code === -32601) {
        throw new BlockchainRpcError("RPC_BATCH_UNSUPPORTED", context);
      }
      throw new BlockchainRpcError("RPC_REMOTE_ERROR", {
        ...context,
        remote_code: body.error.code,
      });
    }
    if (!Array.isArray(body)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    if (body.length !== requests.length) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);

    const byId = new Map<number, unknown>();
    for (const item of body) {
      if (!isObject(item) || typeof item.id !== "number" || !Number.isSafeInteger(item.id) || byId.has(item.id)) {
        throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      }
      byId.set(item.id, item);
    }
    const allBatchInvalid = requests.every((request) => {
      const item = byId.get(request.id);
      return isObject(item) && item.jsonrpc === "2.0" && item.id === request.id &&
        !Object.prototype.hasOwnProperty.call(item, "result") && validRemoteError(item.error) &&
        (item.error.code === -32600 || item.error.code === -32601);
    });
    if (allBatchInvalid) throw new BlockchainRpcError("RPC_BATCH_UNSUPPORTED", context);

    return requests.map((request, index) => {
      const item = byId.get(request.id);
      if (item === undefined) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      const result = assertJsonRpcResult(item, request.id, context);
      return {
        key: calls[index].key,
        data: parseHexData(result, context),
      };
    });
  }

  async function executeEvmCalls(
    target: InternalRpcTarget,
    calls: readonly EvmReadCall[],
    block: JsonValue,
    options: RpcCallOptions,
  ): Promise<{ results: EvmReadResult[]; transport: EvmCallsAtReference["transport"] }> {
    try {
      return {
        results: await rawRpcBatch(target, calls, block, options),
        transport: "json-rpc-batch",
      };
    } catch (error) {
      if (!canFallbackBatch(error)) throw error;
      // A batch-level or entry-level provider error is retried as a bounded set
      // of individual reads. A real contract revert therefore still surfaces
      // from its individual call instead of being mistaken for batch trouble.
      const results = await parallelMapBounded(calls, FALLBACK_CONCURRENCY, async (call) => {
        const raw = await rawRpc(target, "eth_call", [
          { to: call.to, data: call.data },
          block,
        ], options);
        return {
          key: call.key,
          data: parseHexData(raw, { chain: target.entry.caip2, method: "eth_call" }),
        };
      });
      return { results, transport: "parallel-fallback" };
    }
  }

  async function assertCanonicalReference(
    target: InternalRpcTarget,
    reference: EvmReferenceBlock,
    options: RpcCallOptions,
  ): Promise<void> {
    const context = { chain: target.entry.caip2, method: "eth_getBlockByNumber" };
    const raw = await rawRpc(target, "eth_getBlockByNumber", [reference.height_hex, false], options);
    if (!isObject(raw)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    const height = parseHexQuantity(raw.number, context);
    const hash = parseHexData(raw.hash, context, 32);
    if (height.toString() !== reference.height || hash !== reference.hash.toLowerCase()) {
      throw new BlockchainRpcError("RPC_REFERENCE_UNAVAILABLE", context);
    }
  }

  async function supportsHashPinnedEthCall(
    target: InternalRpcTarget,
    selector: JsonValue,
    options: RpcCallOptions,
  ): Promise<boolean> {
    try {
      const result = await rawRpc(target, "eth_call", [{
        to: "0x0000000000000000000000000000000000000000",
        data: "0x",
      }, selector], options);
      parseHexData(result, { chain: target.entry.caip2, method: "eth_call" });
      return true;
    } catch (error) {
      if (error instanceof BlockchainRpcError && error.code === "RPC_REMOTE_ERROR") return false;
      throw error;
    }
  }

  async function ensureEvmIdentity(target: InternalRpcTarget, options: RpcCallOptions): Promise<HexQuantity> {
    if (!isEvmChain(target.entry)) {
      throw new BlockchainRpcError("CHAIN_FAMILY_MISMATCH", { chain: target.entry.caip2 });
    }
    const expectedChainId = target.entry.evm_chain_id;
    const load = async () => {
      const context = { chain: target.entry.caip2, method: "eth_chainId" };
      const raw = await rawRpc(target, "eth_chainId", [], options);
      const actual = parseHexQuantity(raw, context);
      const expected = BigInt(expectedChainId);
      if (actual !== expected) {
        throw new BlockchainRpcError("RPC_CHAIN_MISMATCH", {
          ...context,
          expected_chain_id: expected.toString(),
          actual_chain_id: actual.toString(),
        });
      }
      return bigIntToHexQuantity(actual);
    };
    if (options.signal || options.timeout_ms || options.max_response_bytes) return load();
    return identityCache.get(`evm-id\u0000${target.cacheKeyForTransport()}`, IDENTITY_CACHE_MS, load);
  }

  async function ensureSolanaIdentity(target: InternalRpcTarget, options: RpcCallOptions): Promise<void> {
    const load = async () => {
      const context = { chain: target.entry.caip2, method: "getGenesisHash" };
      const actual = await rawRpc(target, "getGenesisHash", [], options);
      if (typeof actual !== "string" || actual !== target.entry.genesis_hash) {
        throw new BlockchainRpcError("RPC_CHAIN_MISMATCH", { ...context });
      }
    };
    if (options.signal || options.timeout_ms || options.max_response_bytes) return load();
    return identityCache.get(`solana-id\u0000${target.cacheKeyForTransport()}`, IDENTITY_CACHE_MS, load);
  }

  async function bitcoinText(
    target: InternalRpcTarget,
    path: string,
    method: string,
    options: RpcCallOptions,
  ): Promise<string> {
    const context = { chain: target.entry.caip2, method };
    const { text } = await boundedFetch(
      runtime,
      target,
      appendFixedPath(target.endpointForTransport(), path),
      { method: "GET", headers: { Accept: "application/json, text/plain" } },
      options,
      context,
    );
    return text;
  }

  async function ensureBitcoinIdentity(target: InternalRpcTarget, options: RpcCallOptions): Promise<void> {
    const load = async () => {
      const actual = (await bitcoinText(target, "/block-height/0", "genesis", options)).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(actual) || actual !== target.entry.genesis_hash) {
        throw new BlockchainRpcError("RPC_CHAIN_MISMATCH", {
          chain: target.entry.caip2,
          method: "genesis",
        });
      }
    };
    if (options.signal || options.timeout_ms || options.max_response_bytes) return load();
    return identityCache.get(`bitcoin-id\u0000${target.cacheKeyForTransport()}`, IDENTITY_CACHE_MS, load);
  }

  async function evmReference(target: InternalRpcTarget, options: RpcCallOptions): Promise<EvmReferenceBlock> {
    if (!isEvmChain(target.entry)) {
      throw new BlockchainRpcError("CHAIN_FAMILY_MISMATCH", { chain: target.entry.caip2 });
    }
    await ensureEvmIdentity(target, options);
    const attempts: { tag: EvmReferenceTag; outcome: "selected" | "unsupported" | "empty" }[] = [];
    let selected: EvmReferenceTag | undefined;
    let rawBlock: unknown;
    for (const tag of target.entry.reference_tags) {
      try {
        rawBlock = await rawRpc(target, "eth_getBlockByNumber", [tag, false], options);
      } catch (error) {
        if (tag !== "latest" && shouldFallbackTag(error)) {
          attempts.push({ tag, outcome: "unsupported" });
          continue;
        }
        throw error;
      }
      if (rawBlock === null && tag !== "latest") {
        attempts.push({ tag, outcome: "empty" });
        continue;
      }
      if (rawBlock === null) {
        attempts.push({ tag, outcome: "empty" });
        break;
      }
      selected = tag;
      attempts.push({ tag, outcome: "selected" });
      break;
    }
    const context = { chain: target.entry.caip2, method: "eth_getBlockByNumber" };
    if (!selected || !isObject(rawBlock)) {
      throw new BlockchainRpcError("RPC_REFERENCE_UNAVAILABLE", context);
    }
    const height = parseHexQuantity(rawBlock.number, context);
    const timestamp = parseHexQuantity(rawBlock.timestamp, context);
    const hash = parseHexData(rawBlock.hash, context, 32);
    const fetchedAt = new Date(runtime.clock()).toISOString();
    return {
      chain_key: target.entry.key,
      chain: target.entry.caip2,
      family: "evm",
      height: height.toString() as `${bigint}`,
      height_hex: bigIntToHexQuantity(height),
      height_kind: "block-number",
      hash,
      block_time: safeUnixTime(timestamp, context),
      fetched_at: fetchedAt,
      finality: {
        claim: selected === "finalized"
          ? "upstream-finalized"
          : selected === "safe"
            ? "upstream-safe"
            : "upstream-latest-unfinalized",
        basis: "json-rpc-block-tag",
        requested_tag: target.entry.reference_tags[0],
        resolved_tag: selected,
        fallback_used: selected !== target.entry.reference_tags[0],
        attempts,
      },
      source: target.receipt,
    } as EvmReferenceBlock;
  }

  async function bitcoinReference(
    target: InternalRpcTarget,
    options: RpcCallOptions,
  ): Promise<BitcoinReferenceBlock> {
    await ensureBitcoinIdentity(target, options);
    const context = { chain: target.entry.caip2, method: "chain-tip" };
    const hash = (await bitcoinText(target, "/blocks/tip/hash", "chain-tip", options)).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    const raw = await bitcoinText(target, `/block/${hash}`, "block", options);
    let body: unknown;
    try { body = JSON.parse(raw) as unknown; } catch {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    if (!isObject(body) || typeof body.id !== "string" || body.id.toLowerCase() !== hash) {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    const height = safeJsonInteger(body.height, context);
    const timestamp = safeJsonInteger(body.timestamp, context);
    return {
      chain_key: "bitcoin",
      chain: target.entry.caip2,
      family: "bitcoin",
      height: height.toString() as `${bigint}`,
      height_kind: "block-height",
      hash,
      block_time: safeUnixTime(timestamp, context),
      fetched_at: new Date(runtime.clock()).toISOString(),
      finality: {
        claim: "bitcoin-proof-of-work-tip",
        basis: "esplora-chain-tip",
        fallback_used: false,
        attempts: [],
      },
      source: target.receipt,
    };
  }

  async function solanaReference(
    target: InternalRpcTarget,
    options: RpcCallOptions,
  ): Promise<SolanaReferenceBlock> {
    await ensureSolanaIdentity(target, options);
    const context = { chain: target.entry.caip2, method: "getSlot/getBlock" };
    const rawSlot = await rawRpc(target, "getSlot", [{ commitment: "finalized" }], options);
    let slot = safeJsonInteger(rawSlot, context);
    let body: unknown = null;
    let fallbackUsed = false;
    // Finalized slots may be skipped. Walk back a small, bounded number while
    // keeping the commitment claim explicit.
    for (let offset = 0; offset < 8; offset += 1) {
      if (slot < 0n || slot > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      }
      body = await rawRpc(target, "getBlock", [Number(slot), {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
      }], options);
      if (body !== null) break;
      if (slot === 0n) break;
      slot -= 1n;
      fallbackUsed = true;
    }
    if (!isObject(body) || typeof body.blockhash !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(body.blockhash)) {
      throw new BlockchainRpcError("RPC_REFERENCE_UNAVAILABLE", context);
    }
    const timestamp = body.blockTime === null ? null : safeUnixTime(safeJsonInteger(body.blockTime, context), context);
    return {
      chain_key: "solana",
      chain: target.entry.caip2,
      family: "solana",
      height: slot.toString() as `${bigint}`,
      height_kind: "slot",
      hash: body.blockhash,
      block_time: timestamp,
      fetched_at: new Date(runtime.clock()).toISOString(),
      finality: {
        claim: "solana-finalized-commitment",
        basis: "solana-rpc-commitment",
        fallback_used: fallbackUsed,
        attempts: [],
      },
      source: target.receipt,
    };
  }

  async function loadReference(target: InternalRpcTarget, options: RpcCallOptions): Promise<ReferenceBlock> {
    const reference = target.entry.family === "evm"
      ? await evmReference(target, options)
      : target.entry.family === "bitcoin"
        ? await bitcoinReference(target, options)
        : await solanaReference(target, options);
    const frozen = deepFreeze(reference);
    if (frozen.family === "evm") issuedEvmReferences.add(frozen);
    return frozen;
  }

  async function getReferenceBlock(selector: string, options: RpcCallOptions = {}): Promise<ReferenceBlock> {
    const target = targetFor(runtime, selector);
    const load = () => loadReference(target, options);
    if (options.signal || options.timeout_ms || options.max_response_bytes) return load();
    return referenceCache.get(
      `reference\u0000${target.cacheKeyForTransport()}`,
      target.entry.reference_cache_ms,
      load,
    );
  }

  async function evmRead(
    selector: string,
    method: EvmReadMethod,
    params: readonly JsonValue[] = [],
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    const target = familyTarget(runtime, selector, "evm");
    if (!EVM_METHODS.has(method)) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", { chain: target.entry.caip2 });
    }
    validateEvmReadParams(method, params, target.entry.caip2);
    const identity = await ensureEvmIdentity(target, options);
    if (method === "eth_chainId") return identity;
    return rawRpc(target, method, params, options);
  }

  async function evmCallsAtReference(
    selector: string,
    calls: readonly EvmReadCall[],
    suppliedReference?: EvmReferenceBlock,
    options: RpcCallOptions = {},
  ): Promise<EvmCallsAtReference> {
    const target = familyTarget(runtime, selector, "evm");
    if (calls.length < 1 || calls.length > MAX_EVM_CALLS) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", { chain: target.entry.caip2, method: "eth_call" });
    }
    const seen = new Set<string>();
    calls.forEach((call) => validateEvmCall(call, seen, target.entry.caip2));
    if (suppliedReference && !issuedEvmReferences.has(suppliedReference)) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", {
        chain: target.entry.caip2,
        method: "eth_call",
      });
    }
    await ensureEvmIdentity(target, options);
    const resolvedReference = suppliedReference ??
      await getReferenceBlock(target.entry.key, options) as EvmReferenceBlock;
    const reference = immutableReferenceCopy(target, resolvedReference);
    issuedEvmReferences.add(reference);
    const hashSelector: JsonValue = {
      blockHash: reference.hash,
      requireCanonical: true,
    };

    let execution: Awaited<ReturnType<typeof executeEvmCalls>>;
    let pinning: EvmCallsAtReference["pinning"] = "block-hash-canonical";
    try {
      execution = await executeEvmCalls(target, calls, hashSelector, options);
    } catch (error) {
      // Only a JSON-RPC-level refusal can indicate lack of EIP-1898 support.
      // Probe the same method with a non-reverting empty-code call. If that
      // works, the original individual failure is a true call failure.
      if (!(error instanceof BlockchainRpcError) || error.code !== "RPC_REMOTE_ERROR") throw error;
      if (await supportsHashPinnedEthCall(target, hashSelector, options)) throw error;

      // Compatibility path for providers without EIP-1898: bind the height to
      // the supplied hash immediately before and after every bounded call set.
      pinning = "height-with-canonical-pre-postcheck";
      await assertCanonicalReference(target, reference, options);
      execution = await executeEvmCalls(target, calls, reference.height_hex, options);
      await assertCanonicalReference(target, reference, options);
    }
    return {
      chain: target.entry.caip2,
      reference,
      results: execution.results,
      transport: execution.transport,
      pinning,
      source: target.receipt,
    };
  }

  async function bitcoinMempool(
    selector = "bitcoin",
    options: RpcCallOptions = {},
  ): Promise<BitcoinMempoolSnapshot> {
    const target = familyTarget(runtime, selector, "bitcoin");
    await ensureBitcoinIdentity(target, options);
    const context = { chain: target.entry.caip2, method: "mempool" };
    const body = parseJsonObject(
      await bitcoinText(target, "/mempool", "mempool", options),
      context,
    );
    return {
      chain: target.entry.caip2,
      transaction_count: safeJsonInteger(body.count, context).toString() as `${bigint}`,
      virtual_size_bytes: safeJsonInteger(body.vsize, context).toString() as `${bigint}`,
      total_fee_sats: safeJsonInteger(body.total_fee, context).toString() as `${bigint}`,
      fetched_at: new Date(runtime.clock()).toISOString(),
      source: target.receipt,
    };
  }

  async function bitcoinFeeEstimate(
    selector = "bitcoin",
    options: RpcCallOptions = {},
  ): Promise<BitcoinFeeEstimate> {
    const target = familyTarget(runtime, selector, "bitcoin");
    await ensureBitcoinIdentity(target, options);
    const context = { chain: target.entry.caip2, method: "fee-estimates" };
    const raw = await bitcoinText(target, "/fee-estimates", "fee-estimates", options);
    return {
      chain: target.entry.caip2,
      target_blocks: "3",
      sat_per_vbyte: exactFeeEstimateAtThreeBlocks(raw, context),
      fetched_at: new Date(runtime.clock()).toISOString(),
      source: target.receipt,
    };
  }

  async function solanaRead(
    selector: string,
    method: SolanaReadMethod,
    params: readonly JsonValue[] = [],
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    const target = familyTarget(runtime, selector, "solana");
    if (!SOLANA_METHODS.has(method)) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", { chain: target.entry.caip2 });
    }
    validateBoundedSolanaParams(method, params, { chain: target.entry.caip2, method });
    await ensureSolanaIdentity(target, options);
    if (method === "getGenesisHash") return target.entry.genesis_hash;
    return rawRpc(target, method, params, options);
  }

  async function solanaPerformanceSamples(
    selector = "solana",
    limit = 12,
    options: RpcCallOptions = {},
  ): Promise<SolanaPerformanceSamples> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
      throw new BlockchainRpcError("RPC_INVALID_CALL", { method: "getRecentPerformanceSamples" });
    }
    const target = familyTarget(runtime, selector, "solana");
    const context = { chain: target.entry.caip2, method: "getRecentPerformanceSamples" };
    const raw = await solanaRead(selector, "getRecentPerformanceSamples", [limit], options);
    if (!Array.isArray(raw) || raw.length > limit) {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    const samples = raw.map((item) => {
      if (!isObject(item)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      const nonVote = item.numNonVoteTransactions === undefined
        ? undefined
        : safeJsonInteger(item.numNonVoteTransactions, context).toString() as `${bigint}`;
      return {
        slot: safeJsonInteger(item.slot, context).toString() as `${bigint}`,
        transactions: safeJsonInteger(item.numTransactions, context).toString() as `${bigint}`,
        ...(nonVote !== undefined ? { non_vote_transactions: nonVote } : {}),
        slots: safeJsonInteger(item.numSlots, context).toString() as `${bigint}`,
        sample_period_seconds: safeJsonInteger(item.samplePeriodSecs, context).toString() as `${bigint}`,
      };
    });
    return {
      chain: target.entry.caip2,
      samples,
      fetched_at: new Date(runtime.clock()).toISOString(),
      source: target.receipt,
    };
  }

  async function solanaPrioritizationFees(
    selector = "solana",
    writableAccounts: readonly string[] = [],
    options: RpcCallOptions = {},
  ): Promise<SolanaPrioritizationFees> {
    const target = familyTarget(runtime, selector, "solana");
    const context = { chain: target.entry.caip2, method: "getRecentPrioritizationFees" };
    // The generic guard performs the same check; keep it here so invalid input
    // is rejected before even attempting identity I/O.
    validateBoundedSolanaParams(
      "getRecentPrioritizationFees",
      [Array.from(writableAccounts)],
      context,
    );
    const raw = await solanaRead(
      selector,
      "getRecentPrioritizationFees",
      [Array.from(writableAccounts)],
      options,
    );
    if (!Array.isArray(raw) || raw.length > 512) {
      throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
    }
    const fees = raw.map((item) => {
      if (!isObject(item)) throw new BlockchainRpcError("RPC_MALFORMED_RESPONSE", context);
      return {
        slot: safeJsonInteger(item.slot, context).toString() as `${bigint}`,
        micro_lamports_per_compute_unit:
          safeJsonInteger(item.prioritizationFee, context).toString() as `${bigint}`,
      };
    });
    return {
      chain: target.entry.caip2,
      fees,
      fetched_at: new Date(runtime.clock()).toISOString(),
      source: target.receipt,
    };
  }

  return Object.freeze({
    getReferenceBlock,
    evmRead,
    evmCallsAtReference,
    bitcoinMempool,
    bitcoinFeeEstimate,
    solanaRead,
    solanaPerformanceSamples,
    solanaPrioritizationFees,
  });
}
