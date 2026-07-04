import axios, { AxiosResponse } from "axios";
import {
  ConnectorContext,
  NormalizedBalance,
  NormalizedTransaction,
  RailConnector,
} from "./types";
import { InternalServerException } from "../utils/app-error";

// READ-ONLY Bitcoin connector over the Esplora HTTP API (Blockstream's open
// block-explorer backend; mempool.space serves the same shapes). Esplora is a
// KEYLESS public indexer: it watches addresses anyone can watch, so this
// connector never imports resolveCredentialRef, never reads a credential env
// var, and refuses — loudly — any ConnectorContext that carries one (see
// assertKeyless). There is no money-movement surface at all: every endpoint
// touched here is a public read of public chain data.

// Default public instance. Overridable per deployment via ESPLORA_BASE_URL
// (e.g. https://mempool.space/api, or a self-hosted Esplora) — read AT CALL
// TIME, not module load, so tests and ops can swap it without re-importing.
const DEFAULT_BASE_URL = "https://blockstream.info/api";

const esploraBaseUrl = (): string =>
  process.env.ESPLORA_BASE_URL?.trim() || DEFAULT_BASE_URL;

// Bitcoin's minor unit is the satoshi: 1 BTC = 10^8 sats. Both constants are
// hard-coded and NEVER derived from API responses — fetchBalance and
// fetchTransactions MUST report identical currency/decimals every time, or
// the sync service's whole-import refusal on a decimals mismatch would no-op
// every subsequent sync for the account.
const CURRENCY = "BTC";
const DECIMALS = 8;

// Confirm-N-blocks before a transaction is allowed to import, per the reorg
// invariant in the AWS architecture blueprint (cashloom-aws/ARCHITECTURE.md:
// "Confirm-before-publish prevents reorg double-credit"). Sync imports are
// insert-only and never retracted, so depth is the only protection against a
// reorged-away transaction living forever in the ledger; 6 blocks (~1 hour)
// is the classic Bitcoin finality heuristic. The BALANCE, by contrast, is
// re-derived from chain_stats at the tip on every sync, so it self-corrects —
// a deliberate asymmetry, not a bug, when balance and history briefly differ.
const MIN_CONFIRMATIONS = 6;

const REQUEST_TIMEOUT_MS = 10_000;

// Esplora pages /txs/chain at 25 transactions per page, so 400 pages caps one
// sync window at 10k transactions — a hard ceiling so a broken pagination
// loop can never spin forever against a public API. Hitting the ceiling STOPS
// and returns what was collected (unlike Stripe's throw): overlapping/partial
// windows are safe because sync dedupes on externalId, and the next sync
// resumes from its own window.
const MAX_PAGES = 400;

/* ------------------------------ wire shapes ------------------------------ */
// Only the fields this connector reads.

interface EsploraAddressStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
}

interface EsploraAddressResponse {
  chain_stats?: EsploraAddressStats;
  // mempool_stats exists on the wire but is DELIBERATELY never read: it
  // describes unconfirmed transactions, and an unconfirmed balance can vanish
  // in a reorg or RBF replacement. Confirmed chain_stats only.
  mempool_stats?: EsploraAddressStats;
}

interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number; // unix seconds
}

interface EsploraPrevout {
  scriptpubkey_address?: string;
  value: number; // sats
}

interface EsploraVin {
  // null for coinbase inputs — there is no previous output to describe.
  prevout?: EsploraPrevout | null;
}

interface EsploraVout {
  scriptpubkey_address?: string;
  value: number; // sats
}

interface EsploraTx {
  txid: string;
  status: EsploraTxStatus;
  vin?: EsploraVin[];
  vout?: EsploraVout[];
}

/* ----------------------------- error handling ---------------------------- */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Seconds to wait from a 429's Retry-After header. Defaults to 1s when the
// header is missing/garbage, capped at 30s so a hostile header can't park the
// sync indefinitely (same strategy as the Stripe connector).
const retryAfterSeconds = (headerValue: unknown): number => {
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return 1;
  return Math.min(seconds, 30);
};

