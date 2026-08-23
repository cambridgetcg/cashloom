/** BTC sender — mainnet, single-key P2WPKH, PSBT via @scure/btc-signer.
 *
 *  The "built ONCE" doctrine, ported to UTXO land: coin selection and the
 *  EXACT fee happen at QUOTE time and are persisted (payments.detail);
 *  confirm rebuilds that selection bit-for-bit — no re-selection, no
 *  re-fetch — signs with the vault key, and broadcasts the signed
 *  transaction through Esplora. The fee paid is the fee disclosed, to the
 *  satoshi, and the private key never touches the network (PROTOCOL.md §5.2).
 *
 *  Trust posture: Esplora is a KEYLESS public indexer. BIP-143 makes a lying
 *  indexer harmless to funds — the sighash commits every input's amount
 *  against a locally-derived script, so a wrong claimed value yields a
 *  consensus-invalid transaction, rejected at broadcast. The indexer's only
 *  levers are DoS-shaped (hidden UTXOs, refused broadcasts, silence) and
 *  every post-sign uncertainty fails safe here: duplicate-specific replies
 *  are idempotent success, while every other rejection or unanswered send
 *  lands AmbiguousBroadcastError so nothing invites a replacement spend.
 */

import {
  Address,
  NETWORK,
  OutScript,
  selectUTXO,
} from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  hashPreparedBitcoinTransaction,
  signBitcoinTransaction,
  verifySignedBitcoinTransaction,
  type PreparedBitcoinTransaction,
} from "../vault.ts";
import {
  AmbiguousBroadcastError,
  type PaymentInstruction,
  type PaymentQuote,
  type PaymentReceipt,
  type PaymentSender,
  type SenderContext,
  type SendHooks,
  type SignedTransactionEnvelope,
} from "./types.ts";

// Same indexer convention as the read rail (esplora.connector.ts): a URL,
// not a credential, read at call time so ops can swap it without re-import.
const esploraBaseUrl = (): string =>
  process.env.ESPLORA_BASE_URL?.trim() || "https://blockstream.info/api";

const REQUEST_TIMEOUT_MS = 10_000;

// RBF signal (BIP125): < 0xfffffffe, and keeps nLockTime enforceable for the
// anti-fee-sniping locktime below. No bump UI exists yet — the signal is a
// free constant that leaves the door open.
const RBF_SEQUENCE = 0xfffffffd;

// ~200 × 68 vB + outputs ≈ 13.7 kvB — far under the 100 kvB standardness
// ceiling, and keeps the input-count varint single-byte.
const MAX_INPUTS = 200;

// Change below this folds into the fee. 546 is the conservative classic
// bound (P2WPKH's true floor is 294); the fold costs at most 545 sats and is
// ALWAYS inside the disclosed fee — never an undisclosed remainder.
// NB: selectUTXO's `dust` option is denominated in VBYTES and multiplied by
// dustRelayFeeRate (default 3) — passing sats without pinning the rate to 1
// silently tripled the fold threshold to 1638 sats. Caught in review;
// dustRelayFeeRate: 1n below is what makes this constant mean satoshis.
const CHANGE_DUST_SAT = 546n;

// An expired quote releases its coins (mirrors pay.ts's QUOTE_TTL_MS — only
// a fresh 'quoted' row can ever be confirmed, so only a fresh one reserves).
const QUOTE_TTL_MS = 5 * 60 * 1000;

// Core's dust floor per DESTINATION script type. A below-dust output would
// pass quote and die at broadcast — the seam contract says quote() throws on
// an invalid amount, so it is refused up front, per type, not at 546-for-all
// (which would falsely refuse legal 294-sat bech32 sends).
const DEST_DUST_SAT: Record<string, bigint> = {
  wpkh: 294n,
  wsh: 330n,
  tr: 330n,
  sh: 540n,
  pkh: 546n,
};

// Conservative per-input ceiling for a P2WPKH spend (41 raw bytes ×4 +
// ≤108 WU witness = 272 WU = 68 vB) and tx overhead (42 WU = 10.5 → 11 vB).
// Used ONLY for the uneconomical-input filter and the max-sendable figure in
// errors — real fees come from the estimator, which sizes actual scripts.
const INPUT_VSIZE_CEIL = 68n;
const OVERHEAD_VSIZE_CEIL = 11n;

