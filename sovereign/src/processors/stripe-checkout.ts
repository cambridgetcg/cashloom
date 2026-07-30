/**
 * Stripe Connect hosted Checkout — sandbox contract.
 *
 * This is an inbound collection for a connected seller, not an outbound
 * PaymentSender. It has no credential resolver and no live HTTP implementation:
 * callers inject a transport, while this module compiles the exact request,
 * persists idempotency before egress, and projects authenticated Connect
 * webhooks into a separate local lifecycle.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "@agenttool/wallet";
import { db, newId } from "../db.ts";
import { stripeDecimalsFor } from "../stripe-currency.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTED_ACCOUNT = /^acct_[A-Za-z0-9]{8,255}$/;
const CHECKOUT_SESSION = /^cs_test_[A-Za-z0-9]{8,255}$/;
const PAYMENT_INTENT = /^pi_[A-Za-z0-9]{8,255}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{8,255}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const CURRENCY = /^[A-Z]{3}$/;
const SIGNATURE = /^[0-9a-fA-F]{64}$/;
const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_WEBHOOK_BYTES = 128 * 1024;
const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface PrepareStripeCheckout {
  intentId: string;
  accountId: string;
  amountMinor: string;
  purpose: string;
}

export interface StripeDirectCheckoutRequest {
  method: "POST";
  path: "/v1/checkout/sessions";
  connectedAccountId: string;
  idempotencyKey: string;
  form: Readonly<Record<string, string>>;
}

export interface StripeDirectCheckoutResponse {
  id: string;
  object: "checkout.session";
  url: string | null;
  livemode: boolean;
  client_reference_id: string | null;
  currency: string | null;
  amount_total: number | null;
  payment_intent: string | null;
  metadata: Readonly<Record<string, string>> | null;
}

export interface StripeCheckoutTransport {
  /**
   * Implementations add their own test credential. The request contains no
   * bearer or webhook secret and is already scoped to one connected account.
   */
  createDirectCheckout(
    request: Readonly<StripeDirectCheckoutRequest>,
  ): Promise<StripeDirectCheckoutResponse>;
}

export interface StripeCheckoutRuntime {
  transport: StripeCheckoutTransport;
  /** Fixed node configuration, never request-controlled. */
  returnBaseUrl: string;
  now?: () => Date;
}

export type StripeCheckoutStatus =
  | "prepared"
  | "submitting"
  | "submitted"
  | "submission_unknown"
  | "provider_reported_paid"
  | "expired"
  | "rejected";

