import type { WorldRecord, WorldResponse } from "./types";

const configuredBase = (import.meta.env.VITE_CASHLOOM_API_BASE as string | undefined)?.trim();

export const WORLD_STORAGE_PREFIX = "cashloom.world.snapshot.v1";
export const WORLD_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredWorldRecord {
  schema: "cashloom.world-cache/1";
  base_currency: string;
  received_at: string;
  etag?: string;
  snapshot: WorldResponse;
}

export interface PersistedWorldSnapshot {
  snapshot: WorldResponse;
  receivedAt: number;
  etag?: string;
}

interface FetchReceipt {
  etag?: string;
  receivedAt: number;
  serverCacheState?: string;
  serverSnapshotAgeSeconds?: number;
}

export type WorldFetchResult =
  | (FetchReceipt & { kind: "modified"; snapshot: WorldResponse })
  | (FetchReceipt & { kind: "not-modified" });

export interface WorldFetchOptions {
  signal?: AbortSignal;
  etag?: string;
}

function endpoint(path: string): string {
  if (!configuredBase) return path;
  return `${configuredBase.replace(/\/$/, "")}${path}`;
}

function isRecord(value: unknown): value is WorldRecord {
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

function normalizedBase(baseCurrency: string): string {
  return baseCurrency.trim().toLocaleUpperCase();
}

export function worldStorageKey(baseCurrency: string): string {
  return `${WORLD_STORAGE_PREFIX}.${normalizedBase(baseCurrency)}`;
}

const REQUIRED_SECTIONS = [
  "briefing",
  "policy",
  "sovereigns",
  "fx",
  "crypto",
  "fees",
  "energy",
  "calendar",
  "threads",
  "sources",
] as const;

export class WorldApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WorldApiError";
    this.status = status;
  }
}

/**
 * Validate the public, versioned snapshot container while allowing additive v1
 * fields within observations. This is the same gate used for network and local
 * data, so arbitrary or wrong-currency JSON never reaches the dashboard.
 */
