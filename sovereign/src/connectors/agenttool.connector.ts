import axios, { AxiosResponse } from "axios";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "./types";
import { resolveCredentialRef } from "./credentials";
import { InternalServerException } from "../utils/app-error";

// READ-ONLY agenttool connector — CashLoom as observer over the agent
// economy's one true ledger (economy.transactions, served by
// api.agenttool.dev). It only ever calls GET /v1/wallets/{id} and
// GET /v1/wallets/{id}/transactions; nothing behind this interface can move
// money (registry doctrine).
//
// SECRET DISCIPLINE — the bearer key rides in the Authorization HEADER,
// never the URL, so this rail lacks Alchemy's keyed-URL hazard. Errors still
// name the env VARIABLE only — never the key, never a response body
// (agenttool bodies are chatty by design and can echo request context).
// ONE HONEST CAVEAT unlike every other rail here: agenttool bearer keys have
// NO read-only scope upstream — the same key could call /fund, /spend or
// /payout if some OTHER code path held it. This connector never does, but the
// credential must be treated as hot: fence the bridge project's wallets with
// economy.policies on the agenttool side, and rotate on any doubt.
//
// SIGN CONVENTION — the ledger stores SIGNED integer minor units
// (positive = in, negative = out; agenttool api/src/db/schema/economy.ts),
// which is exactly NormalizedTransaction's contract: amounts are copied
// digit-for-digit with no arithmetic and no sign derivation from row type.

// Base URL is an optional deploy-time override (staging/self-host), read at
// call time like every connector env access. Not a credential — the Esplora
// ESPLORA_BASE_URL precedent.
const DEFAULT_BASE_URL = "https://api.agenttool.dev";

// Currency and minor-unit scale are pinned TOGETHER (the Alchemy precedent:
// CURRENCY + DECIMALS as a pair). The wallet reports its currency, but only
// currencies whose scale this connector knows are accepted — an unknown
// currency is refused loudly rather than mis-scaled 10-100x. A half-pinned
// denomination would defeat every one of sync.service's guards: both methods
// would self-consistently report the wrong scale, so the decimals-mismatch
// refusal could never fire.
const DECIMALS_BY_CURRENCY: Record<string, number> = { GBP: 2 };

const REQUEST_TIMEOUT_MS = 10_000;

// GET /v1/wallets/{id}/transactions is newest-first (createdAt DESC with an
// id DESC tiebreaker upstream — the ordering is total, so offset paging is
// stable) and caps limit at 200. MAX_PAGES is a pure runaway guard sized to
// be unreachable (40k rows/sync): offset paging strictly progresses, so the
// walk normally ends at the window boundary or a short page. Hitting the
// ceiling anyway means the window is INCOMPLETE — that throws (see
// fetchTransactions), never a silent truncation: the sync watermark would
// advance past the dropped rows forever, the least-debuggable ledger gap.
const PAGE_LIMIT = 200;
const MAX_PAGES = 200;

/* ------------------------------ wire shapes ------------------------------ */

// agenttool envelopes every success as { success: true, data: ... } plus
// decorative fields (_welcomed etc.) that are deliberately ignored here.
interface WalletData {
  id?: unknown;
  currency?: unknown;
  balance?: unknown;
}

interface WalletEnvelope {
  success?: unknown;
  data?: WalletData | null;
}

interface LedgerRow {
  id?: unknown;
  type?: unknown;
  amount?: unknown;
  counterparty?: unknown;
  description?: unknown;
  createdAt?: unknown;
}

interface TransactionsEnvelope {
  success?: unknown;
  data?: LedgerRow[] | null;
}

/* ------------------------------- plumbing -------------------------------- */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait from a 429's Retry-After header. Defaults to 1s when the
// header is missing/garbage, capped at 30s so a hostile header can't park the
// sync indefinitely (Stripe/Alchemy connector strategy).
const retryAfterSeconds = (headerValue: unknown): number => {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 1;
  return Math.min(seconds, 30);
};

// Per-connector namespace guard, FIRST in both methods — defence in depth
// behind the validator and resolveCredentialRef's global allowlist: this
// connector only ever resolves AGENTTOOL_* env vars, so a stored ref naming
// some OTHER credential can never be read, let alone transmitted upstream.
const credentialRefFor = (ctx: ConnectorContext): string => {
  const ref = ctx.credentialRef;
  if (!ref || !ref.startsWith("AGENTTOOL_")) {
    throw new InternalServerException(
      `Refusing credentialRef "${
        ref ?? ""
      }" for the agenttool connector: it must name an AGENTTOOL_* environment variable`
    );
  }
  return ref;
};

