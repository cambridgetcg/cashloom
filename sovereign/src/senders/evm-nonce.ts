/**
 * Durable EVM nonce coordination for one sovereign node.
 *
 * The RPC's pending nonce is only a lower bound. Distinct CashLoom processes
 * sharing the same SQLite file serialize here, reserve the lowest locally free
 * nonce at or above that bound, and commit before any signing work begins.
 *
 * There is intentionally no TTL. A signed/submitting/unknown reservation is
 * sticky until explicit reconciliation exists; time passing cannot prove that
 * a transaction was never sent.
 */

import { db } from "../db.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, keccak256 } from "viem";

export type EvmNonceState =
  | "reserved"
  | "signed"
  | "submitting"
  | "submitted"
  | "submission_unknown"
  | "released_pre_submit";

export interface EvmNonceReservation {
  payment_id: string;
  chain_id: number;
  from_address: string;
  nonce: number;
  state: EvmNonceState;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface ReservationIdentity {
  paymentId: string;
  chainId: number;
  fromAddress: string;
  nonce: number;
}

interface SignedReservation extends ReservationIdentity {
  txHash: string;
}

export interface EvmSignedTransactionEvidence extends SignedReservation {
  unsignedPayload: Uint8Array;
  unsignedPayloadSha256: string;
  signedPayload: Uint8Array;
  signedPayloadSha256: string;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const normalizedAddress = (address: string): string => {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error("Cannot reserve a nonce for an invalid EVM sender address.");
  }
  return address.toLowerCase();
};

const safeNonce = (nonce: number, label: string): number => {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return nonce;
};

const safeChainId = (chainId: number): number => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("EVM chain id must be a positive safe integer.");
  }
  return chainId;
};

const safeHash = (hash: string): string => {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("EVM nonce state requires a canonical transaction hash.");
  }
  return hash.toLowerCase();
};

const safePayload = (payload: Uint8Array, label: string): Uint8Array => {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > 131_072) {
    throw new Error(`${label} must contain bounded transaction bytes.`);
  }
  return Uint8Array.prototype.slice.call(payload);
};

const sha256Id = (payload: Uint8Array): string =>
  `sha256:${Buffer.from(sha256(payload)).toString("hex")}`;

const safeSha256 = (value: string, payload: Uint8Array, label: string): string => {
  if (!SHA256_PATTERN.test(value) || value !== sha256Id(payload)) {
    throw new Error(`${label} does not match its transaction bytes.`);
  }
  return value;
};

const currentState = (paymentId: string): string => {
  const row = db
    .query("SELECT state FROM evm_nonce_reservations WHERE payment_id = ?")
    .get(paymentId) as { state: string } | null;
  return row?.state ?? "missing";
};

const transitionRefused = (
  paymentId: string,
  expected: string,
  next: EvmNonceState,
): Error =>
  new Error(
    `EVM nonce reservation for payment ${paymentId} is "${currentState(paymentId)}"; `
      + `expected ${expected} before "${next}".`,
  );

export const reserveEvmNonce = (input: {
  paymentId: string;
  chainId: number;
  fromAddress: string;
  pendingNonce: number;
}): number => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const pendingNonce = safeNonce(input.pendingNonce, "RPC pending nonce");
  if (!input.paymentId) {
    throw new Error("An EVM nonce reservation requires a payment id.");
  }

  const reserve = db.transaction(() => {
    const payment = db
      .query("SELECT rail, status FROM payments WHERE id = ?")
      .get(input.paymentId) as { rail: string; status: string } | null;
    if (!payment) {
      throw new Error(`No payment ${input.paymentId} exists for EVM nonce reservation.`);
    }
    if (payment.rail !== "evm-base" || payment.status !== "confirmed") {
      throw new Error(
        `Payment ${input.paymentId} must be a confirmed evm-base payment before nonce reservation.`,
      );
    }

    const existing = db
      .query("SELECT state FROM evm_nonce_reservations WHERE payment_id = ?")
      .get(input.paymentId) as { state: string } | null;
    if (existing) {
      throw new Error(
        `Payment ${input.paymentId} already has an EVM nonce reservation (${existing.state}).`,
      );
    }

    const live = db
      .query(
        `SELECT nonce
         FROM evm_nonce_reservations
         WHERE chain_id = ?
           AND from_address = ?
           AND state != 'released_pre_submit'
           AND nonce >= ?
         ORDER BY nonce`,
      )
      .all(chainId, fromAddress, pendingNonce) as Array<{ nonce: number }>;

    let nonce = pendingNonce;
    for (const row of live) {
      const held = safeNonce(row.nonce, "Stored EVM nonce");
      if (held === nonce) {
        if (nonce === Number.MAX_SAFE_INTEGER) {
          throw new Error("No safe JavaScript integer remains for EVM nonce reservation.");
        }
        nonce += 1;
      } else if (held > nonce) {
        break;
      }
    }

    const now = new Date().toISOString();
    db.query(
      `INSERT INTO evm_nonce_reservations
         (payment_id, chain_id, from_address, nonce, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'reserved', ?, ?)`,
    ).run(input.paymentId, chainId, fromAddress, nonce, now, now);
    return nonce;
  });

  return reserve.immediate();
};

