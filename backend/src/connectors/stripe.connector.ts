import axios, { AxiosResponse } from "axios";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "./types";
import { resolveCredentialRef } from "./credentials";
import { InternalServerException } from "../utils/app-error";

// READ-ONLY Stripe connector over the plain REST API (no Stripe SDK — axios is
// already the house HTTP client). Built for a RESTRICTED key (rk_...) carrying
// only the balance:read + balance_transactions:read scopes; it never calls an
// endpoint outside those two reads, so even a leaked key from this code path
// could not move money. The key itself is resolved from the environment via
// resolveCredentialRef at call time and never appears in errors or logs.

const STRIPE_API_BASE = "https://api.stripe.com";

// Default env var for the restricted key (supplied via fly secrets) when the
// Account carries no credentialRef of its own.
const DEFAULT_CREDENTIAL_REF = "STRIPE_RESTRICTED_KEY";

const REQUIRED_SCOPES = '"balance:read" / "balance_transactions:read"';

// Stripe's maximum page size for list endpoints.
const PAGE_LIMIT = 100;

// Hard ceiling on pagination (100k transactions per sync window) so a broken
// has_more loop can never spin forever against the live API.
const MAX_PAGES = 1000;

// Stripe's zero-decimal currencies: `amount` is already the whole unit
// (¥500 → 500), so the minor-unit scale is 0.
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

// Stripe's three-decimal currencies (BHD etc.): `amount` is in thousandths.
// https://docs.stripe.com/currencies#three-decimal
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

// Minor-unit scale of a Stripe `amount` for a given currency. Stripe amounts
// are always integers in the currency's own minor unit; this just says how to
// read them (0 JPY, 3 BHD, 2 everything else).
const stripeDecimalsFor = (currency: string): number => {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
};

// --- Stripe payload shapes (only the fields this connector reads) ----------

interface StripeBalanceEntry {
  amount: number;
  currency: string;
}

interface StripeBalanceResponse {
  available?: StripeBalanceEntry[];
  pending?: StripeBalanceEntry[];
}

interface StripeBalanceTransaction {
  id: string;
  amount: number;
  created: number;
  currency: string;
  description?: string | null;
  reporting_category?: string | null;
  type?: string | null;
}

interface StripeListResponse {
  data: StripeBalanceTransaction[];
  has_more: boolean;
}

// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait from a 429's Retry-After header. Defaults to 1s when the
// header is missing/garbage, capped at 30s so a hostile header can't park the
// sync indefinitely.
const retryAfterSeconds = (headerValue: unknown): number => {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 1;
  return Math.min(seconds, 30);
};

// Stripe amounts must be integers; anything else means we're misreading the
// payload, and summing it would corrupt a balance — refuse instead.
const assertIntegerAmount = (amount: number, where: string): void => {
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new InternalServerException(
      `Stripe ${where} returned a non-integer amount (${amount}); refusing to treat it as minor units`
    );
  }
};