// Esplora is keyless, but the error discipline still matters: the
// errorHandler middleware console.logs raw error objects, so everything
// thrown from here carries ONLY the HTTP status / transport code plus a path
// TEMPLATE ('/address/:addr') — never the concrete URL with the watched
// address, and never a response payload.
const shapeError = (pathTemplate: string, detail: string) =>
  new InternalServerException(
    `unexpected Esplora response shape on GET ${pathTemplate}: ${detail}`
  );

// One GET against the Esplora API. validateStatus passes every status through
// so non-2xx is mapped here, not thrown raw by axios; the catch block is
// transport-only (DNS/TLS/ECONNRESET/timeout) and re-wraps keeping only
// error.code + the path template — no axios config survives into the wrapped
// error. 429 honors Retry-After once, then fails loud.
const esploraGet = async <T>(path: string, pathTemplate: string): Promise<T> => {
  const baseUrl = esploraBaseUrl();
  let retriedRateLimit = false;
  for (;;) {
    let response: AxiosResponse<T>;
    try {
      response = await axios.get<T>(`${baseUrl}${path}`, {
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      throw new InternalServerException(
        `Esplora GET ${pathTemplate} failed before any HTTP response${
          typeof code === "string" && code !== "" ? ` (${code})` : ""
        }`
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
        `Esplora rate limit (HTTP 429) persisted after one Retry-After backoff on GET ${pathTemplate}`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new InternalServerException(
        `Esplora GET ${pathTemplate} failed with HTTP ${response.status}`
      );
    }

    return response.data;
  }
};

/* ------------------------------ sat handling ------------------------------ */

// Esplora reports satoshi amounts as JSON numbers. Bitcoin's maximum supply
// is 2.1e15 sats < 2^53, so every legitimate value is an exactly-represented
// integer — anything outside Number.isSafeInteger is an indexer anomaly, and
// converting it would silently corrupt a balance. Throw rather than round;
// the message names the field, never echoes the payload.
const satToBigInt = (
  value: unknown,
  field: string,
  pathTemplate: string
): bigint => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw shapeError(pathTemplate, `${field} is not a safe-integer satoshi amount`);
  }
  return BigInt(value);
};

// Net sats for the watched address in one transaction, all BigInt:
// everything the tx pays TO the address minus everything it spends FROM the
// address. A spend with change back to self nets to the true outflow; a pure
// self-spend nets to exactly zero (callers skip those rows).
const netSatsFor = (tx: EsploraTx, address: string): bigint => {
  let received = 0n;
  for (const vout of tx.vout ?? []) {
    if (vout?.scriptpubkey_address === address) {
      received += satToBigInt(
        vout.value,
        "vout[].value",
        "/address/:addr/txs/chain"
      );
    }
  }
  let spent = 0n;
  for (const vin of tx.vin ?? []) {
    const prevout = vin?.prevout; // null on coinbase inputs
    if (prevout && prevout.scriptpubkey_address === address) {
      spent += satToBigInt(
        prevout.value,
        "vin[].prevout.value",
        "/address/:addr/txs/chain"
      );
    }
  }
  return received - spent;
};

/* -------------------------- address canonicalization ----------------------- */

// Bech32 human-readable-part prefixes (mainnet / testnet / regtest). No legacy
// Base58 address can collide with these in any casing: mainnet P2PKH starts
// with '1', P2SH with '3', testnet legacy with 'm'/'n'/'2'.
const BECH32_HRP_PREFIX = /^(bc1|tb1|bcrt1)/i;

// BIP-173 defines TWO valid encodings of a bech32 address: all-lowercase (the
// canonical form — and the only one Esplora ever prints in
// scriptpubkey_address) and ALL-UPPERCASE (the QR alphanumeric-mode form, a
// likely paste source). Mixed case is invalid by definition. Nothing upstream
// normalizes the stored watch address (the validator only trims it), and
// netSatsFor compares scriptpubkey_address with strict ===, so without this
// step an uppercase bech32 address either fails every request — or, worse,
// syncs a correct balance while every vout/vin comparison misses: each
// transaction nets to exactly zero and is skipped as a "self-spend", leaving
// a permanently empty, warning-free history. Uniform-uppercase bech32 is
// folded to the canonical lowercase; mixed case is refused loudly; Base58
// legacy addresses are case-SENSITIVE and pass through verbatim.
const canonicalWatchAddress = (address: string): string => {
  if (!BECH32_HRP_PREFIX.test(address)) {
    return address; // legacy Base58 — case-sensitive, never touched
  }
  const lower = address.toLowerCase();
  if (address === lower) {
    return address; // already canonical
  }
  if (address === address.toUpperCase()) {
    return lower; // uniform uppercase (the QR form) → canonical lowercase
  }
  // Mixed case can never be valid bech32 — refuse with a clear message
  // instead of letting the indexer fail opaquely (the address itself stays
  // out of the error per the house discipline).
  throw new InternalServerException(
    "esplora watch address is mixed-case bech32, which BIP-173 forbids — store the address in its canonical all-lowercase form"
  );
};

/* ------------------------------ keyless guard ----------------------------- */

// Esplora needs no credential, so a ConnectorContext that CARRIES one is a
// misconfiguration to refuse loudly, not ignore: a stored STRIPE_*/ALCHEMY_*
// pointer reaching this connector means an Account document is wired to the
// wrong rail, and silently proceeding would mask that. Throws BEFORE any env
// read or HTTP — nothing is resolved, nothing leaves the box. The message
// names the ref VARIABLE only (a credentialRef is an env var NAME by
// contract, never a secret value).
const assertKeyless = (ctx: ConnectorContext): void => {
  if (ctx.credentialRef != null) {
    throw new InternalServerException(
      `esplora is a keyless public-indexer connector; refusing unexpected credentialRef "${ctx.credentialRef}"`
    );
  }
};

/* ------------------------------- connector -------------------------------- */

// GET /address/{addr} → confirmed balance = funded - spent, exact BigInt.
// chain_stats ONLY (see the wire-shape note on mempool_stats). The balance is
// re-derived at the current tip every sync, so it self-corrects across reorgs.
const fetchBalance = async (
  ctx: ConnectorContext
): Promise<NormalizedBalance> => {
  assertKeyless(ctx);
  const address = canonicalWatchAddress(ctx.externalAccountId);
  const pathTemplate = "/address/:addr";
  const data = await esploraGet<EsploraAddressResponse>(
    `/address/${encodeURIComponent(address)}`,
    pathTemplate
  );

  const stats = data?.chain_stats;
  if (typeof stats !== "object" || stats === null) {
    throw shapeError(pathTemplate, "chain_stats is missing");
  }
  const funded = satToBigInt(
    stats.funded_txo_sum,
    "chain_stats.funded_txo_sum",
    pathTemplate
  );
  const spent = satToBigInt(
    stats.spent_txo_sum,
    "chain_stats.spent_txo_sum",
    pathTemplate
  );
  const balance = funded - spent;
  if (balance < 0n) {
    // More spent than ever funded is impossible on a consistent chain view —
    // the indexer is mid-reindex or broken. Refuse rather than store it.
    throw new InternalServerException(
      "Esplora reports spent_txo_sum greater than funded_txo_sum (negative confirmed balance) — indexer inconsistency; refusing to sync it"
    );
  }

  return {
    balanceMinor: balance.toString(),
    currency: CURRENCY,
    decimals: DECIMALS,
    asOf: new Date(),
  };
};

// GET /blocks/tip/height returns the height as a PLAIN-TEXT integer; axios
// JSON-parses "900000" to a number, but a text/plain content type can leave
// it a string — accept both, refuse everything else.
const fetchTipHeight = async (): Promise<number> => {
  const pathTemplate = "/blocks/tip/height";
  const data = await esploraGet<unknown>("/blocks/tip/height", pathTemplate);
  const tip =
    typeof data === "string" && /^\d+$/.test(data.trim())
      ? Number(data.trim())
      : data;
  if (typeof tip !== "number" || !Number.isSafeInteger(tip) || tip < 0) {
    throw shapeError(pathTemplate, "expected a plain-text integer block height");
  }
  return tip;
};

// GET /address/{addr}/txs/chain[/{last_seen_txid}], newest-first, 25 per
// page. Only transactions that are confirmed at depth >= MIN_CONFIRMATIONS
// import (tip is fetched once up front; confirmations = tip - height + 1).
// Stops on: a page whose oldest confirmed block_time predates `since`, an
// empty page, or the MAX_PAGES ceiling — all safe because callers dedupe on
// externalId, so an overlapping window is expected, not a bug.
const fetchTransactions = async (
  ctx: ConnectorContext,
  since: Date
): Promise<NormalizedTransaction[]> => {
  assertKeyless(ctx);
  // Canonical form for BOTH the URL and the netting comparisons below —
  // Esplora always reports scriptpubkey_address in lowercase bech32.
  const address = canonicalWatchAddress(ctx.externalAccountId);
  const pathTemplate = "/address/:addr/txs/chain";
  const tip = await fetchTipHeight();
  const sinceMs = since.getTime();

  const transactions: NormalizedTransaction[] = [];
  let lastSeenTxid: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path =
      `/address/${encodeURIComponent(address)}/txs/chain` +
      (lastSeenTxid === undefined
        ? ""
        : `/${encodeURIComponent(lastSeenTxid)}`);
    const txs = await esploraGet<EsploraTx[]>(path, pathTemplate);
    if (!Array.isArray(txs)) {
      throw shapeError(pathTemplate, "expected an array of transactions");
    }
    if (txs.length === 0) {
      break;
    }

    let oldestBlockTimeMs: number | undefined;
    for (const tx of txs) {
      if (typeof tx?.txid !== "string" || tx.txid === "") {
        throw shapeError(pathTemplate, "transaction is missing its txid");
      }

      // /txs/chain should only ever return confirmed transactions, but trust
      // the status field, not the endpoint's reputation.
      if (tx.status?.confirmed !== true) {
        continue;
      }
      const blockHeight = tx.status.block_height;
      const blockTime = tx.status.block_time;
      if (
        !Number.isSafeInteger(blockHeight) ||
        !Number.isSafeInteger(blockTime)
      ) {
        throw shapeError(
          pathTemplate,
          "confirmed transaction is missing integer block_height/block_time"
        );
      }
      const blockTimeMs = (blockTime as number) * 1000;
      oldestBlockTimeMs =
        oldestBlockTimeMs === undefined
          ? blockTimeMs
          : Math.min(oldestBlockTimeMs, blockTimeMs);

      const confirmations = tip - (blockHeight as number) + 1;
      if (confirmations < MIN_CONFIRMATIONS) {
        continue; // too shallow — it will import on a later sync, post-depth
      }
      if (blockTimeMs < sinceMs) {
        continue; // before the requested window
      }

      const net = netSatsFor(tx, address);
      if (net === 0n) {
        continue; // pure self-spend: no value moved for this address
      }

      transactions.push({
        // The txid is the rail's stable id, and the NET amount per address is
        // a pure function of the txid (the tx's inputs/outputs never change),
        // so txid alone is a stable dedupe key — no :vout suffix needed, and
        // adding one would split a single economic event into per-output rows.
        externalId: tx.txid,
        title: `BTC ${net < 0n ? "sent" : "received"} · ${tx.txid.slice(0, 12)}`,
        // Signed: negative = money out. The sync service's EXPENSE/INCOME
        // classification trusts this sign.
        amountMinor: net.toString(),
        currency: CURRENCY,
        date: new Date(blockTimeMs),
        raw: tx, // reconciliation only — never rendered, never logged
      });
    }

    // Newest-first pages: once this page reaches back past `since`, every
    // later page is older still.
    if (oldestBlockTimeMs !== undefined && oldestBlockTimeMs < sinceMs) {
      break;
    }

    // Esplora threads pagination on the LAST txid of the page just seen.
    lastSeenTxid = txs[txs.length - 1].txid;
  }

  return transactions;
};

export const esploraConnector: RailConnector = {
  type: "esplora",
  fetchBalance,
  fetchTransactions,
};
