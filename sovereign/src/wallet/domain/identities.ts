import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

/**
 * Wallet Kernel identities.
 *
 * Chain, account and crypto asset syntax follows the CAIP identifier shapes.
 * CAIP deliberately does not define address canonicalisation for every chain,
 * so the original account/asset spelling is preserved. Chain-specific
 * adapters may additionally keep a normalised lookup key, but must never
 * silently rewrite the identifier that the user authorised.
 */

declare const chainIdBrand: unique symbol;
declare const caip10AccountIdBrand: unique symbol;
declare const caip19AssetIdBrand: unique symbol;
declare const iso4217CurrencyBrand: unique symbol;
declare const positionIdBrand: unique symbol;

export type ChainId = string & { readonly [chainIdBrand]: true };
export type Caip10AccountId = string & {
  readonly [caip10AccountIdBrand]: true;
};
export type Caip19AssetId = string & {
  readonly [caip19AssetIdBrand]: true;
};
export type Iso4217Currency = string & {
  readonly [iso4217CurrencyBrand]: true;
};
export type PositionId = string & { readonly [positionIdBrand]: true };

const CHAIN_NAMESPACE = "[-a-z0-9]{3,8}";
const CHAIN_REFERENCE = "[-_a-zA-Z0-9]{1,32}";
const ACCOUNT_ADDRESS = "[-.%a-zA-Z0-9]{1,128}";
const ASSET_NAMESPACE = "[-a-z0-9]{3,8}";
const ASSET_REFERENCE = "[-.%a-zA-Z0-9]{1,128}";
const TOKEN_ID = "[-.%a-zA-Z0-9]{1,78}";

const CHAIN_ID_PATTERN = new RegExp(
  `^${CHAIN_NAMESPACE}:${CHAIN_REFERENCE}$`,
);
const CAIP10_PATTERN = new RegExp(
  `^${CHAIN_NAMESPACE}:${CHAIN_REFERENCE}:${ACCOUNT_ADDRESS}$`,
);
const CAIP19_PATTERN = new RegExp(
  `^${CHAIN_NAMESPACE}:${CHAIN_REFERENCE}/${ASSET_NAMESPACE}:${ASSET_REFERENCE}(?:/${TOKEN_ID})?$`,
);
const ISO4217_PATTERN = /^[A-Z]{3}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const OPAQUE_ACCOUNT_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/;
const POSITION_ID_PATTERN = /^position:v1:sha256:[0-9a-f]{64}$/;

const chainIdSyntaxSchema = z
  .string()
  .regex(CHAIN_ID_PATTERN, "expected a CAIP-2 chain id");

export const chainIdSchema = chainIdSyntaxSchema
  .superRefine((value, context) => {
    const separator = value.indexOf(":");
    const namespace = value.slice(0, separator);
    const reference = value.slice(separator + 1);
    if (namespace === "eip155" && !/^(?:0|[1-9]\d*)$/.test(reference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eip155 references must be canonical unsigned decimals",
      });
    }
    if (namespace === "bip122" && !/^[0-9a-f]{32}$/.test(reference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bip122 references must be 32 lowercase hexadecimal characters",
      });
    }
    if (namespace === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32}$/.test(reference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "solana references must be 32 base58 characters",
      });
    }
  })
  .transform((value) => value as ChainId);

export const caip10AccountIdSchema = z
  .string()
  .regex(CAIP10_PATTERN, "expected a CAIP-10 account id")
  .superRefine((value, context) => {
    const secondColon = value.indexOf(":", value.indexOf(":") + 1);
    const result = chainIdSchema.safeParse(value.slice(0, secondColon));
    if (!result.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error.issues[0]?.message ?? "invalid account chain id",
      });
    }
  })
  .transform((value) => value as Caip10AccountId);

export const caip19AssetIdSchema = z
  .string()
  .regex(CAIP19_PATTERN, "expected a CAIP-19 asset id")
  .superRefine((value, context) => {
    const result = chainIdSchema.safeParse(value.slice(0, value.indexOf("/")));
    if (!result.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error.issues[0]?.message ?? "invalid asset chain id",
      });
    }
  })
  .transform((value) => value as Caip19AssetId);

/**
 * Syntactic ISO 4217 validation. Whether a code is currently assigned (and its
 * minor-unit scale) belongs to the versioned asset registry, not this parser.
 */
export const iso4217CurrencySchema = z
  .string()
  .regex(ISO4217_PATTERN, "expected an uppercase ISO 4217 alphabetic code")
  .transform((value) => value as Iso4217Currency);

export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROVIDER_ID_PATTERN, "expected a canonical lowercase provider id");

/** Opaque provider reference only: never place an IBAN, PAN, or secret here. */
export const opaqueAccountRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ACCOUNT_REF_PATTERN, "expected an opaque provider account reference");

const cryptoAccountRefObjectSchema = z
  .object({
    kind: z.literal("crypto"),
    account_id: caip10AccountIdSchema,
  })
  .strict();

