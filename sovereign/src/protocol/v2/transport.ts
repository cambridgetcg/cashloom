/**
 * One-hop CashLoom v2 record transport.
 *
 * This module moves bytes to a caller-selected node. A descriptor URL is a
 * transport location only: resolving a signed descriptor endpoint against it
 * does not claim that DNS or TLS names are globally authoritative for the
 * descriptor's self-certifying key.
 */

import {
  assertSha256Id,
  parseCanonicalJson,
  type Sha256Id,
} from "@agenttool/wallet";
import {
  V2_MAX_RECORD_BYTES,
  V2_SCHEMAS,
  v2RecordBytes,
  verifyV2Record,
  type NodeDescriptorCore,
  type NodeEndpointRel,
  type VerifiedV2Record,
} from "./records.ts";

export const V2_RECORD_MEDIA_TYPE = "application/cashloom-record+json" as const;

export const DIRECT_TRANSPORT_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  maxRequestBytes: V2_MAX_RECORD_BYTES,
  maxResponseBytes: V2_MAX_RECORD_BYTES,
});

const MAX_TIMEOUT_MS = 60_000;
const MAX_ENDPOINT_PATH_BYTES = 512;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DirectNodeTarget {
  /** The caller-selected location from which this descriptor was obtained. */
  readonly descriptorUrl: string | URL;
  readonly descriptor: VerifiedV2Record<NodeDescriptorCore>;
  /**
   * The node-key pin selected out of band (for example in an invoice, QR, or
   * local contact). DNS discovery alone is not accepted as identity.
   */
  readonly expectedNodeKeyId: Sha256Id | string;
  /**
   * The exact transport origin selected alongside the key pin. A copied
   * descriptor at another mirror must not redirect private bytes.
   */
  readonly expectedOrigin: string | URL;
}

export interface DirectTransportOptions {
  readonly fetch?: FetchLike;
  /** Injectable verification clock for the signed descriptor lifetime. */
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface PostV2RecordResult {
  readonly status: number;
  readonly record_id: Sha256Id;
  readonly inserted: boolean;
}

export type DirectTransportErrorCode =
  | "INVALID_TARGET"
  | "INVALID_ENDPOINT"
  | "INVALID_BOUNDS"
  | "TIMEOUT"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_REFUSED"
  | "HTTP_ERROR"
  | "CONTENT_TYPE"
  | "FETCH_FAILED"
  | "RECORD_MISMATCH"
  | "ACK_MISMATCH"
  | "PRIVATE_TARGET_MISMATCH"
  | "NON_PUBLIC_RECORD";

export class DirectTransportError extends Error {
  readonly code: DirectTransportErrorCode;

