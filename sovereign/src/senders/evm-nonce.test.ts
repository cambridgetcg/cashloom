import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, keccak256 } from "viem";

const dataDir = mkdtempSync(join(tmpdir(), "cashloom-evm-nonce-test-"));
process.env.CASHLOOM_DATA_DIR = dataDir;

const { db, newId } = await import("../db.ts");
const {
  getEvmNonceReservation,
  markEvmNonceSigned,
  markEvmNonceSubmitting,
  markEvmNonceSubmissionUnknown,
  releaseEvmNoncePreSubmit,
  reserveEvmNonce,
} = await import("./evm-nonce.ts");

const CHAIN = 8453;
const UNSIGNED_PAYLOAD = new Uint8Array([1, 2, 3]);
const SIGNED_PAYLOAD = new Uint8Array([4, 5, 6]);
const HASH = keccak256(bytesToHex(SIGNED_PAYLOAD));
const sha256Id = (payload: Uint8Array): string =>
  `sha256:${Buffer.from(sha256(payload)).toString("hex")}`;
const payloadEvidence = {
  unsignedPayload: UNSIGNED_PAYLOAD,
  unsignedPayloadSha256: sha256Id(UNSIGNED_PAYLOAD),
  signedPayload: SIGNED_PAYLOAD,
  signedPayloadSha256: sha256Id(SIGNED_PAYLOAD),
};
const workerPath = join(import.meta.dir, "evm-nonce.worker.ts");

const makePayment = (
  options: { rail?: string; status?: string } = {},
): string => {
  const accountId = newId();
  const paymentId = newId();
  db.query(
    `INSERT INTO accounts
       (id, rail, display_name, currency, decimals, vault_key_id)
     VALUES (?, 'CRYPTO', 'nonce test', 'ETH', 18, ?)`,
  ).run(accountId, newId());
  db.query(
    `INSERT INTO payments
       (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status)
     VALUES (?, ?, ?, ?, 'ETH', '1', '1', ?)`,
  ).run(
    paymentId,
    accountId,
    options.rail ?? "evm-base",
    `0x${"f".repeat(40)}`,
    options.status ?? "confirmed",
  );
  return paymentId;
};

