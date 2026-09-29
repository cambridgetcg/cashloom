import { endpoint } from "../world/api";
import type { CapitalFlowsSnapshot } from "./types";
import { CapitalFlowsApiError, parseCapitalFlowsSnapshot } from "./validation";
export { CapitalFlowsApiError, parseCapitalFlowsSnapshot } from "./validation";

export interface CapitalFlowsMemory {
  snapshot: CapitalFlowsSnapshot;
  etag?: string;
  receivedAt: number;
}
export interface CapitalFlowsFetchResult extends CapitalFlowsMemory { kind: "modified" | "not-modified" }
const MAX_BYTES = 2 * 1024 * 1024;
export const CAPITAL_REQUEST_TIMEOUT_MS = 4000;
export const CAPITAL_COMPLETION_WINDOW_MS = 30000;
export const CAPITAL_COMPLETION_CHECKS_MS = [3000, 8000, 16000, 26000] as const;
const validEtag = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && /^(?:W\/)?"[^"\r\n]+"$/.test(v);
const aborted = () => new DOMException("Capital-flows read stopped.", "AbortError");

// Race as well as abort: even a transport that ignores cancellation cannot keep the view waiting.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason ?? aborted()); }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? aborted());
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/vnd.cashloom.capital-flows.v1+json") {
    throw new CapitalFlowsApiError("The capital-flows endpoint did not return JSON.");
  }
  const announced = response.headers.get("content-length");
  if (announced && /^\d+$/.test(announced) && Number(announced) > MAX_BYTES) throw new CapitalFlowsApiError("The capital-flows response exceeded its size limit.");
  if (!response.body) throw new CapitalFlowsApiError("The capital-flows endpoint returned an empty body.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new CapitalFlowsApiError("The capital-flows response exceeded its size limit.");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new CapitalFlowsApiError("The capital-flows response could not be decoded."); }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** One read, with an optional exact in-memory body/validator pair. Never persists snapshots. */
export async function fetchCapitalFlows(options: {
  signal?: AbortSignal; cached?: CapitalFlowsMemory; timeoutMs?: number;
} = {}): Promise<CapitalFlowsFetchResult> {
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal?.reason ?? aborted());
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const timeout = Math.min(CAPITAL_REQUEST_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? CAPITAL_REQUEST_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(new CapitalFlowsApiError("The capital-flows read timed out. Automatic checks have stopped.")), timeout);
  const etag = options.cached && validEtag(options.cached.etag) ? options.cached.etag : undefined;
  let response: Response | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const request = fetch(endpoint("/v1/capital-flows"), {
      method: "GET", credentials: "omit", cache: "no-cache", signal: controller.signal,
      headers: { Accept: "application/vnd.cashloom.capital-flows.v1+json, application/json;q=0.9", ...(etag ? { "If-None-Match": etag } : {}) },
    });
    // Dispose a late response from a transport that ignored abort.
    void request.then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => undefined); }, () => undefined);
    response = await abortable(request, controller.signal);
    const responseEtag = response.headers.get("etag");
    if (response.status === 304) {
      if (!options.cached || !etag || (responseEtag && responseEtag.replace(/^W\//, "") !== etag.replace(/^W\//, ""))) {
        throw new CapitalFlowsApiError("The capital-flows endpoint returned 304 without a matching in-memory body and validator.");
      }
      return { kind: "not-modified", snapshot: parseCapitalFlowsSnapshot(options.cached.snapshot), etag: validEtag(responseEtag) ? responseEtag : etag, receivedAt: Date.now() };
    }
    if (response.status === 404) throw new CapitalFlowsApiError("The capital-flows feed is not enabled on this server (HTTP 404).", 404);
    if (!response.ok) throw new CapitalFlowsApiError(`The capital-flows endpoint returned HTTP ${response.status}. No replacement values were accepted.`, response.status);
    const snapshot = parseCapitalFlowsSnapshot(await boundedJson(response, controller.signal));
    return { kind: "modified", snapshot, receivedAt: Date.now(), ...(validEtag(responseEtag) ? { etag: responseEtag } : {}) };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof CapitalFlowsApiError) throw error;
    throw new CapitalFlowsApiError("The capital-flows feed could not be reached. No replacement values were accepted.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason ?? aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, Math.max(0, ms));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", stop); stop(); }
  });
}
/** Initial request plus at most four completion reads within 30 seconds, only while refreshing. */
export async function readCapitalFlowsWindow(options: {
  signal: AbortSignal; cached?: CapitalFlowsMemory; onSnapshot: (result: CapitalFlowsFetchResult) => void;
}): Promise<{ latest: CapitalFlowsMemory; checksStopped: boolean }> {
  const controller = new AbortController(), started = Date.now();
  const stop = () => controller.abort(options.signal.reason ?? aborted());
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const timer = setTimeout(() => controller.abort(new CapitalFlowsApiError("The completion window ended. Automatic checks have stopped.")), CAPITAL_COMPLETION_WINDOW_MS);
  let latest = options.cached;
  try {
    for (let index = 0; index <= CAPITAL_COMPLETION_CHECKS_MS.length; index++) {
      if (index > 0) await wait(started + CAPITAL_COMPLETION_CHECKS_MS[index - 1] - Date.now(), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await fetchCapitalFlows({ cached: latest, signal: controller.signal });
      latest = result;
      if (controller.signal.aborted) throw controller.signal.reason;
      options.onSnapshot(result);
      if (latest.snapshot.refresh.state !== "refreshing") return { latest, checksStopped: false };
    }
    return { latest: latest!, checksStopped: true };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}
