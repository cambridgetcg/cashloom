/**
 * Stripe amount scale shared by read reconciliation and hosted collection.
 *
 * Stripe API amounts are integers in each currency's own minor unit. Most
 * currencies use two decimals; these documented exceptions must be identical
 * on both paths or a locally configured account could silently mis-scale money.
 */

// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

// https://docs.stripe.com/currencies#three-decimal
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export const stripeDecimalsFor = (currency: string): number => {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
};