// One authenticated GET against the Stripe API with the house error mapping:
// 401/403 → misconfigured credential (names the env VAR and the likely missing
// scope, never key material); 429 → honor Retry-After once, then fail; other
// non-2xx → plain failure with the status. validateStatus passes everything
// through so every non-2xx lands here, not in an axios throw.
const stripeGet = async <T>(
  path: string,
  secretKey: string,
  credentialRef: string,
  params?: Record<string, string | number>
): Promise<T> => {
  let retriedRateLimit = false;
  for (;;) {
    let response: AxiosResponse<T>;
    try {
      response = await axios.get<T>(`${STRIPE_API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
        params,
        validateStatus: () => true,
      });
    } catch (error) {
      // validateStatus absorbs every HTTP status, so landing here means the
      // request died below HTTP (DNS, TLS, ECONNRESET, timeout...). Re-wrap
      // instead of rethrowing: a raw axios error carries the full request
      // config — INCLUDING the Authorization header — and an upstream logger
      // must never see a bearer token (same guard as the GoCardless
      // connector's toConnectorError). The network code + path is all we keep.
      const code = (error as { code?: unknown })?.code;
      throw new InternalServerException(
        `Stripe API GET ${path} failed before any HTTP response${
          typeof code === "string" && code !== "" ? ` (${code})` : ""
        }`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new InternalServerException(
        `Stripe rejected the credential from environment variable "${credentialRef}" (HTTP ${response.status}) on GET ${path}: the restricted key is likely revoked or missing the ${REQUIRED_SCOPES} scope`
      );
    }

    if (response.status === 429) {
      if (!retriedRateLimit) {
        retriedRateLimit = true;
        const headers = response.headers as Record<string, unknown>;
        await sleep(retryAfterSeconds(headers?.["retry-after"]) * 1000);
        continue;
      }
      throw new InternalServerException(
        `Stripe rate limit (HTTP 429) persisted after one Retry-After backoff on GET ${path}`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new InternalServerException(
        `Stripe API GET ${path} failed with HTTP ${response.status}`
      );
    }

    return response.data;
  }
};

const titleFor = (txn: StripeBalanceTransaction): string => {
  if (txn.description && txn.description.trim() !== "") {
    return txn.description;
  }
  // Human-readable fallback from Stripe's own categorisation:
  // reporting_category "payout" → "Stripe: payout".
  const category = txn.reporting_category || txn.type || "balance transaction";
  return `Stripe: ${category.replace(/_/g, " ")}`;
};

const normalizeTransaction = (
  txn: StripeBalanceTransaction
): NormalizedTransaction => {
  assertIntegerAmount(txn.amount, `balance transaction ${txn.id}`);
  return {
    externalId: txn.id,
    title: titleFor(txn),
    // Stripe's sign convention is already what we want: negative = money out.
    amountMinor: String(txn.amount),
    currency: txn.currency.toUpperCase(),
    date: new Date(txn.created * 1000),
    raw: txn,
  };
};

// Build the Stripe connector for one account. accountCurrency is the currency
// the caller stores on the Account ("USD", "JPY"...) — Stripe's /v1/balance is
// multi-currency, and ConnectorContext deliberately carries no currency, so the
// caller pins it here at construction and fetchBalance reports exactly that
// one. ctx.externalAccountId (the acct_... id) is kept for dedupe/reconcile by
// the caller but is not sent to Stripe: a restricted key is already bound to
// its own account, and a Stripe-Account header is a Connect-only concept.
export const createStripeConnector = (
  accountCurrency: string
): RailConnector => {
  const currency = accountCurrency.trim().toUpperCase();
  if (currency === "") {
    throw new InternalServerException(
      "Cannot create Stripe connector: accountCurrency is empty"
    );
  }

  // Per-connector namespace, defence in depth behind the validator and
  // resolveCredentialRef's global allowlist: this connector only ever resolves
  // STRIPE_* env vars, so a stored ref naming some OTHER credential
  // (GOCARDLESS_SECRET_KEY...) can never be transmitted to Stripe as a bearer
  // token. The message names the variable, never any value.
  const credentialRefFor = (ctx: ConnectorContext): string => {
    const ref = ctx.credentialRef ?? DEFAULT_CREDENTIAL_REF;
    if (!ref.startsWith("STRIPE_")) {
      throw new InternalServerException(
        `Refusing credentialRef "${ref}" for the Stripe connector: it must name a STRIPE_* environment variable`
      );
    }
    return ref;
  };

  return {
    type: "stripe",

    // GET /v1/balance, then collapse the available + pending entries for the
    // account's currency into one minor-unit total. Stripe amounts are already
    // integer minor units, so no conversion — just exact BigInt summation.
    // Stripe always reports back the PINNED currency, so the sync service's
    // never-mix-currencies guard can never fire for this connector — the
    // misconfiguration check has to live here: a pinned currency Stripe knows
    // nothing about, while it DOES hold other currencies, would otherwise
    // confidently sync a false "0" over a real balance on every run. Only a
    // balance response with no entries at all still reports "0" (nothing
    // contradicts the configuration; the account simply holds nothing).
    async fetchBalance(ctx: ConnectorContext): Promise<NormalizedBalance> {
      const ref = credentialRefFor(ctx);
      const key = resolveCredentialRef(ref);
      const balance = await stripeGet<StripeBalanceResponse>(
        "/v1/balance",
        key,
        ref
      );

      let totalMinor = 0n;
      let currencyPresent = false;
      const otherCurrencies = new Set<string>();
      const entries = [
        ...(balance.available ?? []),
        ...(balance.pending ?? []),
      ];
      for (const entry of entries) {
        if (entry.currency.toUpperCase() !== currency) {
          otherCurrencies.add(entry.currency.toUpperCase());
          continue;
        }
        currencyPresent = true;
        assertIntegerAmount(entry.amount, "balance");
        totalMinor += BigInt(entry.amount);
      }

      if (!currencyPresent && otherCurrencies.size > 0) {
        throw new InternalServerException(
          `Stripe reports no ${currency} balance but holds ${[
            ...otherCurrencies,
          ]
            .sort()
            .join(
              ", "
            )} — the account currency looks misconfigured; refusing to sync a false 0 over a real balance`
        );
      }

      return {
        balanceMinor: totalMinor.toString(),
        currency,
        decimals: stripeDecimalsFor(currency),
        asOf: new Date(),
      };
    },

    // GET /v1/balance_transactions with created[gte]=unix(since), walking the
    // full list via starting_after until has_more is false. Overlap with a
    // previous sync window is fine — callers dedupe on externalId.
    async fetchTransactions(
      ctx: ConnectorContext,
      since: Date
    ): Promise<NormalizedTransaction[]> {
      const ref = credentialRefFor(ctx);
      const key = resolveCredentialRef(ref);
      const createdGte = Math.floor(since.getTime() / 1000);

      const transactions: NormalizedTransaction[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params: Record<string, string | number> = {
          "created[gte]": createdGte,
          limit: PAGE_LIMIT,
        };
        if (startingAfter !== undefined) {
          params.starting_after = startingAfter;
        }

        const list = await stripeGet<StripeListResponse>(
          "/v1/balance_transactions",
          key,
          ref,
          params
        );
        for (const txn of list.data) {
          transactions.push(normalizeTransaction(txn));
        }

        if (!list.has_more) {
          return transactions;
        }
        const last = list.data[list.data.length - 1];
        if (!last) {
          throw new InternalServerException(
            "Stripe pagination is inconsistent: has_more is true but the page is empty"
          );
        }
        startingAfter = last.id;
      }
      throw new InternalServerException(
        `Stripe pagination exceeded ${MAX_PAGES} pages for one sync window; aborting instead of looping`
      );
    },
  };
};
