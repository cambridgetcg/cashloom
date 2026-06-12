import axios, { AxiosResponse } from "axios";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "./types";
import { resolveCredentialRef } from "./credentials";
import { InternalServerException } from "../utils/app-error";

// READ-ONLY Alchemy (Ethereum mainnet) connector over plain JSON-RPC — axios
// is the house HTTP client, no Alchemy SDK. It only ever calls eth_getBalance
// and alchemy_getAssetTransfers, so even a leaked key from this code path
// could not move anything (and the key should be READ-ONLY scoped anyway).
//
// SECRET DISCIPLINE — the key rides in the URL PATH (/v2/{key}), which makes
// this connector's error handling load-bearing: one raw axios error reaching
// errorHandler's console.log would print the full request URL — key included —
// to the server logs. The sync service's SECRET_PATTERN does NOT match Alchemy
// key shapes, so redaction-after-the-fact cannot save us; NEVER embedding the
// key (or any URL) in an error is the PRIMARY defense here. Every failure is
// re-wrapped through rpcPost into an InternalServerException carrying only the
// JSON-RPC method, the HTTP status / rpc error code, and the env VARIABLE name
// — never the URL, never a response body, never the axios config. (P2-8 adds a
// /v2/<token> redaction backstop in sync's safeErrorMessage as belt-and-braces.)
//
// FINALITY — both methods read at the finalized head: post-merge finality IS
// confirm-N for EVM (~13 min lag, deliberate — do not mistake the lag for a
// bug). Sync is insert-only and never retracts, so reading anything shallower
// would let a reorg bake phantom rows into the ledger forever. eth_getBalance
// takes the 'finalized' tag directly (standard JSON-RPC); the transfers sweep
// resolves the tag to a concrete hex height first — see
// resolveFinalizedToBlock for why the tag must not ride into
// alchemy_getAssetTransfers itself.

const ALCHEMY_BASE_URL = "https://eth-mainnet.g.alchemy.com/v2";

// This connector is ETH-mainnet only, so currency and minor-unit scale are
// hard-coded module constants, NEVER derived from API responses: both methods
// MUST report identical decimals or the sync service's whole-import refusal
// (decimals-mismatch guard) would fire — or worse, silently no-op — on every
// sync.
const CURRENCY = "ETH";
const DECIMALS = 18;

// Post-merge finalized head — see the finality note in the file header.
const BLOCK_TAG = "finalized";

const REQUEST_TIMEOUT_MS = 10_000;

// alchemy_getAssetTransfers maxCount is a hex quantity; 0x3e8 = 1000, the
// endpoint's maximum page size.
const MAX_COUNT_HEX = "0x3e8";

// Hard ceiling per direction (20 pages × 1000 transfers). Pagination walks
// newest-first, so hitting the ceiling keeps the newest 20k transfers and
// STOPS (no throw): overlapping windows are safe — sync dedupes on externalId
// — and a broken pageKey loop can never spin forever against the live API.
const MAX_PAGES = 20;

// Contract-mediated ETH ('internal' transfers) is real money movement, so both
// categories are requested; uniqueId disambiguates transfers sharing a hash.
const TRANSFER_CATEGORIES = ["external", "internal"];

/* ------------------------------ wire shapes ------------------------------ */

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcEnvelope<T> {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: JsonRpcError;
}

interface AssetTransferRawContract {
  // Hex wei quantity — the ONLY field money is ever read from.
  value?: string | null;
  address?: string | null;
  decimal?: string | null;
}

interface AssetTransfer {
  // Alchemy's stable per-transfer id (e.g. "0x<hash>:external"). Rows lacking
  // it are dropped — ids are never fabricated (GoCardless precedent).
  uniqueId?: string;
  hash?: string;
  from?: string;
  to?: string | null;
  // DECIMAL FLOAT — deliberately typed but NEVER read for money; a double
  // cannot hold 18-decimal wei amounts. rawContract.value (hex) is the truth.
  value?: number | null;
  asset?: string | null;
  category?: string;
  rawContract?: AssetTransferRawContract;
  metadata?: { blockTimestamp?: string };
}