export const markEvmNonceSigned = (input: EvmSignedTransactionEvidence): void => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const nonce = safeNonce(input.nonce, "Reserved EVM nonce");
  const txHash = safeHash(input.txHash);
  const unsignedPayload = safePayload(input.unsignedPayload, "Unsigned EVM payload");
  const signedPayload = safePayload(input.signedPayload, "Signed EVM payload");
  const unsignedPayloadSha256 = safeSha256(
    input.unsignedPayloadSha256,
    unsignedPayload,
    "Unsigned EVM payload SHA-256",
  );
  const signedPayloadSha256 = safeSha256(
    input.signedPayloadSha256,
    signedPayload,
    "Signed EVM payload SHA-256",
  );
  if (keccak256(bytesToHex(signedPayload)) !== txHash) {
    throw new Error("Signed EVM payload does not match its transaction hash.");
  }

  const persist = db.transaction(() => {
    const now = new Date().toISOString();
    const changed = db
      .query(
        `UPDATE evm_nonce_reservations
         SET state = 'signed', tx_hash = ?, updated_at = ?
         WHERE payment_id = ? AND chain_id = ? AND from_address = ?
           AND nonce = ? AND state = 'reserved' AND tx_hash IS NULL`,
      )
      .run(
        txHash,
        now,
        input.paymentId,
        chainId,
        fromAddress,
        nonce,
      );
    if (changed.changes !== 1) {
      throw transitionRefused(input.paymentId, '"reserved"', "signed");
    }

    db.query(
      `INSERT INTO evm_signed_transactions
         (payment_id, chain_id, from_address, nonce, unsigned_payload,
          unsigned_payload_sha256, signed_payload, signed_payload_sha256,
          tx_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.paymentId,
      chainId,
      fromAddress,
      nonce,
      unsignedPayload,
      unsignedPayloadSha256,
      signedPayload,
      signedPayloadSha256,
      txHash,
      now,
    );

    const payment = db
      .query(
        `UPDATE payments
         SET tx_hash = ?, updated_at = ?
         WHERE id = ? AND status = 'confirmed'`,
      )
      .run(txHash, now, input.paymentId);
    if (payment.changes !== 1) {
      throw new Error(
        `Payment ${input.paymentId} is no longer confirmed; refusing signed EVM persistence.`,
      );
    }
  });
  persist.immediate();
};

export const markEvmNonceSubmitting = (input: SignedReservation): void => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const nonce = safeNonce(input.nonce, "Reserved EVM nonce");
  const txHash = safeHash(input.txHash);
  const changed = db
    .query(
      `UPDATE evm_nonce_reservations
       SET state = 'submitting', updated_at = ?
       WHERE payment_id = ? AND chain_id = ? AND from_address = ?
         AND nonce = ? AND state = 'signed' AND tx_hash = ?`,
    )
    .run(
      new Date().toISOString(),
      input.paymentId,
      chainId,
      fromAddress,
      nonce,
      txHash,
    );
  if (changed.changes !== 1) {
    throw transitionRefused(input.paymentId, '"signed"', "submitting");
  }
};

export const markEvmNonceSubmitted = (input: SignedReservation): void => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const nonce = safeNonce(input.nonce, "Reserved EVM nonce");
  const txHash = safeHash(input.txHash);
  const changed = db
    .query(
      `UPDATE evm_nonce_reservations
       SET state = 'submitted', updated_at = ?
       WHERE payment_id = ? AND chain_id = ? AND from_address = ?
         AND nonce = ? AND state = 'submitting' AND tx_hash = ?`,
    )
    .run(
      new Date().toISOString(),
      input.paymentId,
      chainId,
      fromAddress,
      nonce,
      txHash,
    );
  if (changed.changes !== 1) {
    throw transitionRefused(input.paymentId, '"submitting"', "submitted");
  }
};

export const markEvmNonceSubmissionUnknown = (input: SignedReservation): void => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const nonce = safeNonce(input.nonce, "Reserved EVM nonce");
  const txHash = safeHash(input.txHash);
  const changed = db
    .query(
      `UPDATE evm_nonce_reservations
       SET state = 'submission_unknown', updated_at = ?
       WHERE payment_id = ? AND chain_id = ? AND from_address = ?
         AND nonce = ? AND state = 'submitting' AND tx_hash = ?`,
    )
    .run(
      new Date().toISOString(),
      input.paymentId,
      chainId,
      fromAddress,
      nonce,
      txHash,
    );
  if (changed.changes !== 1) {
    throw transitionRefused(input.paymentId, '"submitting"', "submission_unknown");
  }
};

export const releaseEvmNoncePreSubmit = (input: ReservationIdentity): void => {
  const chainId = safeChainId(input.chainId);
  const fromAddress = normalizedAddress(input.fromAddress);
  const nonce = safeNonce(input.nonce, "Reserved EVM nonce");
  const changed = db
    .query(
      `UPDATE evm_nonce_reservations
       SET state = 'released_pre_submit', updated_at = ?
       WHERE payment_id = ? AND chain_id = ? AND from_address = ?
         AND nonce = ? AND state = 'reserved'`,
    )
    .run(
      new Date().toISOString(),
      input.paymentId,
      chainId,
      fromAddress,
      nonce,
    );
  if (changed.changes !== 1) {
    throw transitionRefused(
      input.paymentId,
      '"reserved"',
      "released_pre_submit",
    );
  }
};

export const getEvmNonceReservation = (
  paymentId: string,
): EvmNonceReservation | null =>
  db
    .query("SELECT * FROM evm_nonce_reservations WHERE payment_id = ?")
    .get(paymentId) as EvmNonceReservation | null;
