/** One bounded ERC-4337 bundler attempt. Transport acceptance is not inclusion. */
import { keccak256, type Hex } from "viem";
import type { PreparedErc4337Operation } from "./erc4337-builder.ts";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_DEADLINE_MS = 9_000;

export type Erc4337BundlerResult =
  | Readonly<{ state: "accepted_transport"; user_operation_hash: `0x${string}`; transport: "bundler" }>
  | Readonly<{ state: "ambiguous"; code: "cancelled" | "deadline_exceeded" | "network_unavailable" | "malformed_response"; transport: "bundler" }>
  | Readonly<{ state: "refused"; code: "bundler_rejected" | "wrong_chain" | "entry_point_unsupported" | "entry_point_code_mismatch"; transport: "bundler" }>;

export type Erc4337Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Erc4337BundlerDependencies {
  readonly endpoint: string;
  readonly fetch?: Erc4337Fetch;
  readonly deadline_ms?: number;
  readonly max_response_bytes?: number;
}

const fixedEndpoint = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new TypeError("ERC-4337 bundler endpoint must be fixed HTTPS without credentials, query, or fragment.");
  return url.href;
};
const bounded = (value: number, fallback: number, maximum: number): number => Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : fallback;
const rpcPayload = (method: string, params: readonly unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const readJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("malformed");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error("too_large");
  if (!response.body) throw new Error("malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("malformed");
  }
  return JSON.parse(text);
};
const responseResult = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("malformed");
  const record = body as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || record.id !== 1) throw new Error("malformed");
  if ("error" in record) throw new Error("rpc_rejected");
  if (!("result" in record)) throw new Error("malformed");
  return record.result;
};
const toRpcUserOperation = (prepared: PreparedErc4337Operation) => {
  const op = prepared.request.user_operation;
  return Object.freeze({ sender: op.sender, nonce: `0x${BigInt(op.nonce).toString(16)}`, initCode: op.init_code, callData: op.call_data, accountGasLimits: op.account_gas_limits, preVerificationGas: `0x${BigInt(op.pre_verification_gas).toString(16)}`, gasFees: op.gas_fees, paymasterAndData: op.paymaster_and_data, signature: op.signature });
};

export const createErc4337Bundler = (dependencies: Erc4337BundlerDependencies) => {
  const endpoint = fixedEndpoint(dependencies.endpoint);
  const fetchFn: Erc4337Fetch = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("ERC-4337 fetch is required.");
  const deadlineMs = bounded(dependencies.deadline_ms ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS, 10_000);
  const maxBytes = bounded(dependencies.max_response_bytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, 2 * MAX_RESPONSE_BYTES);
  const attempted = new Set<string>();
  const call = async (method: string, params: readonly unknown[], signal: AbortSignal, boundary: Promise<never>): Promise<unknown> => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const response = await Promise.race([
      fetchFn(endpoint, { method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", accept: "application/json" }, body: rpcPayload(method, params) }),
      boundary,
    ]);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!response.ok) throw new Error("http");
    const body = await Promise.race([readJson(response, maxBytes), boundary]);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return responseResult(body);
  };
  return Object.freeze({
    async submit(prepared: PreparedErc4337Operation, signal?: AbortSignal): Promise<Erc4337BundlerResult> {
      if (attempted.has(prepared.user_operation_hash)) throw new TypeError("ERC-4337 bundler transport permits one attempt per UserOperation.");
      attempted.add(prepared.user_operation_hash);
      if (signal?.aborted) return Object.freeze({ state: "ambiguous", code: "cancelled", transport: "bundler" });
      const controller = new AbortController();
      let deadlineExceeded = false;
      let callerCancelled = false;
      let rejectBoundary!: (reason: DOMException) => void;
      const boundary = new Promise<never>((_resolve, reject) => {
        rejectBoundary = reject;
      });
      const timer = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort();
        rejectBoundary(new DOMException("deadline", "AbortError"));
      }, deadlineMs);
      const abort = () => {
        callerCancelled = true;
        controller.abort();
        rejectBoundary(new DOMException("cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const chainId = await call("eth_chainId", [], controller.signal, boundary);
        if (chainId !== "0x2105") return Object.freeze({ state: "refused", code: "wrong_chain", transport: "bundler" });
        const supported = await call("eth_supportedEntryPoints", [], controller.signal, boundary);
        if (!Array.isArray(supported) || !supported.some((value) => typeof value === "string" && value.toLowerCase() === prepared.entry_point.address)) return Object.freeze({ state: "refused", code: "entry_point_unsupported", transport: "bundler" });
        const code = await call("eth_getCode", [prepared.entry_point.address, "latest"], controller.signal, boundary);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(code) || keccak256(code as Hex) !== prepared.entry_point.runtime_code_hash) return Object.freeze({ state: "refused", code: "entry_point_code_mismatch", transport: "bundler" });
        const result = await call("eth_sendUserOperation", [toRpcUserOperation(prepared), prepared.entry_point.address], controller.signal, boundary);
        if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/.test(result)) return Object.freeze({ state: "ambiguous", code: "malformed_response", transport: "bundler" });
        if (result !== prepared.user_operation_hash) return Object.freeze({ state: "ambiguous", code: "malformed_response", transport: "bundler" });
        return Object.freeze({ state: "accepted_transport", user_operation_hash: result, transport: "bundler" });
      } catch (error) {
        if (callerCancelled) return Object.freeze({ state: "ambiguous", code: "cancelled", transport: "bundler" });
        if (deadlineExceeded || (error instanceof Error && error.name === "AbortError")) return Object.freeze({ state: "ambiguous", code: "deadline_exceeded", transport: "bundler" });
        if (error instanceof Error && error.message === "rpc_rejected") return Object.freeze({ state: "refused", code: "bundler_rejected", transport: "bundler" });
        if (error instanceof Error && (error.message === "too_large" || error.message === "malformed")) return Object.freeze({ state: "ambiguous", code: "malformed_response", transport: "bundler" });
        return Object.freeze({ state: "ambiguous", code: "network_unavailable", transport: "bundler" });
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    },
  });
};