  constructor(code: DirectTransportErrorCode, message: string) {
    super(message);
    this.name = "DirectTransportError";
    this.code = code;
  }
}

interface ResolvedTransportOptions {
  fetch: FetchLike;
  now: string;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

const transportError = (
  code: DirectTransportErrorCode,
  message: string,
): never => {
  throw new DirectTransportError(code, message);
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > maximum
  ) {
    return transportError(
      "INVALID_BOUNDS",
      `${label} must be an integer from 1 through ${maximum}.`,
    );
  }
  return selected;
}

function resolveOptions(
  options: DirectTransportOptions,
): ResolvedTransportOptions {
  return {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    now: (options.now ?? (() => new Date().toISOString()))(),
    timeoutMs: boundedInteger(
      options.timeoutMs,
      DIRECT_TRANSPORT_DEFAULTS.timeoutMs,
      MAX_TIMEOUT_MS,
      "timeoutMs",
    ),
    maxRequestBytes: boundedInteger(
      options.maxRequestBytes,
      DIRECT_TRANSPORT_DEFAULTS.maxRequestBytes,
      V2_MAX_RECORD_BYTES,
      "maxRequestBytes",
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes,
      DIRECT_TRANSPORT_DEFAULTS.maxResponseBytes,
      V2_MAX_RECORD_BYTES,
      "maxResponseBytes",
    ),
  };
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

function absoluteTransportUrl(
  value: string | URL,
  label: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.toString());
  } catch {
    return transportError("INVALID_TARGET", `${label} must be an absolute URL.`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return transportError(
      "INVALID_TARGET",
      `${label} must not contain credentials or a fragment.`,
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    return transportError(
      "INVALID_TARGET",
      `${label} must use HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or ::1.`,
    );
  }
  return parsed;
}

/**
 * Resolve one concrete descriptor path while retaining the descriptor URL's
 * exact origin. This is URL resolution, not an identity or discovery claim.
 */
export function resolveDescriptorRelativeUrl(
  descriptorUrl: string | URL,
  endpointPath: string,
): URL {
  const base = absoluteTransportUrl(descriptorUrl, "descriptorUrl");
  if (
    typeof endpointPath !== "string" ||
    endpointPath.length === 0 ||
    new TextEncoder().encode(endpointPath).byteLength >
      MAX_ENDPOINT_PATH_BYTES ||
    !endpointPath.startsWith("/") ||
    endpointPath.startsWith("//") ||
    endpointPath.includes("\\") ||
    endpointPath.includes("?") ||
    endpointPath.includes("#") ||
    endpointPath.includes("{") ||
    endpointPath.includes("}") ||
    /(?:^|\/)\.\.?($|\/)/u.test(endpointPath) ||
    /%(?:2e|2f|5c)/iu.test(endpointPath)
  ) {
    return transportError(
      "INVALID_ENDPOINT",
      "Descriptor endpoint must be a bounded, concrete origin-relative path without traversal, query, fragment, or encoded path separators.",
    );
  }

  let resolved: URL;
  try {
    resolved = new URL(endpointPath, base);
  } catch {
    return transportError(
      "INVALID_ENDPOINT",
      "Descriptor endpoint could not be resolved.",
    );
  }
  if (
    resolved.origin !== base.origin ||
    resolved.protocol !== base.protocol
  ) {
    return transportError(
      "INVALID_ENDPOINT",
      "Descriptor endpoint must retain the descriptor URL origin and scheme.",
    );
  }
  return absoluteTransportUrl(resolved, "resolved endpoint");
}

function verifiedDescriptor(
  target: DirectNodeTarget,
  now: string,
): VerifiedV2Record<NodeDescriptorCore> {
  let descriptor: VerifiedV2Record;
  try {
    descriptor = verifyV2Record(target.descriptor, { now });
  } catch {
    return transportError(
      "INVALID_TARGET",
      "Direct-node target must carry an active valid signed v2 descriptor.",
    );
  }
  if (descriptor.schema !== V2_SCHEMAS.node_descriptor) {
    return transportError(
      "INVALID_ENDPOINT",
      "Direct-node target must carry a verified v2 node descriptor.",
    );
  }
  try {
    assertSha256Id(target.expectedNodeKeyId, "expectedNodeKeyId");
  } catch {
    return transportError(
      "INVALID_TARGET",
      "Direct-node target requires a valid explicitly pinned node key id.",
    );
  }
  if (descriptor.authority.key_id !== target.expectedNodeKeyId) {
    return transportError(
      "INVALID_TARGET",
      "Signed descriptor authority does not match the explicitly pinned node key.",
    );
  }
  return descriptor as VerifiedV2Record<NodeDescriptorCore>;
}

function endpointPath(
  target: DirectNodeTarget,
  relation: NodeEndpointRel,
  now: string,
  recordId?: Sha256Id,
): URL {
  const descriptor = verifiedDescriptor(target, now);
  const descriptorLocation = absoluteTransportUrl(
    target.descriptorUrl,
    "descriptorUrl",
  );
  const pinnedOrigin = absoluteTransportUrl(
    target.expectedOrigin,
    "expectedOrigin",
  );
  if (
    pinnedOrigin.pathname !== "/"
    || pinnedOrigin.search !== ""
    || descriptorLocation.origin !== pinnedOrigin.origin
  ) {
    return transportError(
      "INVALID_TARGET",
      "Descriptor URL origin does not match the caller's explicit transport-origin pin.",
    );
  }
  const matches = descriptor.endpoints.filter(
    (endpoint) => endpoint.rel === relation,
  );
  if (matches.length !== 1) {
    return transportError(
      "INVALID_ENDPOINT",
      `Descriptor must contain exactly one ${relation} endpoint.`,
    );
  }
  const template = matches[0]!.path;

  let concrete: string;
  if (relation === "record_read") {
    if (
      recordId === undefined ||
      template.split("{record_id}").length !== 2 ||
      template.replace("{record_id}", "").includes("{") ||
      template.replace("{record_id}", "").includes("}")
    ) {
      return transportError(
        "INVALID_ENDPOINT",
        "record_read endpoint must contain exactly one {record_id} placeholder and no other template fields.",
      );
    }
    concrete = template.replace("{record_id}", recordId);
  } else {
    if (template.includes("{") || template.includes("}")) {
      return transportError(
        "INVALID_ENDPOINT",
        "records_ingest endpoint must not contain template fields.",
      );
    }
    concrete = template;
  }

  return resolveDescriptorRelativeUrl(target.descriptorUrl, concrete);
}

function contentLength(response: Response, maximum: number): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    return transportError(
      "RESPONSE_TOO_LARGE",
      "Response Content-Length is not a canonical non-negative integer.",
    );
  }
  if (BigInt(raw) > BigInt(maximum)) {
    return transportError(
      "RESPONSE_TOO_LARGE",
      `Response exceeds the ${maximum}-byte limit.`,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  deadline: Promise<never>,
): Promise<Uint8Array> {
  contentLength(response, maximum);
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value.byteLength > maximum - total) {
        return transportError(
          "RESPONSE_TOO_LARGE",
          `Response exceeds the ${maximum}-byte limit.`,
        );
      }
      const copy = Uint8Array.from(part.value);
      chunks.push(copy);
      total += copy.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The primary bounded-read error is authoritative.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function requestOnce(
  url: URL,
  init: RequestInit,
  options: ResolvedTransportOptions,
): Promise<{ response: Response; body: Uint8Array }> {
  const controller = new AbortController();
  const timeoutError = new DirectTransportError(
    "TIMEOUT",
    `Direct-node request exceeded ${options.timeoutMs}ms.`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });

  try {
    // Exactly one fetch call: no retry, failover, or redirect replay occurs.
    const response = await Promise.race([
      options.fetch(url.href, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      }),
      deadline,
    ]);

    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      return transportError(
        "REDIRECT_REFUSED",
        "Direct-node transport refuses redirects.",
      );
    }
    if (response.url !== "") {
      let responseUrl: URL;
      try {
        responseUrl = new URL(response.url);
      } catch {
        return transportError(
          "REDIRECT_REFUSED",
          "Response URL is invalid.",
        );
      }
      if (responseUrl.href !== url.href) {
        return transportError(
          "REDIRECT_REFUSED",
          "Response URL differs from the requested direct-node URL.",
        );
      }
    }
    if (!response.ok) {
      return transportError(
        "HTTP_ERROR",
        `Direct-node request failed with HTTP ${response.status}.`,
      );
    }

