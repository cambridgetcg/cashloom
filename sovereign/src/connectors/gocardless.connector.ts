import axios from "axios";
import { HTTPSTATUS } from "../config/http.config";
import { HttpException, InternalServerException } from "../utils/app-error";
import { resolveCredentialRef } from "./credentials";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "./types";

// GoCardless *Bank Account Data* connector (the ex-Nordigen open-banking
// product, NOT the GoCardless payments API). UK/EU bank feeds, read-only by
// nature: the API can only list institutions, link accounts via requisitions,
// and read balances/transactions — there is no money-movement surface at all,
// which is exactly what the RailConnector seam demands.

const GOCARDLESS_BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";

// GoCardless authenticates the whole integration with one fixed secret pair,
// not a per-account credential, so the env var NAMES are constants here and
// ctx.credentialRef is intentionally ignored. Values are resolved through
// resolveCredentialRef at call time — never stored, never logged.
const SECRET_ID_REF = "GOCARDLESS_SECRET_ID";
const SECRET_KEY_REF = "GOCARDLESS_SECRET_KEY";

// Bank feeds from this API are fiat with 2 minor-unit decimals (pence/cents).
const GOCARDLESS_DECIMALS = 2;

// Refresh the cached access token when fewer than 60s of life remain, so an
// in-flight request can never ride a token that expires mid-call.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/* ------------------------------ wire shapes ------------------------------ */

interface GoCardlessTokenResponse {
  access: string;
  access_expires: number; // seconds
}

interface GoCardlessBalanceAmount {
  amount: string; // decimal MAJOR-unit string, e.g. "123.45"
  currency: string;
}

interface GoCardlessBalance {
  balanceAmount: GoCardlessBalanceAmount;
  balanceType?: string;
  referenceDate?: string; // YYYY-MM-DD
}

interface GoCardlessBalancesResponse {
  balances?: GoCardlessBalance[];
}

interface GoCardlessBookedTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate: string; // YYYY-MM-DD — always present on booked rows
  valueDate?: string;
  transactionAmount: GoCardlessBalanceAmount; // signed decimal string
  remittanceInformationUnstructured?: string;
  creditorName?: string;
  debtorName?: string;
}

interface GoCardlessTransactionsResponse {
  transactions?: {
    booked?: GoCardlessBookedTransaction[];
    // pending[] exists on the wire but is deliberately never read — see
    // fetchTransactions.
    pending?: unknown[];
  };
}

export interface GoCardlessInstitution {
  id: string;
  name: string;
  bic?: string;
  transaction_total_days?: string;
  countries?: string[];
  logo?: string;
}

export interface GoCardlessRequisitionCreated {
  id: string;
  // The hosted bank-auth URL Alex opens in a browser to approve access.
  link: string;
}

export interface GoCardlessRequisition {
  id: string;
  status: string;
  // GoCardless account ids — each becomes an Account.externalAccountId.
  accounts: string[];
}

/* ----------------------------- error handling ---------------------------- */

// This API rate-limits PER ACCOUNT PER DAY (≈4 calls/day on the bank-data
// endpoints), so a 429 means "done until tomorrow", not "back off and retry".
// We surface that clearly and NEVER retry-loop — automatic retries would just
// burn tomorrow's quota the instant it resets.
const toConnectorError = (error: unknown, endpoint: string): AppErrorLike => {
  const status =
    typeof error === "object" && error !== null
      ? (error as { response?: { status?: number } }).response?.status
      : undefined;
  if (status === HTTPSTATUS.TOO_MANY_REQUESTS) {
    return new HttpException(
      `GoCardless daily quota exhausted for ${endpoint}: this API allows ~4 calls per account per day, so the account is rate limited until tomorrow — do not retry`,
      HTTPSTATUS.TOO_MANY_REQUESTS
    );
  }
  // Re-wrap instead of rethrowing the raw axios error: axios errors carry the
  // full request config (including the Authorization header), and an upstream
  // logger must never see a bearer token. Status + endpoint is all we keep.
  if (typeof status === "number") {
    return new InternalServerException(
      `GoCardless request failed with status ${status}: ${endpoint}`
    );
  }
  return new InternalServerException(
    `GoCardless request failed (no response): ${endpoint}`
  );
};