export function parseWorldSnapshot(
  body: unknown,
  baseCurrency: string,
  status?: number,
): WorldResponse {
  if (!isRecord(body)) {
    throw new WorldApiError("The World feed returned an unreadable document.", status);
  }
  if (body.schema !== "cashloom.world/1" || body["@type"] !== "WorldSnapshot") {
    throw new WorldApiError(
      "The endpoint returned JSON, but not a CashLoom World snapshot.",
      status,
    );
  }
  const expectedBase = normalizedBase(baseCurrency);
  if (typeof body.base_currency !== "string" || normalizedBase(body.base_currency) !== expectedBase) {
    throw new WorldApiError(
      `The World feed answered for ${typeof body.base_currency === "string" ? body.base_currency : "an unspecified currency"}, not ${expectedBase}.`,
      status,
    );
  }
  if (
    typeof body.generated_at !== "string"
    || !Number.isFinite(Date.parse(body.generated_at))
  ) {
    throw new WorldApiError("The World snapshot has an unreadable assembly time.", status);
  }
  if (!isRecord(body.status)) {
    throw new WorldApiError("The World snapshot has an unreadable status receipt.", status);
  }
  const missing = REQUIRED_SECTIONS.filter((section) => !Array.isArray(body[section]));
  if (missing.length) {
    throw new WorldApiError(
      `The World snapshot is missing required section${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      status,
    );
  }
  return body as WorldResponse;
}

/**
 * Read one last-known public market snapshot for an exact currency lens. No
 * wallet, identity, person, preference, or user activity is stored here.
 * Invalid, wrong-base, future-dated, and expired envelopes are discarded.
 */
export function loadPersistedWorldSnapshot(
  baseCurrency: string,
  now = Date.now(),
  storage: StorageLike | undefined = browserStorage(),
): PersistedWorldSnapshot | undefined {
  if (!storage) return undefined;
  const key = worldStorageKey(baseCurrency);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schema !== "cashloom.world-cache/1") throw new Error("schema");
    if (typeof value.base_currency !== "string" || normalizedBase(value.base_currency) !== normalizedBase(baseCurrency)) {
      throw new Error("base");
    }
    const receivedAt = typeof value.received_at === "string"
      ? Date.parse(value.received_at)
      : Number.NaN;
    if (
      !Number.isFinite(receivedAt)
      || receivedAt > now + CLOCK_SKEW_ALLOWANCE_MS
      || now - receivedAt > WORLD_CACHE_RETENTION_MS
    ) throw new Error("retention");
    if (value.etag !== undefined && !validEtag(value.etag)) throw new Error("etag");
    const snapshot = parseWorldSnapshot(value.snapshot, baseCurrency);
    if (Date.parse(snapshot.generated_at!) > now + CLOCK_SKEW_ALLOWANCE_MS) {
      throw new Error("generated_at");
    }
    return { snapshot, receivedAt, ...(value.etag ? { etag: value.etag } : {}) };
  } catch {
    try { storage.removeItem(key); } catch { /* Storage may be unavailable. */ }
    return undefined;
  }
}

export function persistWorldSnapshot(
  snapshot: WorldResponse,
  etag: string | undefined,
  receivedAt = Date.now(),
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !Number.isFinite(receivedAt) || typeof snapshot.base_currency !== "string") return;
  let validated: WorldResponse;
  try {
    validated = parseWorldSnapshot(snapshot, snapshot.base_currency);
  } catch {
    return;
  }
  const baseCurrency = normalizedBase(snapshot.base_currency);
  const record: StoredWorldRecord = {
    schema: "cashloom.world-cache/1",
    base_currency: baseCurrency,
    received_at: new Date(receivedAt).toISOString(),
    ...(etag && validEtag(etag) ? { etag } : {}),
    snapshot: validated,
  };
  try {
    storage.setItem(worldStorageKey(baseCurrency), JSON.stringify(record));
  } catch {
    // Quota and privacy modes must not prevent a network response from rendering.
  }
}

export async function fetchWorld(
  baseCurrency: string,
  options: WorldFetchOptions = {},
): Promise<WorldFetchResult> {
  let response: Response;
  const expectedBase = normalizedBase(baseCurrency);
  const requestEtag = validEtag(options.etag) ? options.etag : undefined;

  try {
    const path = `/v1/world?base=${encodeURIComponent(expectedBase)}`;
    response = await fetch(endpoint(path), {
      method: "GET",
      headers: {
        Accept: "application/vnd.cashloom.world.v1+json, application/json;q=0.9",
        ...(requestEtag ? { "If-None-Match": requestEtag } : {}),
      },
      // Reuse the browser cache, but ask it to validate before calling a
      // background refresh complete. Unlike `no-store`, this preserves bytes.
      cache: "no-cache",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new WorldApiError("The World feed could not be reached.");
  }

  const receivedAt = Date.now();
  const responseEtag = response.headers.get("etag");
  const validResponseEtag = validEtag(responseEtag) ? responseEtag : undefined;
  const serverSnapshotAgeSeconds = nonNegativeInteger(response.headers.get("x-cashloom-snapshot-age"));
  const receipt: FetchReceipt = {
    receivedAt,
    ...(response.headers.get("x-cashloom-cache")
      ? { serverCacheState: response.headers.get("x-cashloom-cache")! }
      : {}),
    ...(serverSnapshotAgeSeconds !== undefined ? { serverSnapshotAgeSeconds } : {}),
  };

  if (response.status === 304) {
    if (!requestEtag) {
      throw new WorldApiError("The World feed returned 304 without a local snapshot validator.", 304);
    }
    return {
      kind: "not-modified",
      ...receipt,
      etag: validResponseEtag ?? requestEtag,
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        const problemDetail = [body.detail, body.error, body.title]
          .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        if (problemDetail) detail = ` ${problemDetail.trim()}`;
      }
    } catch {
      // The status code remains the useful receipt when the body is not JSON.
    }
    throw new WorldApiError(
      `The World feed returned ${response.status}.${detail}`.trim(),
      response.status,
    );
  }

  const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new WorldApiError(
      `The World feed answered with ${contentType || "an unknown content type"}, not JSON. Check the API route or production origin.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WorldApiError("The World feed claimed to be JSON but could not be decoded.", response.status);
  }
  return {
    kind: "modified",
    snapshot: parseWorldSnapshot(body, expectedBase, response.status),
    ...receipt,
    ...(validResponseEtag ? { etag: validResponseEtag } : {}),
  };
}
