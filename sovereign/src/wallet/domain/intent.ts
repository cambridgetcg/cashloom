import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  accountRefSchema,
  chainIdFromAccountId,
  chainIdFromAssetId,
} from "./identities";
import { nonNegativeMoneySchema, positiveMoneySchema } from "./money";

declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };

export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected a lowercase SHA-256 digest")
  .transform((value) => value as Sha256Digest);

export const canonicalTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "expected a canonical UTC timestamp with millisecond precision",
  )
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  }, "expected a real canonical UTC timestamp");

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
export const walletOpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ID_PATTERN, "expected an opaque Wallet Kernel id");

export const paymentKindSchema = z.enum([
  "transfer",
  "purchase",
  "swap",
  "bridge",
  "invoice",
]);

const actorRefObjectSchema = z
  .object({
    kind: z.enum(["human", "agent", "service"]),
    actor_id: walletOpaqueIdSchema,
  })
  .strict();

export const actorRefSchema = actorRefObjectSchema.readonly();
export type ActorRef = z.infer<typeof actorRefSchema>;

const accountDestinationSchema = z
  .object({
    kind: z.literal("account"),
    account: accountRefSchema,
  })
  .strict();

const payeeDestinationSchema = z
  .object({
    kind: z.literal("payee"),
    payee_id: walletOpaqueIdSchema,
  })
  .strict();

const invoiceDestinationSchema = z
  .object({
    kind: z.literal("invoice"),
    invoice_id: walletOpaqueIdSchema,
  })
  .strict();

export const paymentDestinationSchema = z
  .discriminatedUnion("kind", [
    accountDestinationSchema,
    payeeDestinationSchema,
    invoiceDestinationSchema,
  ])
  .readonly();

export type PaymentDestination = z.infer<typeof paymentDestinationSchema>;

const paymentIntentBodyV1ObjectSchema = z
  .object({
    schema_version: z.literal("cashloom.payment-intent/1"),
    intent_id: walletOpaqueIdSchema,
    kind: paymentKindSchema,
    source_account: accountRefSchema,
    destination: paymentDestinationSchema,
    amount: positiveMoneySchema,
    fee_ceiling: nonNegativeMoneySchema.optional(),
    created_by: actorRefSchema,
    nonce: walletOpaqueIdSchema,
    created_at: canonicalTimestampSchema,
    expires_at: canonicalTimestampSchema,
    quote_hash: sha256DigestSchema.optional(),
    simulation_hash: sha256DigestSchema.optional(),
    purpose: z.string().trim().min(1).max(280).optional(),
    external_reference: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const validateIntentBody = (
  body: z.infer<typeof paymentIntentBodyV1ObjectSchema>,
  context: z.RefinementCtx,
): void => {
  if (Date.parse(body.expires_at) <= Date.parse(body.created_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "intent must expire after it is created",
    });
  }

  if (body.source_account.kind === "crypto") {
    if (body.amount.asset.kind !== "crypto") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount", "asset"],
        message: "an on-chain source account cannot directly spend ISO 4217 fiat",
      });
      return;
    }
    const accountChain = chainIdFromAccountId(body.source_account.account_id);
    const assetChain = chainIdFromAssetId(body.amount.asset.asset_id);
    if (accountChain !== assetChain) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount", "asset"],
        message: `source account is on ${accountChain}, amount asset is on ${assetChain}`,
      });
    }

    if (body.fee_ceiling) {
      if (body.fee_ceiling.asset.kind !== "crypto") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fee_ceiling", "asset"],
          message: "an on-chain payment cannot pay its network fee in ISO 4217 fiat",
        });
      } else {
        const feeChain = chainIdFromAssetId(body.fee_ceiling.asset.asset_id);
        if (accountChain !== feeChain) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fee_ceiling", "asset"],
            message: `source account is on ${accountChain}, fee asset is on ${feeChain}`,
          });
        }
      }
    }

    if (body.destination.kind === "account") {
      if (body.destination.account.kind !== "crypto") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destination", "account"],
          message: "an on-chain payment requires an on-chain account destination",
        });
      } else if (body.kind !== "bridge") {
        const destinationChain = chainIdFromAccountId(
          body.destination.account.account_id,
        );
        if (accountChain !== destinationChain) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["destination", "account"],
            message: `source account is on ${accountChain}, destination account is on ${destinationChain}; use a bridge intent for cross-chain delivery`,
          });
        }
      }
    }
  } else {
    if (body.amount.asset.kind !== "fiat") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount", "asset"],
        message: "a fiat provider account cannot directly spend an on-chain asset",
      });
    }
    if (body.fee_ceiling && body.fee_ceiling.asset.kind !== "fiat") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fee_ceiling", "asset"],
        message: "a fiat provider payment cannot pay its fee in an on-chain asset",
      });
    }
  }
};