    return {
      response,
      body: await readBoundedBody(
        response,
        options.maxResponseBytes,
        deadline,
      ),
    };
  } catch (error) {
    if (
      error === timeoutError ||
      (controller.signal.aborted && controller.signal.reason === timeoutError)
    ) {
      throw timeoutError;
    }
    if (error instanceof DirectTransportError) throw error;
    throw new DirectTransportError(
      "FETCH_FAILED",
      `Direct-node fetch failed (${error instanceof Error ? error.name : "unknown error"}).`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireRecordMediaType(response: Response): void {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== V2_RECORD_MEDIA_TYPE) {
    return transportError(
      "CONTENT_TYPE",
      `Expected ${V2_RECORD_MEDIA_TYPE}.`,
    );
  }
}

function requireJsonMediaType(response: Response): void {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return transportError(
      "CONTENT_TYPE",
      "Record ingest acknowledgement must use application/json.",
    );
  }
}

function parseIngestAcknowledgement(
  bytes: Uint8Array,
  expectedRecordId: Sha256Id,
): { readonly inserted: boolean; readonly record_id: Sha256Id } {
  let value: unknown;
  try {
    value = parseCanonicalJson(bytes);
  } catch {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement must be canonical JSON.",
    );
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement must be an object.",
    );
  }
  const acknowledgement = value as Record<string, unknown>;
  const keys = Object.keys(acknowledgement).sort();
  if (
    keys.length !== 2
    || keys[0] !== "inserted"
    || keys[1] !== "record_id"
    || typeof acknowledgement.inserted !== "boolean"
  ) {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement has an unexpected schema.",
    );
  }
  try {
    assertSha256Id(acknowledgement.record_id, "acknowledgement.record_id");
  } catch {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement has an invalid record id.",
    );
  }
  if (acknowledgement.record_id !== expectedRecordId) {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement does not match the submitted record.",
    );
  }
  return {
    inserted: acknowledgement.inserted,
    record_id: acknowledgement.record_id as Sha256Id,
  };
}