// Aim ~3 blocks (~30 min). Esplora keys /fee-estimates by target.
const FEE_TARGET_BLOCKS = 3;

// Sanity band on what a public indexer can talk us into. The confirm screen
// discloses the fee, but a manipulated five-figure rate should never reach a
// human who might fat-finger past it. Refuse-loud; env-overridable.
const envSat = (name: string, fallback: bigint): bigint => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer (got a non-integer value).`);
  }
  return BigInt(raw);
};
const maxFeeRateSatVb = (): bigint => envSat("CASHLOOM_BTC_MAX_FEE_RATE", 1000n);
const maxFeeSat = (): bigint => envSat("CASHLOOM_BTC_MAX_FEE_SAT", 100_000n);

/* ------------------------------ esplora reads ----------------------------- */
// Same discipline as the read connector: errors carry the path TEMPLATE and
// the HTTP status, never the concrete address or any response payload. No
// retry dance — quoting is interactive; fail loud, the human re-quotes.

const esploraGet = async (path: string, template: string): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(`${esploraBaseUrl()}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`Esplora GET ${template} failed before any HTTP response.`);
  }
  if (!response.ok) {
    throw new Error(`Esplora GET ${template} failed with HTTP ${response.status}.`);
  }
  return response;
};

// Esplora reports sats as JSON numbers; max supply 2.1e15 < 2^53, so every
// legitimate value is exactly representable — anything else is an indexer
// anomaly to refuse, not round (doctrine shared with esplora.connector.ts).
const satFromApi = (value: unknown, field: string, template: string): bigint => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Esplora GET ${template}: ${field} is not a safe-integer satoshi amount.`);
  }
  return BigInt(value);
};

interface ConfirmedUtxo {
  txid: string;
  vout: number;
  sat: bigint;
}

const TXID_PATTERN = /^[0-9a-f]{64}$/;

// GET /address/:addr/utxo returns confirmed AND mempool entries — trust each
// entry's status.confirmed field, not the endpoint's reputation. Unconfirmed
// value is tallied separately so an insufficient-funds error can say "yours
// is coming" instead of contradicting the balance on screen.
const fetchUtxos = async (
  address: string
): Promise<{ confirmed: ConfirmedUtxo[]; pendingSat: bigint }> => {
  const template = "/address/:addr/utxo";
  const data = await (
    await esploraGet(`/address/${encodeURIComponent(address)}/utxo`, template)
  ).json();
  if (!Array.isArray(data)) {
    throw new Error(`Esplora GET ${template}: expected an array of UTXOs.`);
  }
  const confirmed: ConfirmedUtxo[] = [];
  let pendingSat = 0n;
  for (const u of data as Array<Record<string, unknown>>) {
    if (typeof u?.txid !== "string" || !TXID_PATTERN.test(u.txid)) {
      throw new Error(`Esplora GET ${template}: UTXO is missing a well-formed txid.`);
    }
    if (typeof u.vout !== "number" || !Number.isSafeInteger(u.vout) || u.vout < 0) {
      throw new Error(`Esplora GET ${template}: UTXO has a malformed vout.`);
    }
    const sat = satFromApi(u.value, "value", template);
    if ((u.status as Record<string, unknown> | undefined)?.confirmed === true) {
      confirmed.push({ txid: u.txid, vout: u.vout, sat });
    } else {
      pendingSat += sat;
    }
  }
  return { confirmed, pendingSat };
};

// GET /fee-estimates → { "1": satPerVb, "2": …, "6": … }. Take the target
// nearest FEE_TARGET_BLOCKS (ties go to the sooner = pricier side), ceil to
// an integer rate, floor at the 1 sat/vB relay minimum, refuse past the cap.
const feeRateSatVb = async (): Promise<bigint> => {
  const template = "/fee-estimates";
  const data = (await (await esploraGet("/fee-estimates", template)).json()) as Record<
    string,
    unknown
  >;
  const targets = Object.keys(data ?? {})
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort(
      (a, b) =>
        Math.abs(a - FEE_TARGET_BLOCKS) - Math.abs(b - FEE_TARGET_BLOCKS) || a - b
    );
  const chosen = targets[0];
  const raw = chosen === undefined ? undefined : data[String(chosen)];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Esplora GET ${template}: no usable fee target in the response.`);
  }
  const rate = BigInt(Math.max(1, Math.ceil(raw)));
  const cap = maxFeeRateSatVb();
  if (rate > cap) {
    throw new Error(
      `The indexer quotes ${rate} sat/vB — above the ${cap} sat/vB sanity ceiling (CASHLOOM_BTC_MAX_FEE_RATE). Refusing to quote.`
    );
  }
  return rate;
};