const baseUrl = (): string => {
  const override = process.env.AGENTTOOL_BASE_URL;
  const trimmed = typeof override === "string" ? override.trim() : "";
  return (trimmed !== "" ? trimmed : DEFAULT_BASE_URL).replace(/\/+$/, "");
};

// One authenticated GET with the house error mapping. validateStatus passes
// every HTTP status through so each non-2xx lands here, not in an axios throw.
// 401/403 → misconfigured credential naming the env VAR (500-family, house
// rule); 429 → honor Retry-After once, then fail; anything else non-2xx →
// fixed prose + status only, never the response body.
const apiGet = async <T>(
  path: string,
  key: string,
  credentialRef: string
): Promise<T> => {
  let retriedRateLimit = false;
  for (;;) {
    let response: AxiosResponse<T>;
    try {
      response = await axios.get<T>(`${baseUrl()}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      // validateStatus absorbs every HTTP status, so landing here means the
      // request died below HTTP (DNS, TLS, ECONNRESET, timeout...). Re-wrap:
      // only the network code + path survive, never the axios config.
      const code = (error as { code?: unknown })?.code;
      throw new InternalServerException(
        `agenttool GET ${path} failed before any HTTP response${
          typeof code === "string" && code !== "" ? ` (${code})` : ""
        }`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new InternalServerException(
        `agenttool rejected the credential from environment variable "${credentialRef}" (GET ${path}, HTTP ${response.status}): the key is likely revoked, rotated, or from the wrong project`
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
        `agenttool rate limit (HTTP 429) persisted after one Retry-After backoff (GET ${path})`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new InternalServerException(
        `agenttool GET ${path} failed with HTTP ${response.status}`
      );
    }

    return response.data;
  }
};

/* ----------------------------- field parsing ----------------------------- */

// Ledger amounts arrive as JSON numbers from a bigint column. Anything that
// is not a safe integer means we are misreading the payload (or an amount
// overflowed the float bridge) — refuse rather than corrupt money by even one
// unit. Alchemy's hexToBigInt refusal is the precedent.
const minorAmount = (value: unknown, where: string): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InternalServerException(
      `agenttool returned a non-integer amount for ${where}; refusing to treat it as minor units`
    );
  }
  return String(value);
};

// createdAt → epoch ms. Unparseable means the since-window logic would be
// flying blind — refuse (Alchemy blockTimestamp precedent).
const rowTimestampMs = (row: LedgerRow, where: string): number => {
  const stamp = row.createdAt;
  const ms = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(ms)) {
    throw new InternalServerException(
      `agenttool ledger row ${where} is missing a parseable createdAt; cannot window transactions`
    );
  }
  return ms;
};

const walletDenomination = (
  data: WalletData,
  where: string
): { currency: string; decimals: number } => {
  const currency =
    typeof data.currency === "string" ? data.currency.trim().toUpperCase() : "";
  if (currency === "") {
    throw new InternalServerException(
      `agenttool returned no currency for ${where}; refusing to guess the account's denomination`
    );
  }
  const decimals = DECIMALS_BY_CURRENCY[currency];
  if (decimals === undefined) {
    throw new InternalServerException(
      `agenttool wallet reports currency "${currency}", whose minor-unit scale this connector does not know; refusing to guess and mis-scale amounts`
    );
  }
  return { currency, decimals };
};

// "fund · Ring-2 birth credit" — ledger type plus the most human label
// available, clamped so a long description can't bloat titles.
const rowTitle = (row: LedgerRow): string => {
  const type = typeof row.type === "string" && row.type !== "" ? row.type : "ledger";
  const label =
    typeof row.counterparty === "string" && row.counterparty !== ""
      ? row.counterparty
      : typeof row.description === "string" && row.description !== ""
        ? row.description
        : "agent economy";
  return `${type} · ${label}`.slice(0, 80);
};

const fetchWallet = async (
  ctx: ConnectorContext,
  key: string,
  ref: string
): Promise<WalletData> => {
  const envelope = await apiGet<WalletEnvelope>(
    `/v1/wallets/${encodeURIComponent(ctx.externalAccountId)}`,
    key,
    ref
  );
  const data = envelope?.data;
  if (envelope?.success !== true || !data || typeof data !== "object") {
    throw new InternalServerException(
      "agenttool GET /v1/wallets/{id} returned an unexpected response shape"
    );
  }
  return data;
};

/* ------------------------------- connector ------------------------------- */

export const agenttoolConnector: RailConnector = {
  type: "agenttool",

  // The wallet's balance column IS the derived truth (every ledger row already
  // settled into it) — read it whole, never recompute it from rows.
  async fetchBalance(ctx: ConnectorContext): Promise<NormalizedBalance> {
    const ref = credentialRefFor(ctx);
    const key = resolveCredentialRef(ref);
    const wallet = await fetchWallet(ctx, key, ref);
    const { currency, decimals } = walletDenomination(wallet, "wallet");
    return {
      balanceMinor: minorAmount(wallet.balance, "wallet balance"),
      currency,
      decimals,
      asOf: new Date(),
    };
  },

  // Offset-paged walk of the newest-first ledger, stopping once a page's
  // oldest row predates `since` (everything further is older still), the page
  // comes back short (no more data), or the MAX_PAGES ceiling. Ledger rows
  // carry no currency — the wallet defines it — so the wallet is read once
  // and every row is stamped with its currency (sync's foreign-currency drop
  // then guards account misconfiguration, not per-row drift).
  async fetchTransactions(
    ctx: ConnectorContext,
    since: Date
  ): Promise<NormalizedTransaction[]> {
    const ref = credentialRefFor(ctx);
    const key = resolveCredentialRef(ref);
    const wallet = await fetchWallet(ctx, key, ref);
    const { currency } = walletDenomination(wallet, "wallet");
    const walletPath = `/v1/wallets/${encodeURIComponent(ctx.externalAccountId)}`;

    const sinceMs = since.getTime();
    const transactions: NormalizedTransaction[] = [];
    let reachedWindowStart = false;

    for (let page = 0; page < MAX_PAGES && !reachedWindowStart; page++) {
      const envelope = await apiGet<TransactionsEnvelope>(
        `${walletPath}/transactions?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`,
        key,
        ref
      );
      const rows = envelope?.data;
      if (envelope?.success !== true || !Array.isArray(rows)) {
        throw new InternalServerException(
          "agenttool GET /v1/wallets/{id}/transactions returned an unexpected response shape"
        );
      }
      if (rows.length === 0) {
        reachedWindowStart = true;
        break;
      }

      for (const row of rows) {
        const id = row.id;
        if (typeof id !== "string" || id === "") {
          // No stable id → no dedupe key. Dropped rather than invented
          // (GoCardless precedent); it could never re-sync consistently.
          continue;
        }
        const ms = rowTimestampMs(row, id);
        if (ms < sinceMs) {
          // Straddling page: rows past the window boundary are filtered
          // here; whether to KEEP PAGING is decided below on the boundary
          // row only.
          continue;
        }
        transactions.push({
          externalId: id,
          title: rowTitle(row),
          amountMinor: minorAmount(row.amount, `ledger row ${id}`),
          currency,
          date: new Date(ms),
          raw: row,
        });
      }

      // Ordering is total (createdAt DESC, id DESC upstream), so the page's
      // LAST row is its oldest: once it predates the window — or the page
      // comes back short — every later page is older still. Deciding on the
      // boundary row only (Alchemy precedent) keeps one anomalous timestamp
      // mid-page from ending the walk early and dropping newer rows.
      const oldest = rows[rows.length - 1];
      const oldestId =
        typeof oldest.id === "string" && oldest.id !== ""
          ? oldest.id
          : "(id-less row)";
      if (rows.length < PAGE_LIMIT || rowTimestampMs(oldest, oldestId) < sinceMs) {
        reachedWindowStart = true;
      }
    }

    if (!reachedWindowStart) {
      // Silent truncation is forbidden: sync.service computes the next
      // window's `since` from the NEWEST imported row, so anything dropped
      // on the old side would never be revisited — a permanent, unwarned
      // ledger gap behind a correct balance. Refuse the whole window.
      throw new InternalServerException(
        `agenttool ledger walk hit the ${MAX_PAGES * PAGE_LIMIT}-row page ceiling before reaching the sync window start; refusing to return an incomplete window`
      );
    }

    return transactions;
  },
};