export async function postV2Record(
  target: DirectNodeTarget,
  recordValue: VerifiedV2Record,
  options: DirectTransportOptions = {},
): Promise<PostV2RecordResult> {
  const resolved = resolveOptions(options);
  const record = verifyV2Record(recordValue);
  const bytes = v2RecordBytes(record);
  if (bytes.byteLength > resolved.maxRequestBytes) {
    return transportError(
      "REQUEST_TOO_LARGE",
      `Canonical record exceeds the ${resolved.maxRequestBytes}-byte request limit.`,
    );
  }
  const url = endpointPath(target, "records_ingest", resolved.now);
  if (
    record.disclosure === "private"
    && record.audience !== target.expectedNodeKeyId
  ) {
    return transportError(
      "PRIVATE_TARGET_MISMATCH",
      "A private record may only be sent to its signed audience key.",
    );
  }
  const { response, body } = await requestOnce(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": V2_RECORD_MEDIA_TYPE,
      },
      body: Uint8Array.from(bytes),
    },
    resolved,
  );
  requireJsonMediaType(response);
  const acknowledgement = parseIngestAcknowledgement(body, record.record_id);
  if (
    (response.status !== 201 || acknowledgement.inserted !== true)
    && (response.status !== 200 || acknowledgement.inserted !== false)
  ) {
    return transportError(
      "ACK_MISMATCH",
      "Record ingest acknowledgement status and inserted flag disagree.",
    );
  }
  return {
    status: response.status,
    record_id: acknowledgement.record_id,
    inserted: acknowledgement.inserted,
  };
}

export async function getPublicV2Record(
  target: DirectNodeTarget,
  recordIdValue: string,
  options: DirectTransportOptions = {},
): Promise<VerifiedV2Record> {
  assertSha256Id(recordIdValue, "record_id");
  const recordId = recordIdValue as Sha256Id;
  const resolved = resolveOptions(options);
  const url = endpointPath(target, "record_read", resolved.now, recordId);
  const { response, body } = await requestOnce(
    url,
    {
      method: "GET",
      headers: { accept: V2_RECORD_MEDIA_TYPE },
    },
    resolved,
  );
  if (response.status !== 200) {
    return transportError(
      "HTTP_ERROR",
      `Public record retrieval requires HTTP 200; received ${response.status}.`,
    );
  }
  requireRecordMediaType(response);
  const record = verifyV2Record(parseCanonicalJson(body));
  if (record.record_id !== recordId) {
    return transportError(
      "RECORD_MISMATCH",
      "Retrieved record does not match the requested sha256 id.",
    );
  }
  if (record.disclosure !== "public") {
    return transportError(
      "NON_PUBLIC_RECORD",
      "Direct public retrieval refuses records not marked public.",
    );
  }
  return record;
}
