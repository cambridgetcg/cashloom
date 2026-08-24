import {
  OpenBankingAdapterError,
  stableOpenBankingError,
} from "./errors.ts";

export interface FixedJsonHttpDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly deadline_ms?: number;
  readonly max_response_bytes?: number;
}

export interface FixedJsonRequest {
  readonly origin: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly allow_empty?: boolean;
}

export interface FixedJsonHttp {
  request<T>(request: FixedJsonRequest): Promise<T>;
}

const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

const exactOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Fixed open-banking origins must be bare HTTPS origins.");
  }
  return url.origin;
};

const mapStatus = (status: number): OpenBankingAdapterError => {
  if (status === 401) return stableOpenBankingError("OPEN_BANKING_UNAUTHORIZED");
  if (status === 403) return stableOpenBankingError("OPEN_BANKING_FORBIDDEN");
  if (status === 429) return stableOpenBankingError("OPEN_BANKING_RATE_LIMITED");
  if (status === 409) return stableOpenBankingError("OPEN_BANKING_PROVIDER_CONFLICT");
  if (status >= 500) return stableOpenBankingError("OPEN_BANKING_PROVIDER_UNAVAILABLE");
  return stableOpenBankingError("OPEN_BANKING_PROVIDER_REJECTED");
};

export const createFixedJsonHttp = (
  dependencies: FixedJsonHttpDependencies = {},
): FixedJsonHttp => {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const deadlineMs = dependencies.deadline_ms ?? DEFAULT_DEADLINE_MS;
  const maxResponseBytes = dependencies.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (typeof fetcher !== "function" || typeof now !== "function") {
    throw new TypeError("Open-banking HTTP dependencies are invalid.");
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) {
    throw new TypeError("Open-banking HTTP deadline is invalid.");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 256 ||
    maxResponseBytes > 8 * 1024 * 1024
  ) {
    throw new TypeError("Open-banking HTTP response bound is invalid.");
  }

  return Object.freeze({
    async request<T>(request: FixedJsonRequest): Promise<T> {
      const origin = exactOrigin(request.origin);
      if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(request.path) || request.path.startsWith("//")) {
        throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
      }
      if (request.signal?.aborted) {
        throw stableOpenBankingError("OPEN_BANKING_CANCELLED");
      }
      const started = now();
      if (!Number.isFinite(started)) throw new TypeError("Open-banking clock is invalid.");
      const controller = new AbortController();
      let deadlineElapsed = false;
      let rejectBoundary!: (reason: OpenBankingAdapterError) => void;
      const boundary = new Promise<never>((_resolve, reject) => {
        rejectBoundary = reject;
      });
      const onAbort = () => {
        controller.abort();
        rejectBoundary(stableOpenBankingError("OPEN_BANKING_CANCELLED"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        deadlineElapsed = true;
        controller.abort();
        rejectBoundary(stableOpenBankingError("OPEN_BANKING_TIMEOUT"));
      }, deadlineMs);
      try {
        let response: Response;
        try {
          response = await Promise.race([
            fetcher(`${origin}${request.path}`, {
              method: request.method,
              headers: {
                accept: "application/json",
                ...(request.body === undefined ? {} : { "content-type": "application/json" }),
                ...request.headers,
              },
              ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
              redirect: "error",
              signal: controller.signal,
            }),
            boundary,
          ]);
        } catch {
          if (request.signal?.aborted) {
            throw stableOpenBankingError("OPEN_BANKING_CANCELLED");
          }
          if (deadlineElapsed) throw stableOpenBankingError("OPEN_BANKING_TIMEOUT");
          throw stableOpenBankingError("OPEN_BANKING_NETWORK_UNAVAILABLE");
        }
        if (!response.ok) throw mapStatus(response.status);
        if (request.allow_empty && (response.status === 204 || response.body === null)) {
          return undefined as T;
        }
        const contentType = response.headers.get("content-type");
        if (!contentType || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
          throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
        }
        const declared = response.headers.get("content-length");
        if (declared !== null) {
          if (!/^(0|[1-9][0-9]*)$/.test(declared)) {
            throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
          }
          if (BigInt(declared) > BigInt(maxResponseBytes)) {
            throw stableOpenBankingError("OPEN_BANKING_RESPONSE_TOO_LARGE");
          }
        }
        if (!response.body) throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0;
        let text = "";
        try {
          while (true) {
            let chunk;
            try {
              chunk = await Promise.race([reader.read(), boundary]);
            } catch {
              if (request.signal?.aborted) {
                throw stableOpenBankingError("OPEN_BANKING_CANCELLED");
              }
              if (deadlineElapsed) throw stableOpenBankingError("OPEN_BANKING_TIMEOUT");
              throw stableOpenBankingError("OPEN_BANKING_NETWORK_UNAVAILABLE");
            }
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxResponseBytes) {
              await reader.cancel().catch(() => undefined);
              throw stableOpenBankingError("OPEN_BANKING_RESPONSE_TOO_LARGE");
            }
            try {
              text += decoder.decode(chunk.value, { stream: true });
            } catch {
              throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
            }
          }
          text += decoder.decode();
        } catch (error) {
          if (error instanceof OpenBankingAdapterError) throw error;
          throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
        }
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  });
};