// Anti-fee-sniping: lock the tx to the current tip so a miner reorging the
// chain can't scoop it into an earlier block. Plain-text integer endpoint.
const tipHeight = async (): Promise<number> => {
  const template = "/blocks/tip/height";
  const text = (await (await esploraGet("/blocks/tip/height", template)).text()).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`Esplora GET ${template}: expected a plain-text integer block height.`);
  }
  return Number(text);
};

/* ------------------------------- validation ------------------------------- */

const AMOUNT_PATTERN = /^[1-9][0-9]*$/;

const parseInstruction = (instruction: PaymentInstruction) => {
  const asset = instruction.asset.trim().toUpperCase();
  if (asset !== "BTC") {
    throw new Error(`BTC sender moves BTC only; got "${instruction.asset}".`);
  }
  if (!AMOUNT_PATTERN.test(instruction.amountMinor)) {
    throw new Error(
      "amountMinor must be a positive integer satoshi string (no decimals, no zero)."
    );
  }
  const amount = BigInt(instruction.amountMinor);
  const to = instruction.to.trim();
  let decoded: NonNullable<ReturnType<ReturnType<typeof Address>["decode"]>>;
  try {
    const d = Address(NETWORK).decode(to);
    if (!d) throw new Error("undecodable");
    decoded = d;
  } catch {
    throw new Error(
      `"${to}" is not a valid mainnet Bitcoin address (bech32 bc1… or legacy base58).`
    );
  }
  const dust = DEST_DUST_SAT[decoded.type];
  if (dust === undefined) {
    throw new Error(`Sending to a "${decoded.type}" output is not supported.`);
  }
  if (amount < dust) {
    throw new Error(
      `${amount} sats is below the ${dust}-sat dust floor for this address type — the network would refuse to relay it.`
    );
  }
  return { to, amount, destScript: OutScript.encode(decoded) };
};

// scriptPubKey from one of OUR OWN addresses — always decodable (the vault
// wrote it), asserted anyway so a corrupt row fails loud, not undefined.
const scriptFor = (address: string): Uint8Array => {
  const decoded = Address(NETWORK).decode(address);
  if (!decoded) throw new Error("Could not decode the sending address from the vault.");
  return OutScript.encode(decoded);
};

const sameScript = (a: Uint8Array, b: Uint8Array): boolean => hex.encode(a) === hex.encode(b);

// Coins already committed to another live BTC payment are OFF the table:
// a fresh 'quoted' row may be signed any moment, and a 'confirmed' or
// 'broadcast' row's inputs can still show in the indexer's UTXO view
// (mempool lag) — and every tx here signals RBF, so re-selecting a committed
// coin would arm a replacement of our OWN earlier payment. Statuses are
// caller-chosen: quote() also reserves fresh quotes; send() checks only
// signed-or-broadcast rows, so two racing quotes fail loud at confirm
// instead of deadlocking each other.
const reservedOutpoints = async (
  statuses: string[],
  excludePaymentId?: string
): Promise<Set<string>> => {
  const { db } = await import("../db.ts");
  const rows = db
    .query(
      `SELECT id, status, created_at, detail FROM payments
       WHERE asset = 'BTC' AND detail IS NOT NULL AND status IN ('quoted','confirmed','broadcast')`
    )
    .all() as Array<{ id: string; status: string; created_at: string; detail: string }>;
  const reserved = new Set<string>();
  const now = Date.now();
  for (const row of rows) {
    if (row.id === excludePaymentId) continue;
    if (!statuses.includes(row.status)) continue;
    if (row.status === "quoted" && now - Date.parse(row.created_at) > QUOTE_TTL_MS) continue;
    try {
      const d = JSON.parse(row.detail) as { inputs?: Array<{ txid?: unknown; vout?: unknown }> };
      for (const i of d?.inputs ?? []) {
        if (typeof i?.txid === "string" && typeof i?.vout === "number") {
          reserved.add(`${i.txid}:${i.vout}`);
        }
      }
    } catch {
      // An unreadable detail reserves nothing — its payment can't sign either.
    }
  }
  return reserved;
};