const runWorker = async (
  paymentId: string,
  pendingNonce: number,
  fromAddress: string,
): Promise<number> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      workerPath,
      paymentId,
      String(pendingNonce),
      fromAddress,
      String(CHAIN),
    ],
    env: { ...process.env, CASHLOOM_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Nonce worker failed (${exitCode}): ${stderr}`);
  }
  return (JSON.parse(stdout) as { nonce: number }).nonce;
};

describe("durable EVM nonce reservations", () => {
  it("coordinates distinct payments across processes and survives worker restarts", async () => {
    const from = `0x${"1".repeat(40)}`;
    const first = makePayment();
    const second = makePayment();

    const allocated = await Promise.all([
      runWorker(first, 17, from),
      runWorker(second, 17, from),
    ]);
    expect(allocated.sort((left, right) => left - right)).toEqual([17, 18]);

    const afterRestart = makePayment();
    expect(await runWorker(afterRestart, 17, from)).toBe(19);
  });

  it("reuses only a nonce explicitly released before raw submission", () => {
    const from = `0x${"2".repeat(40)}`;
    const first = makePayment();
    const second = makePayment();
    const third = makePayment();

    expect(
      reserveEvmNonce({
        paymentId: first,
        chainId: CHAIN,
        fromAddress: from,
        pendingNonce: 17,
      }),
    ).toBe(17);
    expect(
      reserveEvmNonce({
        paymentId: second,
        chainId: CHAIN,
        fromAddress: from,
        pendingNonce: 17,
      }),
    ).toBe(18);

    releaseEvmNoncePreSubmit({
      paymentId: first,
      chainId: CHAIN,
      fromAddress: from,
      nonce: 17,
    });
    expect(getEvmNonceReservation(first)?.state).toBe("released_pre_submit");
    expect(
      reserveEvmNonce({
        paymentId: third,
        chainId: CHAIN,
        fromAddress: from,
        pendingNonce: 17,
      }),
    ).toBe(17);
  });

  it("keeps signed, submitting, and unknown nonces live without a TTL", () => {
    const from = `0x${"3".repeat(40)}`;
    const first = makePayment();
    const second = makePayment();
    const third = makePayment();

    const nonce = reserveEvmNonce({
      paymentId: first,
      chainId: CHAIN,
      fromAddress: from,
      pendingNonce: 40,
    });
    markEvmNonceSigned({
      paymentId: first,
      chainId: CHAIN,
      fromAddress: from,
      nonce,
      txHash: HASH,
      ...payloadEvidence,
    });
    const signed = db
      .query(
        `SELECT unsigned_payload_sha256, signed_payload_sha256, tx_hash
         FROM evm_signed_transactions WHERE payment_id = ?`,
      )
      .get(first) as {
        unsigned_payload_sha256: string;
        signed_payload_sha256: string;
        tx_hash: string;
      };
    expect(signed).toEqual({
      unsigned_payload_sha256: payloadEvidence.unsignedPayloadSha256,
      signed_payload_sha256: payloadEvidence.signedPayloadSha256,
      tx_hash: HASH,
    });
    expect(
      (
        db.query("SELECT tx_hash FROM payments WHERE id = ?").get(first) as {
          tx_hash: string;
        }
      ).tx_hash,
    ).toBe(HASH);
    expect(
      reserveEvmNonce({
        paymentId: second,
        chainId: CHAIN,
        fromAddress: from,
        pendingNonce: 40,
      }),
    ).toBe(41);

    markEvmNonceSubmitting({
      paymentId: first,
      chainId: CHAIN,
      fromAddress: from,
      nonce,
      txHash: HASH,
    });
    markEvmNonceSubmissionUnknown({
      paymentId: first,
      chainId: CHAIN,
      fromAddress: from,
      nonce,
      txHash: HASH,
    });
    expect(getEvmNonceReservation(first)?.state).toBe("submission_unknown");
    expect(() =>
      releaseEvmNoncePreSubmit({
        paymentId: first,
        chainId: CHAIN,
        fromAddress: from,
        nonce,
      }),
    ).toThrow(/expected "reserved"/);
    expect(
      reserveEvmNonce({
        paymentId: third,
        chainId: CHAIN,
        fromAddress: from,
        pendingNonce: 40,
      }),
    ).toBe(42);
  });

  it("scopes the same numeric nonce independently by chain and sender", () => {
    const fromA = `0x${"4".repeat(40)}`;
    const fromB = `0x${"5".repeat(40)}`;
    const a = makePayment();
    const b = makePayment();
    const c = makePayment();

    expect(
      reserveEvmNonce({
        paymentId: a,
        chainId: CHAIN,
        fromAddress: fromA,
        pendingNonce: 7,
      }),
    ).toBe(7);
    expect(
      reserveEvmNonce({
        paymentId: b,
        chainId: 1,
        fromAddress: fromA,
        pendingNonce: 7,
      }),
    ).toBe(7);
    expect(
      reserveEvmNonce({
        paymentId: c,
        chainId: CHAIN,
        fromAddress: fromB,
        pendingNonce: 7,
      }),
    ).toBe(7);
  });

  it("refuses invalid payment state and illegal lifecycle transitions", () => {
    const from = `0x${"6".repeat(40)}`;
    const quoted = makePayment({ status: "quoted" });
    const wrongRail = makePayment({ rail: "btc-mainnet" });
    for (const paymentId of [quoted, wrongRail]) {
      expect(() =>
        reserveEvmNonce({
          paymentId,
          chainId: CHAIN,
          fromAddress: from,
          pendingNonce: 1,
        }),
      ).toThrow(/confirmed evm-base/);
    }

    const paymentId = makePayment();
    const nonce = reserveEvmNonce({
      paymentId,
      chainId: CHAIN,
      fromAddress: from,
      pendingNonce: 1,
    });
    expect(() =>
      markEvmNonceSubmitting({
        paymentId,
        chainId: CHAIN,
        fromAddress: from,
        nonce,
        txHash: HASH,
      }),
    ).toThrow(/expected "signed"/);
    expect(() =>
      markEvmNonceSigned({
        paymentId,
        chainId: CHAIN,
        fromAddress: from,
        nonce: nonce + 1,
        txHash: HASH,
        ...payloadEvidence,
      }),
    ).toThrow(/expected "reserved"/);
  });

  it("rolls back nonce, payment hash, and signed evidence together on invalid bytes", () => {
    const from = `0x${"7".repeat(40)}`;
    const paymentId = makePayment();
    const nonce = reserveEvmNonce({
      paymentId,
      chainId: CHAIN,
      fromAddress: from,
      pendingNonce: 9,
    });

    expect(() =>
      markEvmNonceSigned({
        paymentId,
        chainId: CHAIN,
        fromAddress: from,
        nonce,
        txHash: HASH,
        ...payloadEvidence,
        signedPayloadSha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow(/does not match/);
    expect(getEvmNonceReservation(paymentId)?.state).toBe("reserved");
    expect(
      (
        db.query("SELECT tx_hash FROM payments WHERE id = ?").get(paymentId) as {
          tx_hash: string | null;
        }
      ).tx_hash,
    ).toBeNull();
    expect(
      (
        db.query(
          "SELECT COUNT(*) AS count FROM evm_signed_transactions WHERE payment_id = ?",
        ).get(paymentId) as { count: number }
      ).count,
    ).toBe(0);
  });
});
