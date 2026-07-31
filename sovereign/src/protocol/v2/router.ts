/**
 * Narrow HTTP doors for the sovereign CashLoom v2 node.
 *
 * mountV2PublicRoutes belongs before the existing /api/* session gate.
 * mountV2LocalRoutes belongs after it. The hosted info-only entrypoint imports
 * neither function.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  canonicalJsonBytes,
  WalletProtocolError,
  type Sha256Id,
} from "@agenttool/wallet";
import type { AssetTrustManifest, AssetTrustPolicy } from "./asset-trust.ts";
import type {
  AssetTrustSelection,
  V2LocalService,
} from "./local-service.ts";
import { V2LocalServiceError } from "./local-service.ts";
import {
  V2_PAY_LINK_ACCEPTANCE_MAX_BYTES,
  V2_PAY_LINK_ACCEPTANCE_SCHEMA,
  V2PayLinkAcceptanceError,
} from "./pay-link-acceptance.ts";
import {
  V2PayLinkWorkflowError,
  createV2PayLinkService,
  inspectV2PayLink,
  inspectV2PayLinkAcceptance,
} from "./pay-link-service.ts";
import {
  V2_PAY_LINK_BUNDLE_SCHEMA,
  V2_PAY_LINK_MAX_BYTES,
  V2PayLinkError,
} from "./pay-link.ts";
import {
  V2RecordStoreError,
  type CashLoomV2RecordStore,
} from "./record-store.ts";
import {
  V2_MAX_RECORD_BYTES,
  v2RecordBytes,
  verifyV2Record,
  type V2Audience,
  type VerifiedV2Record,
} from "./records.ts";
import { V2_RECORD_MEDIA_TYPE } from "./transport.ts";

const LOCAL_COMMAND_MAX_BYTES = 64 * 1024;
// A canonical 64 KiB bundle is carried inside one JSON string, whose quotes
// and backslashes are escaped again at the local HTTP boundary.
const PORTABLE_COMMAND_MAX_BYTES = 192 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const HASH = /^sha256:[0-9a-f]{64}$/u;

export interface V2PublicRouteDependencies {
  readonly store: () => CashLoomV2RecordStore;
  readonly now?: () => string;
}

export interface V2LocalRouteDependencies {
  readonly store: () => CashLoomV2RecordStore;
  readonly service: () => Promise<V2LocalService>;
  readonly now?: () => string;
}

export class V2RouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "V2RouteError";
    this.status = status;
    this.code = code;
  }
}

const hash = z.string().regex(HASH);
const audience = z.union([z.literal("public"), hash]);
const disclosure = z.enum(["public", "private"]);
const ttl = z.number().int().min(1).optional();
const assetTrustSelection = z
  .object({
    record_id: hash,
    trusted_authority_key_id: hash,
    policy: z.unknown().optional(),
  })
  .strict();

const activateNodeSchema = z
  .object({
    roles: z
      .array(z.enum(["merchant", "payer", "relay", "watcher"]))
      .min(1)
      .max(4)
      .optional(),
    ttl_seconds: ttl,
  })
  .strict();

const createManifestSchema = z
  .object({
    manifest: z.unknown(),
    audience: audience.optional(),
    disclosure: disclosure.optional(),
    ttl_seconds: ttl,
  })
  .strict();

const evaluateAssetSchema = z
  .object({
    rail: z.string().min(1).max(64),
    asset_id: z.string().min(1).max(256),
    asset_trust: assetTrustSelection,
  })
  .strict();

const createRequestSchema = z
  .object({
    rail: z.string().min(1).max(64),
    destination: z.string().min(1).max(512),
    asset_id: z.string().min(1).max(256),
    amount_atomic: z.string().regex(/^(0|[1-9][0-9]*)$/u).max(80),
    purpose_hash: hash,
    asset_trust: assetTrustSelection,
    audience: audience.optional(),
    disclosure: disclosure.optional(),
    ttl_seconds: ttl,
  })
  .strict();

const createIntentSchema = z
  .object({
    request_record_id: hash,
    source_account: z.string().min(1).max(512),
    fee_asset_id: z.string().min(1).max(256),
    max_fee_atomic: z.string().regex(/^(0|[1-9][0-9]*)$/u).max(80),
    payment_asset_trust: assetTrustSelection,
    fee_asset_trust: assetTrustSelection,
    ttl_seconds: ttl,
  })
  .strict();

const createPayLinkSchema = z
  .object({
    destination: z.string().min(1).max(512),
    amount_sats: z.string().regex(/^[1-9][0-9]*$/u).max(80),
    note: z.string().optional(),
    ttl_seconds: ttl,
  })
  .strict();

const portableBundleSchema = z
  .object({
    bundle: z.string().min(1),
  })
  .strict();

const inspectPortableBundleSchema = z
  .object({
    bundle: z.string().min(1),
    expected_merchant_key_id: hash.optional(),
  })
  .strict();

const acceptPayLinkSchema = z
  .object({
    bundle: z.string().min(1),
    source_account: z.string().min(1).max(512),
    max_fee_sats: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .max(80),
  })
  .strict();

function contentType(request: Request): string | undefined {
  return request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

function declaredLength(request: Request, maximum: number): void {
  const value = request.headers.get("content-length");
  if (value === null) return;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new V2RouteError(
      400,
      "invalid_content_length",
      "Content-Length must be a canonical non-negative integer.",
    );
  }
  if (BigInt(value) > BigInt(maximum)) {
    throw new V2RouteError(
      413,
      "body_too_large",
      `Request body exceeds ${maximum} bytes.`,
    );
  }
}

export async function readBoundedRequestBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  declaredLength(request, maximum);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new V2RouteError(
            408,
            "body_timeout",
            `Request body did not arrive within ${REQUEST_BODY_TIMEOUT_MS}ms.`,
          ),
        ),
      REQUEST_BODY_TIMEOUT_MS,
    );
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value.byteLength > maximum - total) {
        throw new V2RouteError(
          413,
          "body_too_large",
          `Request body exceeds ${maximum} bytes.`,
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
      // Preserve the bounded-read error.
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function localJson(
  request: Request,
  maximum = LOCAL_COMMAND_MAX_BYTES,
): Promise<unknown> {
  if (contentType(request) !== "application/json") {
    throw new V2RouteError(
      415,
      "unsupported_media_type",
      "Local v2 commands require application/json.",
    );
  }
  const bytes = await readBoundedRequestBody(request, maximum);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new V2RouteError(400, "invalid_utf8", "Request body must be UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new V2RouteError(400, "invalid_json", "Request body must be JSON.");
  }
}

function recordResponse(
  record: VerifiedV2Record,
  cacheControl: string,
): Response {
  const bytes = Uint8Array.from(v2RecordBytes(record));
  return new Response(bytes.buffer, {
    status: 200,
    headers: {
      "cache-control": cacheControl,
      "content-type": V2_RECORD_MEDIA_TYPE,
      "x-content-type-options": "nosniff",
    },
  });
}

function problem(
  c: Context,
  error: unknown,
): Response {
  if (error instanceof V2RouteError) {
    return c.json(
      { error: error.code, message: error.message },
      error.status as 400,
    );
  }
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: "invalid_command",
        message: "The local v2 command has an invalid or unknown field.",
      },
      400,
    );
  }
  if (error instanceof V2RecordStoreError) {
    const status =
      error.code === "ISSUER_NONCE_CONFLICT"
      || error.code === "PARENT_NOT_FOUND"
      || error.code === "TRANSITION_CONFLICT"
        ? 409
        : error.code === "REMOTE_LIMIT_EXCEEDED"
          ? 507
          : error.code === "PRIVATE_AUDIENCE_MISMATCH"
            ? 403
            : error.code === "INVALID_CONFIGURATION"
              ? 500
              : 500;
    return c.json(
      { error: error.code.toLowerCase(), message: error.message },
      status as 400,
    );
  }
  if (error instanceof V2LocalServiceError) {
    const status =
      error.code === "NODE_NOT_ACTIVATED" ? 409
      : error.code === "WRONG_RECORD_KIND" ? 404
      : 403;
    return c.json(
      {
        error: error.code.toLowerCase(),
        message: error.message,
        ...(error.decision ? { decision: error.decision } : {}),
      },
      status as 400,
    );
  }
  if (
    error instanceof V2PayLinkError
    || error instanceof V2PayLinkAcceptanceError
    || error instanceof V2PayLinkWorkflowError
  ) {
    const code = error.code.toLowerCase();
    const status =
      error.code === "BUNDLE_TOO_LARGE"
      || error.code === "ACCEPTANCE_TOO_LARGE"
        ? 413
        : error.code === "NODE_NOT_ACTIVATED"
          || error.code === "ACCEPTANCE_CONFLICT"
          ? 409
          : error.code === "MERCHANT_KEY_MISMATCH"
            || error.code === "WRONG_AUDIENCE"
            ? 403
            : 422;
    return c.json(
      {
        error: code,
        message: error.message,
        ...("decision" in error && error.decision
          ? { decision: error.decision }
          : {}),
      },
      status as 400,
    );
  }
  if (error instanceof WalletProtocolError || error instanceof TypeError) {
    return c.json(
      {
        error: "invalid_record",
        message: error.message,
      },
      422,
    );
  }
  return c.json(
    {
      error: "v2_internal_error",
      message: "The sovereign node could not complete the v2 operation.",
    },
    500,
  );
}

function missing(c: Context): Response {
  // Missing and private are deliberately indistinguishable on public reads.
  return c.json(
    { error: "not_found", message: "No public record exists at this id." },
    404,
  );
}

export function mountV2PublicRoutes(
  app: Hono,
  dependencies: V2PublicRouteDependencies,
): void {
  const now = dependencies.now ?? (() => new Date().toISOString());

  app.get("/.well-known/cashloom/v2", (c) => {
    try {
      const descriptor = dependencies.store().latestPublicNodeDescriptor();
      if (descriptor === null) return missing(c);
      const active = verifyV2Record(descriptor, { now: now() });
      return recordResponse(active, "no-store");
    } catch (error) {
      if (
        error instanceof WalletProtocolError
        && error.code === "INVALID_STATE_TRANSITION"
      ) {
        return missing(c);
      }
      return problem(c, error);
    }
  });

  app.post("/v2/records", async (c) => {
    try {
      if (contentType(c.req.raw) !== V2_RECORD_MEDIA_TYPE) {
        throw new V2RouteError(
          415,
          "unsupported_media_type",
          `Record ingest requires ${V2_RECORD_MEDIA_TYPE}.`,
        );
      }
      const bytes = await readBoundedRequestBody(
        c.req.raw,
        V2_MAX_RECORD_BYTES,
      );
      const result = dependencies.store().append(bytes, "remote");
      const acknowledgement = canonicalJsonBytes({
        inserted: result.inserted,
        record_id: result.record.record_id,
      });
      return new Response(Uint8Array.from(acknowledgement).buffer, {
        status: result.inserted ? 201 : 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get("/v2/records/:recordId", (c) => {
    try {
      const recordId = c.req.param("recordId");
      if (!HASH.test(recordId)) return missing(c);
      const record = dependencies.store().getPublic(recordId);
      if (record === null) return missing(c);
      return recordResponse(record, "public, max-age=31536000, immutable");
    } catch (error) {
      return problem(c, error);
    }
  });
}

export function mountV2LocalRoutes(
  app: Hono,
  dependencies: V2LocalRouteDependencies,
): void {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const payLinks = () =>
    createV2PayLinkService({
      store: dependencies.store,
      localService: dependencies.service,
      now,
    });

  app.get("/api/v2/records/:recordId", (c) => {
    try {
      const recordId = c.req.param("recordId");
      if (!HASH.test(recordId)) return missing(c);
      const record = dependencies.store().getLocal(recordId);
      if (record === null) return missing(c);
      return recordResponse(record, "no-store");
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/node/activate", async (c) => {
    try {
      const input = activateNodeSchema.parse(await localJson(c.req.raw));
      const service = await dependencies.service();
      const record = await service.activateNode(input);
      return c.json({ record }, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/asset-trust-manifests", async (c) => {
    try {
      const input = createManifestSchema.parse(await localJson(c.req.raw));
      const service = await dependencies.service();
      const record = await service.createAssetTrustManifest({
        ...input,
        audience: input.audience as V2Audience | undefined,
        manifest: input.manifest as AssetTrustManifest,
      });
      return c.json({ record }, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/assets/evaluate", async (c) => {
    try {
      const input = evaluateAssetSchema.parse(await localJson(c.req.raw));
      const service = await dependencies.service();
      const decision = service.evaluateAssetTrust(
        input.asset_trust as AssetTrustSelection,
        input.asset_id,
        input.rail,
      );
      return c.json({ decision });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/payment-requests", async (c) => {
    try {
      const input = createRequestSchema.parse(await localJson(c.req.raw));
      const service = await dependencies.service();
      const result = await service.createPaymentRequest({
        ...input,
        audience: input.audience as V2Audience | undefined,
        purpose_hash: input.purpose_hash as Sha256Id,
        asset_trust: {
          ...input.asset_trust,
          policy: input.asset_trust.policy as AssetTrustPolicy | undefined,
        },
      });
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/payment-intents", async (c) => {
    try {
      const input = createIntentSchema.parse(await localJson(c.req.raw));
      const service = await dependencies.service();
      const result = await service.createPaymentIntent({
        ...input,
        payment_asset_trust: {
          ...input.payment_asset_trust,
          policy: input.payment_asset_trust.policy as
            | AssetTrustPolicy
            | undefined,
        },
        fee_asset_trust: {
          ...input.fee_asset_trust,
          policy: input.fee_asset_trust.policy as
            | AssetTrustPolicy
            | undefined,
        },
      });
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/pay-links", async (c) => {
    try {
      const input = createPayLinkSchema.parse(
        await localJson(c.req.raw),
      );
      const result = await payLinks().createBitcoinPayLink(input);
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/pay-links/inspect", async (c) => {
    try {
      const input = inspectPortableBundleSchema.parse(
        await localJson(c.req.raw, PORTABLE_COMMAND_MAX_BYTES),
      );
      const bytes = new TextEncoder().encode(input.bundle);
      if (
        bytes.byteLength > Math.max(
          V2_PAY_LINK_MAX_BYTES,
          V2_PAY_LINK_ACCEPTANCE_MAX_BYTES,
        )
      ) {
        throw new V2RouteError(
          413,
          "bundle_too_large",
          "The portable CashLoom bundle exceeds 64 KiB.",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.bundle);
      } catch {
        throw new V2RouteError(
          422,
          "invalid_bundle",
          "The portable CashLoom bundle is not canonical JSON.",
        );
      }
      const schema =
        parsed !== null
        && typeof parsed === "object"
        && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).schema
          : undefined;
      if (schema === V2_PAY_LINK_BUNDLE_SCHEMA) {
        return c.json({
          projection: inspectV2PayLink(bytes, {
            now: now(),
            expectedMerchantKeyId: input.expected_merchant_key_id,
          }),
        });
      }
      if (schema === V2_PAY_LINK_ACCEPTANCE_SCHEMA) {
        const descriptor =
          dependencies.store().latestPublicNodeDescriptor();
        if (descriptor === null) {
          throw new V2PayLinkWorkflowError(
            "NODE_NOT_ACTIVATED",
            "This node has no local merchant key with which to inspect the acceptance.",
          );
        }
        if (
          input.expected_merchant_key_id !== undefined
          && input.expected_merchant_key_id
            !== descriptor.authority.key_id
        ) {
          throw new V2PayLinkError(
            "MERCHANT_KEY_MISMATCH",
            "The supplied merchant key does not match this local merchant node.",
          );
        }
        return c.json({
          projection: inspectV2PayLinkAcceptance(bytes, {
            expectedMerchantKeyId: descriptor.authority.key_id,
            now: now(),
          }),
        });
      }
      throw new V2RouteError(
        422,
        "unknown_bundle_schema",
        "The file is neither a CashLoom Pay Link nor an acceptance bundle.",
      );
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/pay-links/accept", async (c) => {
    try {
      const input = acceptPayLinkSchema.parse(
        await localJson(c.req.raw, PORTABLE_COMMAND_MAX_BYTES),
      );
      const result = await payLinks().acceptBitcoinPayLink({
        ...input,
        bundle: new TextEncoder().encode(input.bundle),
      });
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post("/api/v2/pay-links/acceptances/import", async (c) => {
    try {
      const input = portableBundleSchema.parse(
        await localJson(c.req.raw, PORTABLE_COMMAND_MAX_BYTES),
      );
      const result = payLinks().importPayLinkAcceptance(
        new TextEncoder().encode(input.bundle),
      );
      return c.json(result);
    } catch (error) {
      return problem(c, error);
    }
  });
}