// Address is derivable public data; stored on the vault row at creation.
// kind='btc' in the WHERE is the cross-rail guard: an evm key id arriving
// here reads as "no BTC key", never as a mis-derived address.
const senderAddress = async (ctx: SenderContext): Promise<string> => {
  const { db } = await import("../db.ts");
  const row = db
    .query("SELECT address FROM vault_keys WHERE id = ? AND kind = 'btc'")
    .get(ctx.vaultKeyId) as { address: string | null } | null;
  if (!row?.address) {
    throw new Error(
      `No BTC vault key ${ctx.vaultKeyId} — this account's key cannot sign Bitcoin.`
    );
  }
  return row.address;
};

/* --------------------------------- detail --------------------------------- */
// The persisted selection: everything send() needs to rebuild the EXACT
// transaction the fee was quoted for. Sat values ride as strings (JSON has
// no bigint). It holds only public chain data — txids, indexes, amounts —
// and MUST stay that way. At send it is UNTRUSTED input: a payments row is
// plaintext on disk, and on Bitcoin the fee is the IMPLICIT inputs−outputs
// difference, so a doctored detail would silently overpay miners. Every
// invariant is re-proven before anything is signed.

interface BtcDetail {
  v: 1;
  to: string;
  amountSat: string;
  inputs: Array<{ txid: string; vout: number; sat: string }>;
  changeSat: string;
  feeSat: string;
  feeRateSatVb: string;
  lockTime: number;
}

const REQUOTE = " Ask for a fresh quote.";

const parseDetail = (
  raw: string | null | undefined,
  expected: { to: string; amount: bigint }
): { inputs: Array<{ txid: string; vout: number; sat: bigint }>; changeSat: bigint; feeSat: bigint; lockTime: number } => {
  if (!raw) {
    throw new Error(`This payment has no stored coin selection to sign.${REQUOTE}`);
  }
  let d: BtcDetail;
  try {
    d = JSON.parse(raw) as BtcDetail;
  } catch {
    throw new Error(`This payment's stored coin selection is unreadable.${REQUOTE}`);
  }
  if (d?.v !== 1 || d.to !== expected.to || d.amountSat !== expected.amount.toString()) {
    throw new Error(`The stored coin selection does not match this payment.${REQUOTE}`);
  }
  if (!Array.isArray(d.inputs) || d.inputs.length < 1 || d.inputs.length > MAX_INPUTS) {
    throw new Error(`The stored coin selection is malformed (inputs).${REQUOTE}`);
  }
  const seenOutpoints = new Set<string>();
  const inputs = d.inputs.map((i) => {
    if (
      typeof i?.txid !== "string" ||
      !TXID_PATTERN.test(i.txid) ||
      typeof i.vout !== "number" ||
      !Number.isSafeInteger(i.vout) ||
      i.vout < 0 ||
      typeof i.sat !== "string" ||
      !AMOUNT_PATTERN.test(i.sat)
    ) {
      throw new Error(`The stored coin selection is malformed (input shape).${REQUOTE}`);
    }
    // A duplicated outpoint would double-count its value in the fee equation
    // below (the lib happily signs it; only the network would refuse) — the
    // one doctored-detail shape BIP-143 doesn't catch for us.
    const outpoint = `${i.txid}:${i.vout}`;
    if (seenOutpoints.has(outpoint)) {
      throw new Error(`The stored coin selection is malformed (duplicate input).${REQUOTE}`);
    }
    seenOutpoints.add(outpoint);
    return { txid: i.txid, vout: i.vout, sat: BigInt(i.sat) };
  });
  if (
    typeof d.changeSat !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(d.changeSat) ||
    typeof d.feeSat !== "string" ||
    !AMOUNT_PATTERN.test(d.feeSat) ||
    typeof d.lockTime !== "number" ||
    !Number.isSafeInteger(d.lockTime) ||
    d.lockTime < 0 ||
    d.lockTime >= 500_000_000 // must stay height-interpreted
  ) {
    throw new Error(`The stored coin selection is malformed (amounts).${REQUOTE}`);
  }
  const changeSat = BigInt(d.changeSat);
  const feeSat = BigInt(d.feeSat);
  const totalIn = inputs.reduce((s, i) => s + i.sat, 0n);
  // The fee is never a field of the signed tx — it IS this equation. Prove it
  // before signing, or a corrupted row overpays miners without bound.
  if (totalIn - expected.amount - changeSat !== feeSat) {
    throw new Error(`The stored coin selection's amounts do not reconcile.${REQUOTE}`);
  }
  if (changeSat !== 0n && changeSat < CHANGE_DUST_SAT) {
    throw new Error(`The stored coin selection carries dust change.${REQUOTE}`);
  }
  if (feeSat > maxFeeSat()) {
    throw new Error(
      `The stored fee (${feeSat} sats) exceeds the ${maxFeeSat()}-sat ceiling (CASHLOOM_BTC_MAX_FEE_SAT).${REQUOTE}`
    );
  }
  return { inputs, changeSat, feeSat, lockTime: d.lockTime };
};

