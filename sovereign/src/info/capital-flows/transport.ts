import { CAPITAL_LIMITS, type AdapterContext, type SourceDefinition, type TextResponse, type TransportReceipt } from "./model.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type FailureCode = "aborted" | "adapter_deadline" | "refresh_deadline" | "rights_withheld" | "resource_not_allowed" | "redirect_limit" | "page_limit" | "response_byte_limit" | "adapter_byte_limit" | "row_limit" | "incomplete_batch" | "invalid_batch" | "normalized_byte_limit" | "serialized_byte_limit" | "upstream_http" | "upstream_failed";
export class CapitalFlowError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "CapitalFlowError"; }
}
/** No publisher body, credential, arbitrary URL or exception text reaches JSON. */
export function safeFailure(error: unknown): string {
  return error instanceof CapitalFlowError ? error.code : "upstream_failed";
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CapitalFlowError("aborted");
}
/** Races non-cooperative work without retaining its late result or an abort listener. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(new CapitalFlowError("aborted")); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new CapitalFlowError("aborted")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
interface QueuedRequest { start(): void; cancel(): void }
export interface RequestPool { run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>; dispose(): void }
export function createRequestPool(): RequestPool {
  let active = 0, disposed = false;
  const queue: QueuedRequest[] = [];
  const drain = () => { while (!disposed && active < CAPITAL_LIMITS.concurrentRequests && queue.length) queue.shift()!.start(); };
  return {
    run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      if (disposed || signal.aborted) return Promise.reject(new CapitalFlowError("aborted"));
      const pending = new Promise<T>((resolve, reject) => {
        const entry: QueuedRequest = {
          cancel() {
            const index = queue.indexOf(entry);
            if (index !== -1) queue.splice(index, 1);
            signal.removeEventListener("abort", entry.cancel);
            reject(new CapitalFlowError("aborted"));
          },
          start() {
            signal.removeEventListener("abort", entry.cancel);
            if (disposed || signal.aborted) { reject(new CapitalFlowError("aborted")); return; }
            active++;
            // The slot remains occupied until actual work ends, even if a fetch ignores abort.
            Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; drain(); });
          },
        };
        signal.addEventListener("abort", entry.cancel, { once: true });
        queue.push(entry);
        drain();
      });
      return abortable(pending, signal);
    },
    dispose() { disposed = true; for (const entry of [...queue]) entry.cancel(); },
  };
}
export function validateResourceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CapitalFlowError("resource_not_allowed"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") ||
      !url.hostname.includes(".") || url.hostname.endsWith(".local") || url.hostname.endsWith(".localhost") ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new CapitalFlowError("resource_not_allowed");
  // Exact canonical resource identity prevents alternate URL spellings and hidden redirects.
  if (url.href !== value) throw new CapitalFlowError("resource_not_allowed");
  return url.href;
}
export interface AdapterTransport {
  context: AdapterContext;
  receipts: TransportReceipt[];
  validateBatchAccounting(receipts: readonly TransportReceipt[], observationCount: number): void;
}
export function createAdapterTransport(options: {
  definition: SourceDefinition; signal: AbortSignal; pool: RequestPool; fetch?: FetchLike;
  now?: () => number; rightsAllowed: () => boolean;
}): AdapterTransport {
  const { signal, pool, definition } = options;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const allowed = new Set(definition.resources.map(validateResourceUrl));
  let pages = 0, bytes = 0, rows = 0;
  let rowsAccounted = false, completeAsserted = false;
  const receipts: TransportReceipt[] = [];
  const check = () => {
    throwIfAborted(signal);
    if (!options.rightsAllowed()) throw new CapitalFlowError("rights_withheld");
  };
  const allowedUrl = (url: string) => {
    validateResourceUrl(url);
    if (!allowed.has(url)) throw new CapitalFlowError("resource_not_allowed");
  };
  const read = async (url: string): Promise<TextResponse> => {
    check(); allowedUrl(url);
    if (++pages > CAPITAL_LIMITS.pages) throw new CapitalFlowError("page_limit");
    return pool.run(signal, async () => {
      check();
      const response = await fetcher(url, { method: "GET", redirect: "manual", signal, headers: { Accept: "application/json, text/csv, text/plain;q=0.9" }, credentials: "omit" });
      if (signal.aborted || !options.rightsAllowed()) {
        void response.body?.cancel().catch(() => undefined); check();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => undefined);
        if (!location) throw new CapitalFlowError("resource_not_allowed");
        let destination: string;
        try { destination = new URL(location, url).href; } catch { throw new CapitalFlowError("resource_not_allowed"); }
        allowedUrl(destination); // Check BEFORE any request to the destination.
        // Return a marker and release this request's slot before following it.
        return { redirect: destination };
      }
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new CapitalFlowError("upstream_http"); }
      if (response.url && response.url !== url) { void response.body?.cancel().catch(() => undefined); throw new CapitalFlowError("resource_not_allowed"); }
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length) && Number(length) > CAPITAL_LIMITS.responseBytes) {
        void response.body?.cancel().catch(() => undefined); throw new CapitalFlowError("response_byte_limit");
      }
      const reader = response.body?.getReader();
      let text = "", decodedBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => { void reader?.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (reader) while (true) {
          check();
          const { done, value } = await reader.read();
          check();
          if (done) break;
          decodedBytes += value.byteLength;
          bytes += value.byteLength;
          if (decodedBytes > CAPITAL_LIMITS.responseBytes) throw new CapitalFlowError("response_byte_limit");
          if (bytes > CAPITAL_LIMITS.adapterBytes) throw new CapitalFlowError("adapter_byte_limit");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) { cancel(); throw error; }
      finally { signal.removeEventListener("abort", cancel); }
      check();
      // The adapter receives this same receipt. Freeze the accounting baseline so a
      // later parser mutation cannot silently rewrite the actual retrieval time.
      const receipt: TransportReceipt = Object.freeze({ url, retrievedAt: new Date(now()).toISOString(),
        lastModified: response.headers.get("last-modified"), etag: response.headers.get("etag"), decodedBytes });
      receipts.push(receipt);
      return { text, url, headers: Object.fromEntries(response.headers.entries()), receipt };
    }).then(result => result.redirect !== undefined ? read(result.redirect) : result);
  };
  return {
    receipts,
    context: {
      signal, fetchText: read,
      consumeRows(count) {
        check();
        if (!Number.isSafeInteger(count) || count < 0 || rows + count > CAPITAL_LIMITS.rows) throw new CapitalFlowError("row_limit");
        rows += count; rowsAccounted = true; completeAsserted = false;
      },
      assertComplete(receivedRows, expectedRows) {
        check();
        if (!Number.isSafeInteger(receivedRows) || !Number.isSafeInteger(expectedRows) || receivedRows < 0 || receivedRows !== expectedRows || expectedRows > rows) throw new CapitalFlowError("incomplete_batch");
        completeAsserted = true;
      },
    },
    validateBatchAccounting(returnedReceipts, observationCount) {
      check();
      if (!completeAsserted) throw new CapitalFlowError("incomplete_batch");
      if (observationCount > CAPITAL_LIMITS.rows || !rowsAccounted || receipts.length === 0 || returnedReceipts.length !== receipts.length) throw new CapitalFlowError("invalid_batch");
      // Request order need not equal completion order. Consume one authentic full
      // receipt per match, so duplication cannot stand in for an omitted response.
      const unmatched = [...receipts];
      for (const receipt of returnedReceipts) {
        const index = unmatched.findIndex(actual => receipt &&
          Object.keys(receipt).length === Object.keys(actual).length &&
          (Object.keys(actual) as (keyof TransportReceipt)[]).every(key => receipt[key] === actual[key]));
        if (index < 0) throw new CapitalFlowError("invalid_batch");
        unmatched.splice(index, 1);
      }
    },
  };
}