const fiatAccountRefObjectSchema = z
  .object({
    kind: z.literal("fiat"),
    provider: providerIdSchema,
    account_ref: opaqueAccountRefSchema,
  })
  .strict();

export const accountRefSchema = z
  .discriminatedUnion("kind", [
    cryptoAccountRefObjectSchema,
    fiatAccountRefObjectSchema,
  ])
  .readonly();

export type AccountRef = z.infer<typeof accountRefSchema>;
export type CryptoAccountRef = Extract<AccountRef, { readonly kind: "crypto" }>;
export type FiatAccountRef = Extract<AccountRef, { readonly kind: "fiat" }>;

const cryptoAssetRefObjectSchema = z
  .object({
    kind: z.literal("crypto"),
    asset_id: caip19AssetIdSchema,
  })
  .strict();

const fiatAssetRefObjectSchema = z
  .object({
    kind: z.literal("fiat"),
    currency: iso4217CurrencySchema,
  })
  .strict();

export const assetRefSchema = z
  .discriminatedUnion("kind", [
    cryptoAssetRefObjectSchema,
    fiatAssetRefObjectSchema,
  ])
  .readonly();

export type AssetRef = z.infer<typeof assetRefSchema>;
export type CryptoAssetRef = Extract<AssetRef, { readonly kind: "crypto" }>;
export type FiatAssetRef = Extract<AssetRef, { readonly kind: "fiat" }>;

export const positionIdSchema = z
  .string()
  .regex(POSITION_ID_PATTERN, "expected a Wallet Kernel position id")
  .transform((value) => value as PositionId);

export const parseChainId = (value: unknown): ChainId =>
  chainIdSchema.parse(value);

export const parseCaip10AccountId = (value: unknown): Caip10AccountId =>
  caip10AccountIdSchema.parse(value);

export const parseCaip19AssetId = (value: unknown): Caip19AssetId =>
  caip19AssetIdSchema.parse(value);

export const parseIso4217Currency = (value: unknown): Iso4217Currency =>
  iso4217CurrencySchema.parse(value);

export const parseAccountRef = (value: unknown): AccountRef =>
  accountRefSchema.parse(value);

export const parseAssetRef = (value: unknown): AssetRef =>
  assetRefSchema.parse(value);

export const cryptoAccountRef = (accountId: unknown): CryptoAccountRef =>
  accountRefSchema.parse({ kind: "crypto", account_id: accountId }) as CryptoAccountRef;

export const fiatAccountRef = (
  provider: unknown,
  accountRef: unknown,
): FiatAccountRef =>
  accountRefSchema.parse({
    kind: "fiat",
    provider,
    account_ref: accountRef,
  }) as FiatAccountRef;

export const cryptoAssetRef = (assetId: unknown): CryptoAssetRef =>
  assetRefSchema.parse({ kind: "crypto", asset_id: assetId }) as CryptoAssetRef;

export const fiatAssetRef = (currency: unknown): FiatAssetRef =>
  assetRefSchema.parse({ kind: "fiat", currency }) as FiatAssetRef;

export const chainIdFromAccountId = (accountId: Caip10AccountId): ChainId => {
  const secondColon = accountId.indexOf(":", accountId.indexOf(":") + 1);
  return parseChainId(accountId.slice(0, secondColon));
};

export const chainIdFromAssetId = (assetId: Caip19AssetId): ChainId =>
  parseChainId(assetId.slice(0, assetId.indexOf("/")));

export const accountRefKey = (account: AccountRef): string =>
  account.kind === "crypto"
    ? `crypto:${account.account_id}`
    : `fiat:${account.provider}:${account.account_ref}`;

export const assetRefKey = (asset: AssetRef): string =>
  asset.kind === "crypto" ? `crypto:${asset.asset_id}` : `iso4217:${asset.currency}`;

/**
 * A position is the deterministic identity of one account + one exact asset.
 * On-chain accounts may only be paired with assets on their own chain.
 */
export const positionId = (accountInput: AccountRef, assetInput: AssetRef): PositionId => {
  const account = parseAccountRef(accountInput);
  const asset = parseAssetRef(assetInput);

  if (account.kind === "crypto" && asset.kind === "crypto") {
    const accountChain = chainIdFromAccountId(account.account_id);
    const assetChain = chainIdFromAssetId(asset.asset_id);
    if (accountChain !== assetChain) {
      throw new Error(
        `position chain mismatch: account is ${accountChain}, asset is ${assetChain}`,
      );
    }
  }

  if (account.kind === "crypto" && asset.kind === "fiat") {
    throw new Error("an on-chain account cannot directly hold an ISO 4217 fiat asset");
  }

  const preimage = `cashloom.position/v1\u0000${accountRefKey(account)}\u0000${assetRefKey(asset)}`;
  const digest = bytesToHex(sha256(utf8ToBytes(preimage)));
  return positionIdSchema.parse(`position:v1:sha256:${digest}`);
};