type AppErrorLike = HttpException | InternalServerException;

/* ------------------------------ access token ----------------------------- */

interface CachedToken {
  access: string;
  expiresAtMs: number;
}

// Module-scoped token cache: one integration-wide token shared by every call,
// refreshed by re-POSTing /token/new/ when it has <60s left. The token value
// only ever lives here and in the Authorization header — never in errors,
// never in logs.
let cachedToken: CachedToken | null = null;

// Test seam: clears the module-scoped token cache so each test starts cold.
export const resetGoCardlessTokenCache = (): void => {
  cachedToken = null;
};

const getAccessToken = async (): Promise<string> => {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - now > TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.access;
  }
  const secretId = resolveCredentialRef(SECRET_ID_REF);
  const secretKey = resolveCredentialRef(SECRET_KEY_REF);
  let data: GoCardlessTokenResponse;
  try {
    const response = await axios.post<GoCardlessTokenResponse>(
      `${GOCARDLESS_BASE_URL}/token/new/`,
      { secret_id: secretId, secret_key: secretKey }
    );
    data = response.data;
  } catch (error) {
    throw toConnectorError(error, "POST /token/new/");
  }
  if (!data?.access || typeof data.access_expires !== "number") {
    throw new InternalServerException(
      "GoCardless token endpoint returned no usable access token"
    );
  }
  cachedToken = {
    access: data.access,
    expiresAtMs: now + data.access_expires * 1000,
  };
  return cachedToken.access;
};