interface AssetTransfersResult {
  transfers?: AssetTransfer[];
  pageKey?: string;
}

/* ------------------------------- plumbing -------------------------------- */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait from a 429's Retry-After header. Defaults to 1s when the
// header is missing/garbage, capped at 30s so a hostile header can't park the
// sync indefinitely (Stripe connector strategy).
const retryAfterSeconds = (headerValue: unknown): number => {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 1;
  return Math.min(seconds, 30);
};

// Per-connector namespace guard, FIRST in both methods — defence in depth
// behind the validator and resolveCredentialRef's global allowlist: this
// connector only ever resolves ALCHEMY_* env vars, so a stored ref naming some
// OTHER credential (STRIPE_RESTRICTED_KEY, GOCARDLESS_SECRET_KEY...) can never
// be read, let alone transmitted to Alchemy inside a URL. Throws before any
// env read or HTTP; the message names the variable, never any value.
const credentialRefFor = (ctx: ConnectorContext): string => {
  const ref = ctx.credentialRef;
  if (!ref || !ref.startsWith("ALCHEMY_")) {
    throw new InternalServerException(
      `Refusing credentialRef "${
        ref ?? ""
      }" for the Alchemy connector: it must name an ALCHEMY_* environment variable`
    );
  }
  return ref;
};