/* -------------------------------- broadcast ------------------------------- */

const broadcast = async (rawTxHex: string, txid: string): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(`${esploraBaseUrl()}/tx`, {
      method: "POST",
      body: rawTxHex,
      headers: { "Content-Type": "text/plain" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The network ate the answer; the tx MAY be relaying. A clean "failed"
    // here would invite an immediate second send — the double-pay lever.
    throw new AmbiguousBroadcastError(
      `Broadcast outcome unknown (no HTTP response). Check txid ${txid} on-chain before quoting again — this payment may have gone through.`,
      txid
    );
  }
  if (response.ok) return;
  const body = (await response.text().catch(() => "")).slice(0, 200);
  if (response.status >= 400 && response.status < 500) {
    // A duplicate-specific response proves that this exact raw transaction is
    // already known and is therefore an idempotent success. Every other 4xx
    // remains ambiguous once bytes have been signed: "missing or spent" can
    // be the losing response to a retry after the first request was accepted.
    if (
      /already.{0,12}(known|in.{0,3}(mempool|block.?chain))|txn-already-(known|in-mempool)|transaction already exists|code["']?\s*:\s*-27/i.test(
        body,
      )
    ) {
      return;
    }
    throw new AmbiguousBroadcastError(
      `Broadcast outcome unknown (HTTP ${response.status}: ${body || "transaction rejected"}). Check txid ${txid} on-chain before any replacement — this exact transaction may already be live.`,
      txid,
    );
  }
  throw new AmbiguousBroadcastError(
    `Broadcast outcome unknown (HTTP ${response.status}). Check txid ${txid} on-chain before quoting again — this payment may have gone through.`,
    txid
  );
};

/* --------------------------------- helpers -------------------------------- */

const SATS_PER_BTC = 100_000_000n;

const formatBtc = (sat: bigint): string => {
  const whole = sat / SATS_PER_BTC;
  const frac = (sat % SATS_PER_BTC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
};

const preparedTransaction = (
  fromAddress: string,
  to: string,
  amount: bigint,
  inputs: readonly { txid: string; vout: number; sat: bigint }[],
  changeSat: bigint,
  feeSat: bigint,
  lockTime: number,
): PreparedBitcoinTransaction => ({
  kind: "cashloom.bitcoin-transaction/1",
  network: "bitcoin-mainnet",
  fromAddress,
  inputs: inputs.map((input) => ({
    txid: input.txid,
    vout: input.vout,
    amountSat: input.sat.toString(),
    sequence: RBF_SEQUENCE,
  })),
  outputs: [
    { address: to, amountSat: amount.toString() },
    ...(changeSat > 0n ? [{ address: fromAddress, amountSat: changeSat.toString() }] : []),
  ],
  lockTime,
  expectedFeeSat: feeSat.toString(),
});

/* --------------------------------- sender --------------------------------- */

export const btcSender: PaymentSender = {
  type: "btc",
  assets: ["BTC"],

  async quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote> {
    const { to, amount, destScript } = parseInstruction(instruction);
    const self = await senderAddress(ctx);
    // The witness script is derived LOCALLY from our own address, never taken
    // from the indexer — this is what makes the BIP-143 argument airtight.
    const selfScript = scriptFor(self);
    // Script equality, not string equality: bech32 is case-insensitive
    // (BIP-173 QR codes are ALL-UPPERCASE), so comparing address strings
    // would let an uppercase rendering of our own address slip through.
    if (sameScript(destScript, selfScript)) {
      throw new Error(
        "That is this account's own address — a self-pay would only burn the fee."
      );
    }

    const [{ confirmed, pendingSat }, rate, tip, reserved] = await Promise.all([
      fetchUtxos(self),
      feeRateSatVb(),
      tipHeight(),
      reservedOutpoints(["quoted", "confirmed", "broadcast"]),
    ]);

    // An input that cannot pay for its own inclusion only grows the deficit —
    // excluding them up front also stops an address dusted with hundreds of
    // 100-sat outputs from inflating the fee toward the input cap.
    const inputCostSat = INPUT_VSIZE_CEIL * rate;
    const economical = confirmed.filter((u) => u.sat > inputCostSat);
    // Coins committed to another live payment sit out this selection.
    const free = economical.filter((u) => !reserved.has(`${u.txid}:${u.vout}`));
    const reservedSat = economical.reduce((s, u) => s + u.sat, 0n) - free.reduce((s, u) => s + u.sat, 0n);
    const spendableSat = free.reduce((s, u) => s + u.sat, 0n);

    const candidates = free.map((u) => ({
      txid: hex.decode(u.txid),
      index: u.vout,
      witnessUtxo: { script: selfScript, amount: u.sat },
      sequence: RBF_SEQUENCE,
    }));

    // The estimator sizes REAL scripts (a taproot destination costs more
    // than a bech32 v0 one), finds changeless near-sweep shapes, and folds
    // sub-dust change into the fee — the returned fee is the post-fold,
    // exact number, verified empirically against all three cases.
    const selection = selectUTXO(candidates, [{ address: to, amount }], "default", {
      feePerByte: rate,
      changeAddress: self,
      network: NETWORK,
      // dust is a VBYTE count the lib multiplies by dustRelayFeeRate; pinning
      // the rate to 1 makes CHANGE_DUST_SAT mean satoshis, as documented.
      dust: CHANGE_DUST_SAT,
      dustRelayFeeRate: 1n,
      createTx: false,
    });

    if (!selection || typeof selection.fee !== "bigint") {
      const destOutVsize = 8n + 1n + BigInt(destScript.length);
      const sweepFee =
        rate *
        (OVERHEAD_VSIZE_CEIL + INPUT_VSIZE_CEIL * BigInt(free.length) + destOutVsize);
      const maxSendable = spendableSat > sweepFee ? spendableSat - sweepFee : 0n;
      throw new Error(
        `Insufficient confirmed funds: ${amount} sats plus the network fee exceeds the ${spendableSat} sats spendable right now.` +
          (reservedSat > 0n
            ? ` ${reservedSat} sats are held by payments still in flight — confirm, fail, or let them expire first.`
            : "") +
          (pendingSat > 0n
            ? ` ${pendingSat} more sats await confirmation (typically 10–60 min) — re-quote then.`
            : "") +
          ` Max sendable now ≈ ${maxSendable} sats.`
      );
    }
    if (selection.inputs.length > MAX_INPUTS) {
      throw new Error(
        `This payment would need ${selection.inputs.length} coins; the cap is ${MAX_INPUTS} per transaction. Send a smaller amount.`
      );
    }

    const picked = selection.inputs.map((i) => ({
      txid: hex.encode(i.txid as Uint8Array),
      vout: i.index as number,
      sat: (i.witnessUtxo as { amount: bigint }).amount,
    }));
    const totalIn = picked.reduce((s, i) => s + i.sat, 0n);
    const feeSat = selection.fee;
    const changeSat = totalIn - amount - feeSat;
    if (changeSat < 0n || (changeSat !== 0n && changeSat < CHANGE_DUST_SAT)) {
      throw new Error("Coin selection produced inconsistent change — refusing to quote.");
    }
    if (feeSat > maxFeeSat()) {
      throw new Error(
        `The network fee (${feeSat} sats) exceeds the ${maxFeeSat()}-sat ceiling (CASHLOOM_BTC_MAX_FEE_SAT). Refusing to quote.`
      );
    }

    const detail: BtcDetail = {
      v: 1,
      to,
      amountSat: amount.toString(),
      inputs: picked.map((i) => ({ txid: i.txid, vout: i.vout, sat: i.sat.toString() })),
      changeSat: changeSat.toString(),
      feeSat: feeSat.toString(),
      feeRateSatVb: rate.toString(),
      lockTime: tip,
    };

    const inputWord = picked.length === 1 ? "input" : "inputs";
    return {
      feeMinor: feeSat.toString(),
      feeAsset: "BTC",
      summary:
        `Send ${formatBtc(amount)} BTC to ${to} — network fee exactly ${feeSat} sats ` +
        `(${rate} sat/vB, ${picked.length} ${inputWord}` +
        `${changeSat === 0n ? ", sub-dust change folded into the fee" : ""}). ` +
        `The fee is locked: a busier network can slow confirmation, never raise it. ` +
        `No CashLoom fee, ever.`,
      detail: JSON.stringify(detail),
    };
  },

  async signingRequestHash(ctx: SenderContext, instruction: PaymentInstruction) {
    const { to, amount } = parseInstruction(instruction);
    const self = await senderAddress(ctx);
    const { inputs, changeSat, feeSat, lockTime } = parseDetail(instruction.detail, {
      to,
      amount,
    });
    return hashPreparedBitcoinTransaction(
      preparedTransaction(self, to, amount, inputs, changeSat, feeSat, lockTime),
    );
  },

  async reservationClaims(ctx: SenderContext, instruction: PaymentInstruction) {
    const { to, amount } = parseInstruction(instruction);
    await senderAddress(ctx); // key-kind guard belongs at the quote boundary
    const { inputs } = parseDetail(instruction.detail, { to, amount });
    return inputs.map((input) => ({
      kind: "UTXO" as const,
      resourceKey: `bip122:000000000019d6689c085ae165831e93:${input.txid}:${input.vout}`,
      amountAtomic: input.sat.toString(),
    }));
  },

  async send(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    hooks?: SendHooks
  ): Promise<PaymentReceipt> {
    if (!ctx.signingBinding) {
      throw new Error("Bitcoin signing requires a bound payment authorization.");
    }
    const { to, amount } = parseInstruction(instruction);
    const self = await senderAddress(ctx);
    const { inputs, changeSat, feeSat, lockTime } = parseDetail(instruction.detail, {
      to,
      amount,
    });

    // Two quotes taken in the same instant can select the same coins (the
    // reservation at quote time can't see a selection that hasn't been
    // persisted yet). Every tx here signals RBF, so signing the loser would
    // arm a replacement of our OWN earlier payment — check against every
    // already-signed row and fail loud into a fresh quote instead.
    const committed = await reservedOutpoints(["confirmed", "broadcast"], ctx.paymentId);
    for (const input of inputs) {
      if (committed.has(`${input.txid}:${input.vout}`)) {
        throw new Error(
          `A coin in this quote was already committed to another payment.${REQUOTE}`
        );
      }
    }

    // Rebuild EXACTLY what was quoted as inert data. The vault constructs the
    // transaction internally; no caller-owned object ever receives a scalar.
    const signed = await signBitcoinTransaction(
      ctx.vaultKeyId,
      preparedTransaction(self, to, amount, inputs, changeSat, feeSat, lockTime),
      ctx.signingBinding,
    );

    // Segwit txids exclude witness data, so the id is final here — persist it
    // BEFORE the network hears the tx (see SendHooks.onSigned).
    const txid = signed.txid;
    hooks?.onSigned?.(txid, { encoding: "hex", payload: `0x${signed.hex}` });
    await broadcast(signed.hex, txid);
    return {
      externalId: txid,
      status: "broadcast",
      // On Bitcoin the fee leaves the same pocket as the amount, and it is
      // exact at signing — record the true outflow so the ledger row matches
      // what the read rail would later derive for this txid.
      totalOutMinor: (amount + feeSat).toString(),
    };
  },

  async resumeBroadcast(
    ctx: SenderContext,
    instruction: PaymentInstruction,
    envelope: SignedTransactionEnvelope,
    expectedExternalId: string,
  ): Promise<PaymentReceipt> {
    if (envelope.encoding !== "hex" || !/^0x[0-9a-f]+$/.test(envelope.payload) || envelope.payload.length % 2 !== 0) {
      throw new Error("Stored Bitcoin signed envelope is malformed.");
    }
    const rawHex = envelope.payload.slice(2);
    const { to, amount } = parseInstruction(instruction);
    const self = await senderAddress(ctx);
    const { inputs, changeSat, feeSat, lockTime } = parseDetail(instruction.detail, {
      to,
      amount,
    });
    const expected = preparedTransaction(self, to, amount, inputs, changeSat, feeSat, lockTime);
    verifySignedBitcoinTransaction(expected, rawHex, expectedExternalId);
    await broadcast(rawHex, expectedExternalId);
    return { externalId: expectedExternalId, status: "broadcast" };
  },
};