export const paymentIntentBodyV1Schema = paymentIntentBodyV1ObjectSchema
  .superRefine(validateIntentBody)
  .readonly();

export type PaymentIntentBodyV1 = z.infer<typeof paymentIntentBodyV1Schema>;

const paymentIntentV1ObjectSchema = paymentIntentBodyV1ObjectSchema.extend({
  intent_hash: sha256DigestSchema,
});

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const assertUnicodeScalarString = (value: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("canonical JSON rejects an unpaired high surrogate");
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("canonical JSON rejects an unpaired low surrogate");
    }
  }
};

/**
 * RFC 8785/JCS-compatible canonicalisation for JSON-domain values.
 * Money never uses the number branch: all monetary quantities are strings.
 */
export const canonicalizeJson = (input: JsonValue): string => {
  const active = new Set<object>();

  const visit = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") {
      assertUnicodeScalarString(value);
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON rejects non-finite numbers");
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
    }
    if (active.has(value)) throw new TypeError("canonical JSON rejects cycles");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("canonical JSON rejects symbol keys");
        }
        const allowedNames = new Set([
          "length",
          ...Array.from({ length: value.length }, (_, index) => String(index)),
        ]);
        if (Object.getOwnPropertyNames(value).some((name) => !allowedNames.has(name))) {
          throw new TypeError("canonical JSON rejects non-JSON array properties");
        }
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new TypeError("canonical JSON rejects sparse arrays");
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError("canonical JSON rejects accessor array entries");
          }
        }
        return `[${value.map((entry) => visit(entry)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("canonical JSON accepts only plain objects");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("canonical JSON rejects symbol keys");
      }
      const names = Object.getOwnPropertyNames(value);
      const enumerableNames = Object.keys(value);
      if (names.length !== enumerableNames.length) {
        throw new TypeError("canonical JSON rejects non-enumerable properties");
      }
      for (const key of enumerableNames) {
        assertUnicodeScalarString(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("canonical JSON rejects accessor properties");
        }
      }
      return `{${enumerableNames
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    } finally {
      active.delete(value);
    }
  };

  return visit(input);
};

const bodyFromIntent = (
  intent: z.infer<typeof paymentIntentV1ObjectSchema>,
): PaymentIntentBodyV1 => {
  const { intent_hash: _intentHash, ...body } = intent;
  return paymentIntentBodyV1Schema.parse(body);
};

export const hashPaymentIntent = (bodyInput: PaymentIntentBodyV1): Sha256Digest => {
  const body = paymentIntentBodyV1Schema.parse(bodyInput);
  const digest = bytesToHex(sha256(utf8ToBytes(canonicalizeJson(body))));
  return sha256DigestSchema.parse(`sha256:${digest}`);
};

export const paymentIntentV1Schema = paymentIntentV1ObjectSchema
  .superRefine((intent, context) => {
    validateIntentBody(intent, context);
    const expected = hashPaymentIntent(bodyFromIntent(intent));
    if (intent.intent_hash !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intent_hash"],
        message: `intent hash mismatch: expected ${expected}`,
      });
    }
  })
  .readonly();

export type PaymentIntentV1 = z.infer<typeof paymentIntentV1Schema>;

export const createPaymentIntentV1 = (
  bodyInput: unknown,
): PaymentIntentV1 => {
  const body = paymentIntentBodyV1Schema.parse(bodyInput);
  return paymentIntentV1Schema.parse({
    ...body,
    intent_hash: hashPaymentIntent(body),
  });
};

export const parsePaymentIntentV1 = (input: unknown): PaymentIntentV1 =>
  paymentIntentV1Schema.parse(input);

export const verifyPaymentIntentHash = (input: unknown): boolean =>
  paymentIntentV1Schema.safeParse(input).success;