interface CheckoutRow {
  id: string;
  intent_id: string;
  account_id: string;
  connected_account_id: string;
  currency: string;
  amount_minor: string;
  purpose: string;
  return_base_url: string;
  idempotency_key: string;
  request_sha256: string;
  request_json: string;
  status: StripeCheckoutStatus;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  checkout_url: string | null;
  livemode: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface StripeAccountRow {
  id: string;
  currency: string;
  decimals: number;
  external_account_id: string | null;
}

export interface StripeCheckoutOperation {
  operationId: string;
  intentId: string;
  status: StripeCheckoutStatus;
  connectedAccountId: string;
  currency: string;
  amountMinor: string;
  checkoutSessionId: string | null;
  checkoutUrl: string | null;
  paymentIntentId: string | null;
  cashloomFeeMinor: "0";
  providerFeeMinor: null;
  providerFeeStatus: "unknown_until_provider_reconciliation";
  settlement: "webhook_observed";
  errorCode: string | null;
}

export interface StripeWebhookResult {
  eventId: string;
  duplicate: boolean;
  disposition: "applied" | "ignored" | "refused" | "unmatched";
  operationId: string | null;
  status: StripeCheckoutStatus | null;
}

class ProviderIdentityConflictError extends Error {}

const sha256Id = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${Buffer.from(sha256(bytes)).toString("hex")}`;

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const operationFromRow = (row: CheckoutRow): StripeCheckoutOperation => ({
  operationId: row.id,
  intentId: row.intent_id,
  status: row.status,
  connectedAccountId: row.connected_account_id,
  currency: row.currency,
  amountMinor: row.amount_minor,
  checkoutSessionId: row.checkout_session_id,
  checkoutUrl: row.checkout_url,
  paymentIntentId: row.payment_intent_id,
  cashloomFeeMinor: "0",
  providerFeeMinor: null,
  providerFeeStatus: "unknown_until_provider_reconciliation",
  settlement: "webhook_observed",
  errorCode: row.error_code,
});

const checkoutRow = (operationId: string): CheckoutRow => {
  const row = db
    .query("SELECT * FROM stripe_checkout_operations WHERE id = ?")
    .get(operationId) as CheckoutRow | null;
  if (!row) throw new Error("Stripe Checkout operation disappeared from local storage.");
  return row;
};

const validateReturnBaseUrl = (value: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("Stripe sandbox returnBaseUrl must be a bounded absolute URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stripe sandbox returnBaseUrl must be an absolute URL.");
  }
  const loopback =
    url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "Stripe sandbox returnBaseUrl must be an HTTPS origin (or loopback HTTP) without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
};

const validatePurpose = (value: string): string => {
  if (
    value !== value.trim()
    || value.length === 0
    || textBytes(value).byteLength > 120
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Stripe Checkout purpose must be 1..120 clean UTF-8 bytes.");
  }
  return value;
};

const accountForCheckout = (accountId: string): StripeAccountRow => {
  if (!UUID.test(accountId)) {
    throw new Error("Stripe Checkout accountId must be a UUID.");
  }
  const account = db
    .query(
      `SELECT id, currency, decimals, external_account_id
       FROM accounts
       WHERE id = ? AND rail = 'STRIPE' AND status = 'ACTIVE'`,
    )
    .get(accountId) as StripeAccountRow | null;
  if (!account) {
    throw new Error("Stripe Checkout requires an active STRIPE account.");
  }
  if (!account.external_account_id || !CONNECTED_ACCOUNT.test(account.external_account_id)) {
    throw new Error("Stripe Checkout account has no valid connected-account id.");
  }
  if (!CURRENCY.test(account.currency)) {
    throw new Error("Stripe Checkout account currency must be a canonical ISO code.");
  }
  const providerDecimals = stripeDecimalsFor(account.currency);
  if (account.decimals !== providerDecimals) {
    throw new Error(
      `Stripe Checkout account uses ${account.decimals} decimals for ${account.currency}; `
        + `Stripe requires ${providerDecimals}. Refusing to mis-scale the collection.`,
    );
  }
  return account;
};

const validateInput = (
  input: PrepareStripeCheckout,
): { amountMinor: string; purpose: string } => {
  if (!UUID.test(input.intentId)) {
    throw new Error("Stripe Checkout intentId must be a UUID.");
  }
  if (
    input.amountMinor.length > 16
    || !AMOUNT.test(input.amountMinor)
    || BigInt(input.amountMinor) > MAX_AMOUNT
  ) {
    throw new Error("Stripe Checkout amountMinor must be a positive safe integer string.");
  }
  return {
    amountMinor: input.amountMinor,
    purpose: validatePurpose(input.purpose),
  };
};

const compileRequest = (
  input: PrepareStripeCheckout,
  account: StripeAccountRow,
  returnBaseUrl: string,
): StripeDirectCheckoutRequest => {
  const idempotencyDigest = sha256Id(textBytes(`cashloom.stripe-checkout/0.1\0${input.intentId}`));
  const idempotencyKey = `cashloom-checkout-v1-${idempotencyDigest.slice("sha256:".length)}`;
  return Object.freeze({
    method: "POST" as const,
    path: "/v1/checkout/sessions" as const,
    connectedAccountId: account.external_account_id!,
    idempotencyKey,
    form: Object.freeze({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][price_data][currency]": account.currency.toLowerCase(),
      "line_items[0][price_data][product_data][name]": input.purpose,
      "line_items[0][price_data][unit_amount]": input.amountMinor,
      "line_items[0][quantity]": "1",
      client_reference_id: input.intentId,
      "metadata[cashloom_intent_id]": input.intentId,
      "payment_intent_data[metadata][cashloom_intent_id]": input.intentId,
      success_url:
        `${returnBaseUrl}/pay/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBaseUrl}/pay/stripe/cancel`,
    }),
  });
};

export const compileStripeSandboxCheckoutRequest = (
  input: PrepareStripeCheckout,
  returnBaseUrl: string,
): Readonly<StripeDirectCheckoutRequest> => {
  const validated = validateInput(input);
  const account = accountForCheckout(input.accountId);
  return compileRequest({ ...input, ...validated }, account, validateReturnBaseUrl(returnBaseUrl));
};

const requestCommitment = (
  request: StripeDirectCheckoutRequest,
): { json: string; sha256: string } => {
  const json = canonicalJson(request);
  return { json, sha256: sha256Id(textBytes(json)) };
};

const validateCheckoutUrl = (value: string | null): string => {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Stripe returned no bounded hosted Checkout URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stripe returned a malformed hosted Checkout URL.");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "checkout.stripe.com"
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error("Stripe returned a Checkout URL outside checkout.stripe.com.");
  }
  return value;
};

const validateResponse = (
  response: StripeDirectCheckoutResponse,
  input: PrepareStripeCheckout,
  currency: string,
): { sessionId: string; url: string; paymentIntentId: string | null } => {
  if (
    !response
    || response.object !== "checkout.session"
    || response.livemode !== false
    || !CHECKOUT_SESSION.test(response.id)
    || response.client_reference_id !== input.intentId
    || response.currency?.toUpperCase() !== currency
    || !Number.isSafeInteger(response.amount_total)
    || String(response.amount_total) !== input.amountMinor
    || response.metadata?.cashloom_intent_id !== input.intentId
    || (
      response.payment_intent !== null
      && !PAYMENT_INTENT.test(response.payment_intent)
    )
  ) {
    throw new Error("Stripe sandbox response does not match the committed Checkout request.");
  }
  return {
    sessionId: response.id,
    url: validateCheckoutUrl(response.url),
    paymentIntentId: response.payment_intent,
  };
};

const markSubmissionUnknown = (operationId: string, errorCode: string): CheckoutRow => {
  const now = new Date().toISOString();
  db.query(
    `UPDATE stripe_checkout_operations
     SET status = CASE
           WHEN status = 'submitting' THEN 'submission_unknown'
           ELSE status
         END,
         error_code = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(errorCode, now, operationId);
  return checkoutRow(operationId);
};

