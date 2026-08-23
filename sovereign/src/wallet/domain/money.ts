import { z } from "zod";
import { assetRefKey, assetRefSchema, type AssetRef } from "./identities";

declare const atomicAmountBrand: unique symbol;
declare const unsignedAtomicAmountBrand: unique symbol;
declare const positiveAtomicAmountBrand: unique symbol;

/** Canonical signed base-10 integer: no whitespace, plus sign, or leading zero. */
export type AtomicAmount = string & { readonly [atomicAmountBrand]: true };
export type UnsignedAtomicAmount = string & {
  readonly [unsignedAtomicAmountBrand]: true;
};
export type PositiveAtomicAmount = string & {
  readonly [positiveAtomicAmountBrand]: true;
};

const SIGNED_ATOMIC_PATTERN = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
const UNSIGNED_ATOMIC_PATTERN = /^(?:0|[1-9]\d*)$/;
const POSITIVE_ATOMIC_PATTERN = /^[1-9]\d*$/;

export const atomicAmountSchema = z
  .string()
  .regex(SIGNED_ATOMIC_PATTERN, "expected a canonical signed atomic-unit integer")
  .transform((value) => value as AtomicAmount);

export const unsignedAtomicAmountSchema = z
  .string()
  .regex(UNSIGNED_ATOMIC_PATTERN, "expected a canonical unsigned atomic-unit integer")
  .transform((value) => value as UnsignedAtomicAmount);

export const positiveAtomicAmountSchema = z
  .string()
  .regex(POSITIVE_ATOMIC_PATTERN, "expected a positive atomic-unit integer")
  .transform((value) => value as PositiveAtomicAmount);

export const moneySchema = z
  .object({
    asset: assetRefSchema,
    atomic: atomicAmountSchema,
  })
  .strict()
  .readonly();

export const nonNegativeMoneySchema = z
  .object({
    asset: assetRefSchema,
    atomic: unsignedAtomicAmountSchema,
  })
  .strict()
  .readonly();

export const positiveMoneySchema = z
  .object({
    asset: assetRefSchema,
    atomic: positiveAtomicAmountSchema,
  })
  .strict()
  .readonly();

export type Money = z.infer<typeof moneySchema>;
export type NonNegativeMoney = z.infer<typeof nonNegativeMoneySchema>;
export type PositiveMoney = z.infer<typeof positiveMoneySchema>;

export const parseAtomicAmount = (value: unknown): AtomicAmount =>
  atomicAmountSchema.parse(value);

export const parseUnsignedAtomicAmount = (value: unknown): UnsignedAtomicAmount =>
  unsignedAtomicAmountSchema.parse(value);

export const parsePositiveAtomicAmount = (value: unknown): PositiveAtomicAmount =>
  positiveAtomicAmountSchema.parse(value);

export const money = (asset: AssetRef, atomic: unknown): Money =>
  moneySchema.parse({ asset, atomic });

export const nonNegativeMoney = (
  asset: AssetRef,
  atomic: unknown,
): NonNegativeMoney => nonNegativeMoneySchema.parse({ asset, atomic });

export const positiveMoney = (asset: AssetRef, atomic: unknown): PositiveMoney =>
  positiveMoneySchema.parse({ asset, atomic });

const assertSameAsset = (left: Money, right: Money): void => {
  if (assetRefKey(left.asset) !== assetRefKey(right.asset)) {
    throw new Error(
      `money asset mismatch: ${assetRefKey(left.asset)} != ${assetRefKey(right.asset)}`,
    );
  }
};

export const addMoney = (left: Money, right: Money): Money => {
  assertSameAsset(left, right);
  return money(left.asset, (BigInt(left.atomic) + BigInt(right.atomic)).toString());
};

export const subtractMoney = (left: Money, right: Money): Money => {
  assertSameAsset(left, right);
  return money(left.asset, (BigInt(left.atomic) - BigInt(right.atomic)).toString());
};

export const negateMoney = (value: Money): Money =>
  money(value.asset, (-BigInt(value.atomic)).toString());

export const compareMoney = (left: Money, right: Money): -1 | 0 | 1 => {
  assertSameAsset(left, right);
  const a = BigInt(left.atomic);
  const b = BigInt(right.atomic);
  return a < b ? -1 : a > b ? 1 : 0;
};