const authorizedGet = async <T>(path: string): Promise<T> => {
  const token = await getAccessToken();
  try {
    const response = await axios.get<T>(`${GOCARDLESS_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    throw toConnectorError(error, `GET ${path}`);
  }
};

const authorizedPost = async <T>(path: string, body: unknown): Promise<T> => {
  const token = await getAccessToken();
  try {
    const response = await axios.post<T>(`${GOCARDLESS_BASE_URL}${path}`, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    throw toConnectorError(error, `POST ${path}`);
  }
};

/* --------------------------- amount conversion --------------------------- */

// "123.45", "5", "5.5", "-0.01" — optional sign, digits, optional fraction.
const DECIMAL_AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;

// GoCardless amounts are decimal MAJOR-unit strings; this converts them to
// integer minor-unit strings with pure string/BigInt math — no parseFloat, so
// nothing ever rounds. "5" @2 → "500", "5.5" @2 → "550", "-0.01" @2 → "-1".
// A fraction longer than `decimals` would silently lose money if truncated,
// so it throws instead. Exported for direct testing and reuse.
export const decimalToMinor = (amount: string, decimals: number): string => {
  if (typeof amount !== "string" || !DECIMAL_AMOUNT_PATTERN.test(amount)) {
    throw new InternalServerException(
      `Invalid GoCardless amount "${amount}": expected a decimal string like "123.45"`
    );
  }
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) {
    throw new InternalServerException(
      `GoCardless amount "${amount}" has more than ${decimals} fraction digits and cannot be converted without losing precision`
    );
  }
  // BigInt normalizes leading zeros; "-0.00" comes out as plain "0".
  const minor = BigInt(whole + fraction.padEnd(decimals, "0"));
  return negative && minor !== 0n ? `-${minor.toString()}` : minor.toString();
};

/* ------------------------------- connector ------------------------------- */

const fetchBalance = async (
  ctx: ConnectorContext
): Promise<NormalizedBalance> => {
  const data = await authorizedGet<GoCardlessBalancesResponse>(
    `/accounts/${encodeURIComponent(ctx.externalAccountId)}/balances/`
  );
  const balances = data.balances ?? [];
  // Preference order: interimAvailable (what's actually spendable right now)
  // → expected (booked + known pending) → whatever the bank sent first.
  const chosen =
    balances.find((b) => b.balanceType === "interimAvailable") ??
    balances.find((b) => b.balanceType === "expected") ??
    balances[0];
  if (!chosen) {
    throw new InternalServerException(
      `GoCardless returned no balances for account "${ctx.externalAccountId}"`
    );
  }
  return {
    balanceMinor: decimalToMinor(
      chosen.balanceAmount.amount,
      GOCARDLESS_DECIMALS
    ),
    currency: chosen.balanceAmount.currency,
    decimals: GOCARDLESS_DECIMALS,
    asOf: chosen.referenceDate ? new Date(chosen.referenceDate) : new Date(),
  };
};

const fetchTransactions = async (
  ctx: ConnectorContext,
  since: Date
): Promise<NormalizedTransaction[]> => {
  const dateFrom = since.toISOString().slice(0, 10); // YYYY-MM-DD
  const data = await authorizedGet<GoCardlessTransactionsResponse>(
    `/accounts/${encodeURIComponent(
      ctx.externalAccountId
    )}/transactions/?date_from=${dateFrom}`
  );
  // booked[] ONLY. pending[] rows carry no stable id (no
  // internalTransactionId, often no transactionId) and mutate or vanish when
  // they settle, so they cannot survive a re-sync as a dedupe key — they are
  // deliberately skipped and will arrive on a later sync once booked.
  const booked = data.transactions?.booked ?? [];
  // Skip-filter: a row with neither internalTransactionId nor transactionId
  // has no stable externalId, so it is dropped rather than invented an id —
  // booked.length minus the result length is the skipped-row count.
  const identifiable = booked.filter(
    (tx) => tx.internalTransactionId || tx.transactionId
  );
  return identifiable.map((tx) => ({
    // internalTransactionId is GoCardless's own stable id and survives bank
    // re-issuance of transactionId, so it wins when present.
    externalId: (tx.internalTransactionId ?? tx.transactionId) as string,
    title:
      tx.remittanceInformationUnstructured ??
      tx.creditorName ??
      tx.debtorName ??
      "Bank transaction",
    amountMinor: decimalToMinor(tx.transactionAmount.amount, GOCARDLESS_DECIMALS),
    currency: tx.transactionAmount.currency,
    date: new Date(tx.bookingDate),
    raw: tx,
  }));
};

export const gocardlessConnector: RailConnector = {
  type: "gocardless",
  fetchBalance,
  fetchTransactions,
};

/* --------------------------- onboarding client --------------------------- */
// Linking a bank is a three-step dance, all read-only:
//   1. listInstitutions(country) → pick the bank
//   2. createRequisition(institutionId, redirectUrl) → open `link` in a
//      browser, authenticate with the bank
//   3. getRequisition(id) → once status is "LN" (linked), `accounts` holds
//      the GoCardless account ids to store as Account.externalAccountId

export const listInstitutions = async (
  country: string
): Promise<GoCardlessInstitution[]> =>
  authorizedGet<GoCardlessInstitution[]>(
    `/institutions/?country=${encodeURIComponent(country)}`
  );

export const createRequisition = async (
  institutionId: string,
  redirectUrl: string
): Promise<GoCardlessRequisitionCreated> => {
  const data = await authorizedPost<GoCardlessRequisitionCreated>(
    "/requisitions/",
    { redirect: redirectUrl, institution_id: institutionId }
  );
  return { id: data.id, link: data.link };
};

export const getRequisition = async (
  id: string
): Promise<GoCardlessRequisition> => {
  const data = await authorizedGet<GoCardlessRequisition>(
    `/requisitions/${encodeURIComponent(id)}/`
  );
  return { id: data.id, status: data.status, accounts: data.accounts ?? [] };
};