export const createStripeSandboxCheckout = async (
  input: PrepareStripeCheckout,
  runtime: StripeCheckoutRuntime,
): Promise<StripeCheckoutOperation> => {
  const validated = validateInput(input);
  const account = accountForCheckout(input.accountId);
  const returnBaseUrl = validateReturnBaseUrl(runtime.returnBaseUrl);
  const normalizedInput = { ...input, ...validated };
  const request = compileRequest(normalizedInput, account, returnBaseUrl);
  const commitment = requestCommitment(request);
  const now = (runtime.now?.() ?? new Date()).toISOString();
  const operationId = newId();

  const reserve = db.transaction((): { row: CheckoutRow; submit: boolean } => {
    const existing = db
      .query("SELECT * FROM stripe_checkout_operations WHERE intent_id = ?")
      .get(input.intentId) as CheckoutRow | null;
    if (existing) {
      if (
        existing.account_id !== account.id
        || existing.connected_account_id !== account.external_account_id
        || existing.currency !== account.currency
        || existing.amount_minor !== validated.amountMinor
        || existing.purpose !== validated.purpose
        || existing.return_base_url !== returnBaseUrl
        || existing.idempotency_key !== request.idempotencyKey
        || existing.request_sha256 !== commitment.sha256
        || existing.request_json !== commitment.json
      ) {
        throw new Error(
          "Stripe Checkout intentId is already committed to a different request.",
        );
      }
      return { row: existing, submit: false };
    }

    db.query(
      `INSERT INTO stripe_checkout_operations
         (id, intent_id, account_id, connected_account_id, currency,
          amount_minor, purpose, return_base_url, idempotency_key,
          request_sha256, request_json, status, livemode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', 0, ?, ?)`,
    ).run(
      operationId,
      input.intentId,
      account.id,
      account.external_account_id!,
      account.currency,
      validated.amountMinor,
      validated.purpose,
      returnBaseUrl,
      request.idempotencyKey,
      commitment.sha256,
      commitment.json,
      now,
      now,
    );
    return { row: checkoutRow(operationId), submit: true };
  });
  const reserved = reserve.immediate();
  if (!reserved.submit) {
    return operationFromRow(reserved.row);
  }

  let response: StripeDirectCheckoutResponse;
  try {
    response = await runtime.transport.createDirectCheckout(request);
  } catch {
    return operationFromRow(markSubmissionUnknown(operationId, "transport_outcome_unknown"));
  }

  let accepted: ReturnType<typeof validateResponse>;
  try {
    accepted = validateResponse(response, normalizedInput, account.currency);
  } catch {
    return operationFromRow(markSubmissionUnknown(operationId, "provider_response_mismatch"));
  }

  try {
    const persist = db.transaction(() => {
      const current = checkoutRow(operationId);
      if (
        (current.checkout_session_id !== null
          && current.checkout_session_id !== accepted.sessionId)
        || (
          current.payment_intent_id !== null
          && accepted.paymentIntentId !== null
          && current.payment_intent_id !== accepted.paymentIntentId
        )
      ) {
        throw new ProviderIdentityConflictError(
          "Provider identifiers conflict with an authenticated webhook.",
        );
      }
      const changed = db.query(
        `UPDATE stripe_checkout_operations
         SET checkout_session_id = COALESCE(checkout_session_id, ?),
             payment_intent_id = COALESCE(payment_intent_id, ?),
             checkout_url = ?,
             status = CASE
               WHEN status = 'submitting' THEN 'submitted'
               ELSE status
             END,
             error_code = CASE
               WHEN status = 'submitting' THEN NULL
               ELSE error_code
             END,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        accepted.sessionId,
        accepted.paymentIntentId,
        accepted.url,
        (runtime.now?.() ?? new Date()).toISOString(),
        operationId,
      );
      if (changed.changes !== 1) {
        throw new Error("Stripe Checkout response could not be persisted.");
      }
      return checkoutRow(operationId);
    });
    return operationFromRow(persist.immediate());
  } catch (error) {
    const errorCode =
      error instanceof ProviderIdentityConflictError
        ? "provider_identity_conflict"
        : "response_persistence_unknown";
    return operationFromRow(markSubmissionUnknown(operationId, errorCode));
  }
};

const webhookBytes = (rawBody: string | Uint8Array): Uint8Array => {
  const bytes =
    typeof rawBody === "string"
      ? textBytes(rawBody)
      : Uint8Array.prototype.slice.call(rawBody);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WEBHOOK_BYTES) {
    throw new Error("Stripe webhook body is empty or exceeds the local size limit.");
  }
  return bytes;
};

const verifyWebhookSignature = (
  bytes: Uint8Array,
  signatureHeader: string,
  endpointSecret: string,
  now: Date,
  toleranceSeconds: number,
): void => {
  if (
    typeof endpointSecret !== "string"
    || endpointSecret.length < 8
    || endpointSecret.length > 512
    || typeof signatureHeader !== "string"
    || signatureHeader.length > 4096
  ) {
    throw new Error("Stripe webhook signature verification failed.");
  }
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const field of signatureHeader.split(",")) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (key === "t") timestamps.push(value);
    if (key === "v1" && SIGNATURE.test(value)) signatures.push(value.toLowerCase());
  }
  if (
    timestamps.length !== 1
    || signatures.length === 0
    || !/^[1-9][0-9]*$/.test(timestamps[0]!)
  ) {
    throw new Error("Stripe webhook signature verification failed.");
  }
  const timestamp = Number(timestamps[0]);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isSafeInteger(timestamp)
    || !Number.isSafeInteger(nowSeconds)
    || Math.abs(nowSeconds - timestamp) > toleranceSeconds
  ) {
    throw new Error("Stripe webhook signature timestamp is outside tolerance.");
  }

  const signed = Buffer.concat([
    Buffer.from(`${timestamps[0]}.`, "utf8"),
    Buffer.from(bytes),
  ]);
  const expected = createHmac("sha256", endpointSecret).update(signed).digest();
  const matched = signatures.some((candidate) => {
    const actual = Buffer.from(candidate, "hex");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  });
  if (!matched) {
    throw new Error("Stripe webhook signature verification failed.");
  }
};

const dataObject = (event: Record<string, unknown>): Record<string, unknown> | null => {
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  return object && typeof object === "object" && !Array.isArray(object)
    ? object as Record<string, unknown>
    : null;
};

const existingEvent = (
  eventId: string,
): {
  payload_sha256: string;
  operation_id: string | null;
  disposition: StripeWebhookResult["disposition"];
} | null =>
  db.query(
    `SELECT payload_sha256, operation_id, disposition
     FROM stripe_webhook_inbox WHERE event_id = ?`,
  ).get(eventId) as {
    payload_sha256: string;
    operation_id: string | null;
    disposition: StripeWebhookResult["disposition"];
  } | null;

export const ingestStripeSandboxWebhook = (
  input: {
    rawBody: string | Uint8Array;
    signatureHeader: string;
    endpointSecret: string;
  },
  runtime: {
    now?: () => Date;
    toleranceSeconds?: number;
    /** Deterministic concurrency seam for tests; production callers omit it. */
    beforeProjection?: () => void;
  } = {},
): StripeWebhookResult => {
  const bytes = webhookBytes(input.rawBody);
  const now = runtime.now?.() ?? new Date();
  const tolerance = runtime.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(tolerance) || tolerance <= 0 || tolerance > 900) {
    throw new Error("Stripe webhook signature tolerance is invalid.");
  }
  verifyWebhookSignature(bytes, input.signatureHeader, input.endpointSecret, now, tolerance);

  let event: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    event = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Stripe webhook body is not valid UTF-8 JSON.");
  }

  const eventId = event.id;
  const eventType = event.type;
  const connectedAccountId = event.account;
  if (
    typeof eventId !== "string"
    || !EVENT_ID.test(eventId)
    || event.object !== "event"
    || event.livemode !== false
    || typeof eventType !== "string"
    || eventType.length > 160
    || typeof connectedAccountId !== "string"
    || !CONNECTED_ACCOUNT.test(connectedAccountId)
  ) {
    throw new Error("Stripe webhook is not a bounded sandbox Connect event.");
  }

  const payloadSha256 = sha256Id(bytes);
  const object = dataObject(event);
  const objectId = typeof object?.id === "string" ? object.id : null;

  const persist = db.transaction((): StripeWebhookResult => {
    const duplicate = existingEvent(eventId);
    if (duplicate) {
      if (duplicate.payload_sha256 !== payloadSha256) {
        throw new Error("Stripe webhook event id was replayed with different bytes.");
      }
      const duplicateOperation = duplicate.operation_id
        ? checkoutRow(duplicate.operation_id)
        : null;
      return {
        eventId,
        duplicate: true,
        disposition: duplicate.disposition,
        operationId: duplicate.operation_id,
        status: duplicateOperation?.status ?? null,
      };
    }

    let operation: CheckoutRow | null = null;
    let disposition: StripeWebhookResult["disposition"] = "ignored";
    let transition: "paid" | "expired" | "none" = "none";
    let paymentIntentId: string | null = null;

    if (
      eventType === "checkout.session.completed"
      || eventType === "checkout.session.expired"
    ) {
      const intentId = object?.client_reference_id;
      if (typeof intentId === "string" && UUID.test(intentId)) {
        operation = db
          .query("SELECT * FROM stripe_checkout_operations WHERE intent_id = ?")
          .get(intentId) as CheckoutRow | null;
      }
      if (!operation) {
        disposition = "unmatched";
      } else {
        const currency =
          typeof object?.currency === "string" ? object.currency.toUpperCase() : null;
        const amountTotal = object?.amount_total;
        const metadata =
          object?.metadata
          && typeof object.metadata === "object"
          && !Array.isArray(object.metadata)
            ? object.metadata as Record<string, unknown>
            : null;
        paymentIntentId =
          object?.payment_intent === null
            ? null
            : typeof object?.payment_intent === "string"
                && PAYMENT_INTENT.test(object.payment_intent)
              ? object.payment_intent
              : "__invalid__";
        const identifiersConflict =
          !objectId
          || !CHECKOUT_SESSION.test(objectId)
          || (
            operation.checkout_session_id !== null
            && operation.checkout_session_id !== objectId
          )
          || (
            paymentIntentId !== null
            && paymentIntentId !== "__invalid__"
            && operation.payment_intent_id !== null
            && operation.payment_intent_id !== paymentIntentId
          );
        if (
          connectedAccountId !== operation.connected_account_id
          || currency !== operation.currency
          || !Number.isSafeInteger(amountTotal)
          || String(amountTotal) !== operation.amount_minor
          || metadata?.cashloom_intent_id !== operation.intent_id
          || paymentIntentId === "__invalid__"
          || (
            eventType === "checkout.session.completed"
            && object?.payment_status === "paid"
            && paymentIntentId === null
          )
          || identifiersConflict
        ) {
          disposition = "refused";
        } else {
          disposition = "applied";
          if (
            eventType === "checkout.session.completed"
            && object?.payment_status === "paid"
          ) {
            transition = "paid";
          } else if (eventType === "checkout.session.expired") {
            transition = "expired";
          }
        }
      }
    }

    if (operation && disposition === "applied" && objectId) {
      const conflictingSession = db
        .query(
          `SELECT id FROM stripe_checkout_operations
           WHERE checkout_session_id = ? AND id != ?`,
        )
        .get(objectId, operation.id);
      const conflictingPaymentIntent =
        paymentIntentId
          ? db
              .query(
                `SELECT id FROM stripe_checkout_operations
                 WHERE payment_intent_id = ? AND id != ?`,
              )
              .get(paymentIntentId, operation.id)
          : null;
      if (conflictingSession || conflictingPaymentIntent) {
        disposition = "refused";
      }
    }

    db.query(
      `INSERT INTO stripe_webhook_inbox
         (event_id, payload_sha256, operation_id, connected_account_id,
          event_type, object_id, disposition, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      payloadSha256,
      operation?.id ?? null,
      connectedAccountId,
      eventType,
      objectId,
      disposition,
      now.toISOString(),
    );

    if (operation && disposition === "applied" && objectId) {
      db.query(
        `UPDATE stripe_checkout_operations
         SET checkout_session_id = COALESCE(checkout_session_id, ?),
             payment_intent_id = COALESCE(payment_intent_id, ?),
             status = CASE
               WHEN ? = 'paid' THEN 'provider_reported_paid'
               WHEN ? = 'expired' AND status != 'provider_reported_paid' THEN 'expired'
               ELSE status
             END,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        objectId,
        paymentIntentId,
        transition,
        transition,
        now.toISOString(),
        operation.id,
      );
    }

    const current = operation ? checkoutRow(operation.id) : null;
    return {
      eventId,
      duplicate: false,
      disposition,
      operationId: operation?.id ?? null,
      status: current?.status ?? null,
    };
  });
  runtime.beforeProjection?.();
  return persist.immediate();
};

export const getStripeCheckoutOperation = (
  operationId: string,
): StripeCheckoutOperation | null => {
  if (!UUID.test(operationId)) return null;
  const row = db
    .query("SELECT * FROM stripe_checkout_operations WHERE id = ?")
    .get(operationId) as CheckoutRow | null;
  return row ? operationFromRow(row) : null;
};