// One JSON-RPC call with the house error mapping. validateStatus passes every
// HTTP status through so each non-2xx lands here, not in an axios throw whose
// config would carry the keyed URL. 401/403 → misconfigured credential naming
// the env VAR (500-family, house rule); 429 → honor Retry-After once, then
// fail; rpc error objects → fixed prose + numeric code, never the upstream
// message (which can echo the request URL — and therefore the key).
const rpcPost = async <T>(
  method: string,
  params: unknown[],
  key: string,
  credentialRef: string
): Promise<T> => {
  let retriedRateLimit = false;
  for (;;) {
    let response: AxiosResponse<JsonRpcEnvelope<T>>;
    try {
      response = await axios.post<JsonRpcEnvelope<T>>(
        `${ALCHEMY_BASE_URL}/${key}`,
        { jsonrpc: "2.0", id: 1, method, params },
        { timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true }
      );
    } catch (error) {
      // validateStatus absorbs every HTTP status, so landing here means the
      // request died below HTTP (DNS, TLS, ECONNRESET, timeout...). Re-wrap
      // instead of rethrowing: the raw axios error's config.url IS the keyed
      // /v2/{key} URL. Only the network code + method survive.
      const code = (error as { code?: unknown })?.code;
      throw new InternalServerException(
        `Alchemy JSON-RPC ${method} failed before any HTTP response${
          typeof code === "string" && code !== "" ? ` (${code})` : ""
        }`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new InternalServerException(
        `Alchemy rejected the credential from environment variable "${credentialRef}" (${method}, HTTP ${response.status}): the key is likely revoked, disabled, or not enabled for eth-mainnet`
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
        `Alchemy rate limit (HTTP 429) persisted after one Retry-After backoff (${method})`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new InternalServerException(
        `Alchemy JSON-RPC ${method} failed with HTTP ${response.status}`
      );
    }

    const envelope = response.data;
    if (envelope && typeof envelope === "object" && envelope.error) {
      // Fixed prose + numeric code only: upstream rpc messages are free text
      // and may embed the request URL — never echo them.
      const rpcCode =
        typeof envelope.error.code === "number"
          ? String(envelope.error.code)
          : "unknown";
      throw new InternalServerException(
        `Alchemy JSON-RPC ${method} returned an error (code ${rpcCode})`
      );
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      envelope.result === undefined
    ) {
      throw new InternalServerException(
        `Alchemy JSON-RPC ${method} returned an unexpected response shape`
      );
    }
    return envelope.result;
  }
};

/* ----------------------------- amount parsing ---------------------------- */

const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

// Hex wei quantity → BigInt, NO Number anywhere: wei exceeds 2^53 above
// ~0.009 ETH, so a single float hop would corrupt real balances. Anything
// non-hex means we're misreading the payload — refuse, without echoing it.
const hexToBigInt = (value: unknown, where: string): bigint => {
  if (typeof value !== "string" || !HEX_QUANTITY_PATTERN.test(value)) {
    throw new InternalServerException(
      `Alchemy returned a non-hex quantity for ${where}; refusing to treat it as wei`
    );
  }
  return BigInt(value);
};

// metadata.blockTimestamp (ISO string, present because withMetadata:true is
// always requested) → epoch ms. Unparseable means the since-window logic
// would be flying blind — refuse.
const transferTimestampMs = (transfer: AssetTransfer): number => {
  const stamp = transfer.metadata?.blockTimestamp;
  const ms = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(ms)) {
    throw new InternalServerException(
      "Alchemy asset transfer is missing a parseable metadata.blockTimestamp; cannot window transactions"
    );
  }
  return ms;
};

/* ------------------------------- transfers ------------------------------- */

// alchemy_getAssetTransfers is a PROPRIETARY endpoint whose fromBlock/toBlock
// are documented as hex quantity / integer / 'latest' / 'indexed' ONLY — the
// standard JSON-RPC block tags ('finalized', 'safe') are NOT documented for
// it, and an unsupported tag is rejected with -32602, which would fail every
// page of every transaction sync. So the tag is resolved ONCE per
// fetchTransactions through eth_getBlockByNumber (a standard method where the
// tag IS supported) and the resulting hex height is pinned as toBlock for
// every page of both direction sweeps: identical reorg semantics (nothing
// shallower than finalized is ever read), and both sweeps share one
// consistent upper bound instead of each racing the advancing head.
const resolveFinalizedToBlock = async (
  key: string,
  credentialRef: string
): Promise<string> => {
  const block = await rpcPost<{ number?: unknown } | null>(
    "eth_getBlockByNumber",
    [BLOCK_TAG, false],
    key,
    credentialRef
  );
  const number = block?.number;
  if (typeof number !== "string" || !HEX_QUANTITY_PATTERN.test(number)) {
    throw new InternalServerException(
      "Alchemy eth_getBlockByNumber returned no hex block number for the finalized tag"
    );
  }
  return number;
};

// One direction (fromAddress or toAddress = the account's address) of
// alchemy_getAssetTransfers, walked newest-first via pageKey. Stops on: no
// pageKey (no more data), a page whose oldest row already predates `since`
// (everything further is older still), or the MAX_PAGES ceiling. Overlap with
// a previous sync window is fine — callers dedupe on externalId.
const fetchTransferDirection = async (
  direction: { fromAddress: string } | { toAddress: string },
  since: Date,
  toBlock: string,
  key: string,
  credentialRef: string
): Promise<AssetTransfer[]> => {
  const collected: AssetTransfer[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, unknown> = {
      ...direction,
      category: [...TRANSFER_CATEGORIES],
      withMetadata: true,
      excludeZeroValue: true,
      order: "desc",
      maxCount: MAX_COUNT_HEX,
      toBlock,
    };
    if (pageKey !== undefined) {
      params.pageKey = pageKey;
    }
    const result = await rpcPost<AssetTransfersResult>(
      "alchemy_getAssetTransfers",
      [params],
      key,
      credentialRef
    );
    const transfers = result.transfers;
    if (!Array.isArray(transfers)) {
      throw new InternalServerException(
        "Alchemy JSON-RPC alchemy_getAssetTransfers returned an unexpected response shape"
      );
    }
    collected.push(...transfers);
    if (!result.pageKey || transfers.length === 0) {
      return collected;
    }
    // order:'desc' → the page's LAST row is its oldest. Once it predates the
    // window, every subsequent page is older still — stop paging.
    const oldest = transfers[transfers.length - 1];
    if (transferTimestampMs(oldest) < since.getTime()) {
      return collected;
    }
    pageKey = result.pageKey;
  }
  // MAX_PAGES ceiling — see the constant's comment: stop with the newest
  // transfers rather than throw or loop forever.
  return collected;
};

/* ------------------------------- connector ------------------------------- */

export const alchemyConnector: RailConnector = {
  type: "alchemy",

  // eth_getBalance at 'finalized' → hex wei → exact decimal string. This is
  // the derived truth for the account (gas is deliberately unmodeled in the
  // transfer rows below; the balance is always read whole from the chain).
  async fetchBalance(ctx: ConnectorContext): Promise<NormalizedBalance> {
    const ref = credentialRefFor(ctx);
    const key = resolveCredentialRef(ref);
    const result = await rpcPost<string>(
      "eth_getBalance",
      [ctx.externalAccountId, BLOCK_TAG],
      key,
      ref
    );
    return {
      balanceMinor: hexToBigInt(result, "eth_getBalance").toString(),
      currency: CURRENCY,
      decimals: DECIMALS,
      asOf: new Date(),
    };
  },

  // TWO paged alchemy_getAssetTransfers sweeps — sent (fromAddress) then
  // received (toAddress) — merged on uniqueId. ERC-20 rows are dropped HERE
  // (asset !== 'ETH'): this connector reports ETH only, and relying on sync's
  // currency-drop would still count them against import stats.
  async fetchTransactions(
    ctx: ConnectorContext,
    since: Date
  ): Promise<NormalizedTransaction[]> {
    const ref = credentialRefFor(ctx);
    const key = resolveCredentialRef(ref);
    const addr = ctx.externalAccountId.toLowerCase();

    // One resolution of the finalized head, shared by both direction sweeps —
    // see resolveFinalizedToBlock for why the tag itself never rides into
    // alchemy_getAssetTransfers.
    const toBlock = await resolveFinalizedToBlock(key, ref);

    const sent = await fetchTransferDirection(
      { fromAddress: ctx.externalAccountId },
      since,
      toBlock,
      key,
      ref
    );
    const received = await fetchTransferDirection(
      { toAddress: ctx.externalAccountId },
      since,
      toBlock,
      key,
      ref
    );

    // Merge the directions keyed on uniqueId: a self-transfer appears in BOTH
    // sweeps with the same uniqueId, and pagination overlap is harmless — the
    // first occurrence wins, duplicates collapse.
    const merged = new Map<string, AssetTransfer>();
    for (const transfer of [...sent, ...received]) {
      const uniqueId = transfer.uniqueId;
      if (typeof uniqueId !== "string" || uniqueId === "") {
        // No stable id → no dedupe key. Dropped rather than invented an id
        // (GoCardless precedent); it can never be re-synced consistently.
        continue;
      }
      if (transfer.asset !== CURRENCY) {
        // ERC-20 / NFT rows — out of scope for this connector.
        continue;
      }
      if (!merged.has(uniqueId)) {
        merged.set(uniqueId, transfer);
      }
    }

    const sinceMs = since.getTime();
    const transactions: NormalizedTransaction[] = [];
    for (const [uniqueId, transfer] of merged) {
      const fromMe = (transfer.from ?? "").toLowerCase() === addr;
      const toMe = (transfer.to ?? "").toLowerCase() === addr;
      if (fromMe && toMe) {
        // Pure self-transfer: net zero for the address. Gas is deliberately
        // unmodeled in transfer rows — eth_getBalance is the derived truth —
        // so a zero-net row would only add noise.
        continue;
      }
      const ms = transferTimestampMs(transfer);
      if (ms < sinceMs) {
        // Post-filter for rows older than the window that rode in on a page
        // straddling `since` — overlap-safe, sync dedupes anyway.
        continue;
      }
      // Money comes EXCLUSIVELY from rawContract.value (hex → BigInt). The
      // response's `value` field is a DECIMAL FLOAT and must never be read
      // for money — see the AssetTransfer shape.
      const wei = hexToBigInt(
        transfer.rawContract?.value,
        `asset transfer ${uniqueId}`
      );
      const hash = typeof transfer.hash === "string" ? transfer.hash : "";
      transactions.push({
        externalId: uniqueId,
        title: `ETH ${fromMe ? "sent" : "received"} · ${hash.slice(0, 12)}`,
        // Signed minor units: negative = money out (sync's EXPENSE/INCOME
        // mapping trusts the sign).
        amountMinor: fromMe && wei !== 0n ? `-${wei.toString()}` : wei.toString(),
        currency: CURRENCY,
        date: new Date(ms),
        raw: transfer,
      });
    }
    return transactions;
  },
};
