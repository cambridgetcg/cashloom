import type { OnchainRecord, OnchainSnapshot } from "./types";

const configuredBase = (import.meta.env.VITE_CASHLOOM_API_BASE as string | undefined)?.trim();

export const ONCHAIN_STORAGE_KEY = "cashloom.onchain.snapshot.v1";
export const ONCHAIN_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredOnchainRecord {
  schema: "cashloom.onchain-cache/1";
  received_at: string;
  etag?: string;
  snapshot: OnchainSnapshot;
}

export interface PersistedOnchainSnapshot {
  snapshot: OnchainSnapshot;
  receivedAt: number;
  etag?: string;
}

interface FetchReceipt {
  etag?: string;
  receivedAt: number;
  serverCacheState?: string;
  serverSnapshotAgeSeconds?: number;
}

export type OnchainFetchResult =
  | (FetchReceipt & { kind: "modified"; snapshot: OnchainSnapshot })
  | (FetchReceipt & { kind: "not-modified" });

export interface OnchainFetchOptions {
  signal?: AbortSignal;
  etag?: string;
}

function endpoint(path: string): string {
  if (!configuredBase) return path;
  return `${configuredBase.replace(/\/$/, "")}${path}`;
}

function isRecord(value: unknown): value is OnchainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function validEtag(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 1
    && value.length <= 256
    && !/[\r\n]/.test(value);
}

function nonNegativeInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const REQUIRED_SECTIONS = [
  "briefing",
  "chains",
  "stablecoins",
  "lending_markets",
  "pools",
  "bridge_routes",
  "threads",
  "sources",
] as const;

export class OnchainApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OnchainApiError";
    this.status = status;
  }
}

/**
 * Validate the versioned envelope and section containers while accepting new
 * fields within a v1 row. This lets the evidence contract grow additively
 * without teaching the UI to trust an unrelated JSON response.
 */
export function parseOnchainSnapshot(body: unknown, status?: number): OnchainSnapshot {
  if (!isRecord(body)) {
    throw new OnchainApiError("The onchain feed returned an unreadable document.", status);
  }
  if (body.schema !== "cashloom.onchain/1") {
    throw new OnchainApiError(
      "The endpoint returned JSON, but not a CashLoom Onchain snapshot.",
      status,
    );
  }
  const missing = REQUIRED_SECTIONS.filter((section) => !Array.isArray(body[section]));
  if (missing.length) {
    throw new OnchainApiError(
      `The onchain snapshot is missing required section${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      status,
    );
  }
  if (body.status !== undefined && !isRecord(body.status)) {
    throw new OnchainApiError("The onchain snapshot has an unreadable status receipt.", status);
  }
  if (body.generated_at !== undefined && typeof body.generated_at !== "string") {
    throw new OnchainApiError("The onchain snapshot has an unreadable assembly time.", status);
  }
  return body as unknown as OnchainSnapshot;
}

/**
 * Read the last public market snapshot. No wallet, identity, person, or user
 * activity is written to this record. Invalid or expired records are removed.
 */
export function loadPersistedOnchainSnapshot(
  now = Date.now(),
  storage: StorageLike | undefined = browserStorage(),
): PersistedOnchainSnapshot | undefined {
  if (!storage) return undefined;
  let raw: string | null;
  try {
    raw = storage.getItem(ONCHAIN_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schema !== "cashloom.onchain-cache/1") throw new Error("schema");
    const receivedAt = typeof value.received_at === "string"
      ? Date.parse(value.received_at)
      : Number.NaN;
    if (
      !Number.isFinite(receivedAt)
      || receivedAt > now + CLOCK_SKEW_ALLOWANCE_MS
      || now - receivedAt > ONCHAIN_CACHE_RETENTION_MS
    ) throw new Error("retention");
    if (value.etag !== undefined && !validEtag(value.etag)) throw new Error("etag");
    const snapshot = parseOnchainSnapshot(value.snapshot);
    const generatedAt = snapshot.generated_at ? Date.parse(snapshot.generated_at) : Number.NaN;
    if (!Number.isFinite(generatedAt) || generatedAt > now + CLOCK_SKEW_ALLOWANCE_MS) {
      throw new Error("generated_at");
    }
    return { snapshot, receivedAt, ...(value.etag ? { etag: value.etag } : {}) };
  } catch {
    try { storage.removeItem(ONCHAIN_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
    return undefined;
  }
}

export function persistOnchainSnapshot(
  snapshot: OnchainSnapshot,
  etag: string | undefined,
  receivedAt = Date.now(),
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !Number.isFinite(receivedAt)) return;
  const record: StoredOnchainRecord = {
    schema: "cashloom.onchain-cache/1",
    received_at: new Date(receivedAt).toISOString(),
    ...(etag && validEtag(etag) ? { etag } : {}),
    snapshot,
  };
  try {
    storage.setItem(ONCHAIN_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota and privacy modes must not prevent the live response from rendering.
  }
}

export async function fetchOnchain(options: OnchainFetchOptions = {}): Promise<OnchainFetchResult> {
  let response: Response;
  const requestEtag = validEtag(options.etag) ? options.etag : undefined;

  try {
    response = await fetch(endpoint("/v1/onchain"), {
      method: "GET",
      headers: {
        Accept: "application/vnd.cashloom.onchain.v1+json, application/json;q=0.9",
        ...(requestEtag ? { "If-None-Match": requestEtag } : {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new OnchainApiError("The onchain source network could not be reached.");
  }

  const receivedAt = Date.now();
  const responseEtag = response.headers.get("etag");
  const responseValidator = validEtag(responseEtag) ? responseEtag : undefined;
  const serverCacheState = response.headers.get("x-cashloom-cache")?.trim();
  const serverSnapshotAgeSeconds = nonNegativeInteger(
    response.headers.get("x-cashloom-snapshot-age"),
  );
  const receipt: FetchReceipt = {
    receivedAt,
    ...(responseValidator ? { etag: responseValidator } : {}),
    ...(serverCacheState ? { serverCacheState } : {}),
    ...(serverSnapshotAgeSeconds !== undefined ? { serverSnapshotAgeSeconds } : {}),
  };

  if (response.status === 304) {
    if (!requestEtag) {
      throw new OnchainApiError("The onchain feed returned 304 without a local snapshot validator.", 304);
    }
    return {
      kind: "not-modified",
      ...receipt,
      etag: responseValidator ?? requestEtag,
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        const problem = [body.detail, body.error, body.title].find(
          (value): value is string => typeof value === "string" && Boolean(value.trim()),
        );
        if (problem) detail = ` ${problem.trim()}`;
      }
    } catch {
      // The HTTP receipt remains useful when the error response is not JSON.
    }
    throw new OnchainApiError(
      `The onchain feed returned ${response.status}.${detail}`.trim(),
      response.status,
    );
  }

  const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new OnchainApiError(
      `The onchain feed answered with ${contentType || "an unknown content type"}, not JSON.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OnchainApiError(
      "The onchain feed claimed to be JSON but could not be decoded.",
      response.status,
    );
  }
  return {
    kind: "modified",
    snapshot: parseOnchainSnapshot(body, response.status),
    ...receipt,
  };
}
