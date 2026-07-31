import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentSender } from "./senders/types.ts";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-pay-test-"));

const { db, newId } = await import("./db.ts");
const { quotePayment, confirmPayment } = await import("./pay.ts");
const { evmSender } = await import("./senders/evm.sender.ts");
const { sha256BytesId } = await import("@agenttool/wallet");

const makeAccount = (vaultKeyId: string | null): string => {
  const id = newId();
  db.query(
    `INSERT INTO accounts (id, rail, display_name, currency, decimals, vault_key_id)
     VALUES (?, 'CRYPTO', 'wallet', 'USDC', 6, ?)`
  ).run(id, vaultKeyId);
  return id;
};

const idFor = (label: string): `sha256:${string}` =>
  sha256BytesId(new TextEncoder().encode(`${label}:${newId()}`));

const insertBoundQuote = () => {
  const accountId = makeAccount(newId());
  const paymentId = newId();
  const now = new Date().toISOString();
  const quoteExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.query(
    `INSERT INTO payments
       (id, account_id, rail, to_addr, asset, amount_minor, fee_minor,
        status, detail, created_at)
     VALUES (?, ?, 'btc', 'btc-test-destination', 'BTC', '7', '1',
             'quoted', '{}', ?)`,
  ).run(paymentId, accountId, now);

  const intentRecordId = idFor("intent");
  const issuerKeyId = idFor("issuer");
  db.query(
    `INSERT INTO cashloom_v2_records
       (record_id, schema, kind, issuer_key_id, audience, nonce,
        disclosure, canonical_json, created_at, expires_at, source, received_at)
     VALUES (?, 'kingdom.cashloom.payment-intent/v2', 'PaymentIntent', ?,
             'local-test', ?, 'private', ?, ?, ?, 'local', ?)`,
  ).run(
    intentRecordId,
    issuerKeyId,
    newId(),
    JSON.stringify({ intentRecordId }),
    now,
    quoteExpiresAt,
    now,
  );

  const reviewId = idFor("review");
  const reservationId = idFor("reservation");
  const unsignedPayload = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01]);
  const unsignedPayloadHash = sha256BytesId(unsignedPayload);
  db.query(
    `INSERT INTO cashloom_v2_btc_payment_bindings
       (intent_record_id, payment_id, account_id, review_id, reservation_id,
        unsigned_payload, unsigned_payload_hash, quote_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    intentRecordId,
    paymentId,
    accountId,
    reviewId,
    reservationId,
    unsignedPayload,
    unsignedPayloadHash,
    quoteExpiresAt,
    now,
  );
  return {
    accountId,
    paymentId,
    intentRecordId,
    reviewId,
    reservationId,
    unsignedPayload,
    unsignedPayloadHash,
  };
};

describe("pay — quote/confirm discipline", () => {
  it("refuses to quote from an account with no local key", async () => {
    const id = makeAccount(null);
    await expect(
      quotePayment({ accountId: id, to: "0x" + "1".repeat(40), amountMinor: "1", asset: "USDC" })
    ).rejects.toThrow(/no local signing key/);
  });

  it("refuses an asset no sender can move", async () => {
    const id = makeAccount(newId());
    await expect(
      quotePayment({ accountId: id, to: "0x" + "1".repeat(40), amountMinor: "1", asset: "DOGE" })
    ).rejects.toThrow(/No sender for asset "DOGE"/);
  });

  it("rolls the payment insert back when its synchronous binding fails", async () => {
    const accountId = makeAccount(newId());
    const payload = new Uint8Array([1, 2, 3, 4]);
    const payloadHash = sha256BytesId(payload);
    const sender: PaymentSender = {
      type: "test",
      assets: ["TEST"],
      async quote() {
        return {
          feeMinor: "2",
          feeAsset: "TEST",
          summary: "bound test quote",
          detail: "opaque-detail",
          unsignedPayload: payload,
          unsignedPayloadHash: payloadHash,
        };
      },
      async send() {
        throw new Error("not used");
      },
    };
    let insertedPaymentId: string | null = null;
    await expect(
      quotePayment(
        {
          accountId,
          to: "test-destination",
          amountMinor: "7",
          asset: "TEST",
        },
        {
          senders: [sender],
          now: () => "2026-07-31T12:00:00.000Z",
          bind: (draft) => {
            insertedPaymentId = draft.paymentId;
            expect(draft.accountId).toBe(accountId);
            expect(draft.senderType).toBe("test");
            expect(draft.detail).toBe("opaque-detail");
            expect(draft.unsignedPayloadHash).toBe(payloadHash);
            expect(Array.from(draft.unsignedPayload!)).toEqual(Array.from(payload));
            expect(draft.createdAt).toBe("2026-07-31T12:00:00.000Z");
            expect(draft.expiresAt).toBe("2026-07-31T12:05:00.000Z");
            throw new Error("binding refused");
          },
        },
      ),
    ).rejects.toThrow(/binding refused/);
    expect(insertedPaymentId).not.toBeNull();
    expect(
      db.query("SELECT id FROM payments WHERE id = ?").get(insertedPaymentId!),
    ).toBeNull();
  });

  it("refuses to confirm a payment that does not exist", async () => {
    await expect(confirmPayment(newId())).rejects.toThrow(/No payment/);
  });

  it("refuses to confirm anything but a fresh quote, and expires stale ones terminally", async () => {
    const accountId = makeAccount(newId());
    const paymentId = newId();
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO payments (id, account_id, rail, to_addr, asset, amount_minor, status, created_at)
       VALUES (?, ?, 'evm-base', ?, 'USDC', '1', 'quoted', ?)`
    ).run(paymentId, accountId, "0x" + "1".repeat(40), staleIso);

    await expect(confirmPayment(paymentId)).rejects.toThrow(/Quote expired/);

    const row = db.query("SELECT status FROM payments WHERE id = ?").get(paymentId) as {
      status: string;
    };
    expect(row.status).toBe("failed");
    // A second confirm cannot resurrect it — no auto-retry, no replay.
    await expect(confirmPayment(paymentId)).rejects.toThrow(/only a fresh quote/);
  });

  it("does not let a stale expiry snapshot overwrite a confirmation claimed elsewhere", async () => {
    const accountId = makeAccount(newId());
    const paymentId = newId();
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO payments
         (id, account_id, rail, to_addr, asset, amount_minor, status, created_at)
       VALUES (?, ?, 'evm-base', ?, 'USDC', '1', 'quoted', ?)`,
    ).run(paymentId, accountId, "0x" + "1".repeat(40), staleIso);

    let signalRead!: () => void;
    const snapshotRead = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    let resume!: () => void;
    const mayExpire = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const confirming = confirmPayment(paymentId, {
      afterRead: async () => {
        signalRead();
        await mayExpire;
      },
    });
    await snapshotRead;
    db.query("UPDATE payments SET status = 'confirmed' WHERE id = ?").run(paymentId);
    resume();

    await expect(confirming).rejects.toThrow(/only a fresh quote/);
    const row = db.query("SELECT status FROM payments WHERE id = ?").get(paymentId) as {
      status: string;
    };
    expect(row.status).toBe("confirmed");
  });

  it("uses a compare-and-swap claim when two confirms read the same quote", async () => {
    const accountId = makeAccount(newId());
    const paymentId = newId();
    db.query(
      `INSERT INTO payments
         (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status, created_at)
       VALUES (?, ?, 'test', 'test-destination', 'TEST', '7', '0', 'quoted', ?)`,
    ).run(paymentId, accountId, new Date().toISOString());

    let sends = 0;
    const sender: PaymentSender = {
      type: "test",
      assets: ["TEST"],
      async quote() {
        throw new Error("not used");
      },
      async send(_ctx, _instruction, hooks) {
        sends += 1;
        hooks?.onSigned?.("test-operation");
        return { externalId: "test-operation", status: "broadcast" };
      },
    };

    let arrivals = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeClaim = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothRead;
    };

    const results = await Promise.allSettled([
      confirmPayment(paymentId, { senders: [sender], beforeClaim }),
      confirmPayment(paymentId, { senders: [sender], beforeClaim }),
    ]);

    expect(sends).toBe(1);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /only a fresh quote/,
    );
  });

  it("closes the generic confirmation door and rolls back a rejected exact bound claim", async () => {
    const fixture = insertBoundQuote();
    let sends = 0;
    const sender: PaymentSender = {
      type: "btc",
      assets: ["BTC"],
      async quote() {
        throw new Error("not used");
      },
      async send(ctx) {
        sends += 1;
        expect(ctx.expectedUnsignedPayloadHash).toBe(fixture.unsignedPayloadHash);
        expect(Array.from(ctx.expectedUnsignedPayload!)).toEqual(
          Array.from(fixture.unsignedPayload),
        );
        return { externalId: idFor("bound-operation"), status: "broadcast" };
      },
    };

    await expect(
      confirmPayment(fixture.paymentId, { senders: [sender] }),
    ).rejects.toThrow(/exact bound-confirmation door/);
    expect(sends).toBe(0);

    await expect(
      confirmPayment(fixture.paymentId, {
        senders: [sender],
        boundClaim: {
          intentRecordId: fixture.intentRecordId,
          reviewId: fixture.reviewId,
          unsignedPayloadHash: fixture.unsignedPayloadHash,
          assertClaim: () => {
            throw new Error("execution commitment refused");
          },
        },
      }),
    ).rejects.toThrow(/execution commitment refused/);
    expect(sends).toBe(0);
    expect(
      (db.query("SELECT status FROM payments WHERE id = ?").get(fixture.paymentId) as {
        status: string;
      }).status,
    ).toBe("quoted");

    let asserted = 0;
    const result = await confirmPayment(fixture.paymentId, {
      senders: [sender],
      boundClaim: {
        intentRecordId: fixture.intentRecordId,
        reviewId: fixture.reviewId,
        unsignedPayloadHash: fixture.unsignedPayloadHash,
        assertClaim: (claim) => {
          asserted += 1;
          expect(claim.paymentId).toBe(fixture.paymentId);
          expect(claim.accountId).toBe(fixture.accountId);
          expect(claim.reservationId).toBe(fixture.reservationId);
          expect(claim.unsignedPayloadHash).toBe(fixture.unsignedPayloadHash);
          expect(Array.from(claim.unsignedPayload)).toEqual(
            Array.from(fixture.unsignedPayload),
          );
        },
      },
    });
    expect(asserted).toBe(1);
    expect(sends).toBe(1);
    expect(result.status).toBe("broadcast");
  });

  it("gives only one exact bound confirmer the compare-and-swap claim", async () => {
    const fixture = insertBoundQuote();
    let sends = 0;
    let assertions = 0;
    const sender: PaymentSender = {
      type: "btc",
      assets: ["BTC"],
      async quote() {
        throw new Error("not used");
      },
      async send() {
        sends += 1;
        return { externalId: idFor("raced-bound-operation"), status: "broadcast" };
      },
    };
    let arrivals = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeClaim = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothRead;
    };
    const boundClaim = () => ({
      intentRecordId: fixture.intentRecordId,
      reviewId: fixture.reviewId,
      unsignedPayloadHash: fixture.unsignedPayloadHash,
      assertClaim: () => {
        assertions += 1;
      },
    });
    const results = await Promise.allSettled([
      confirmPayment(fixture.paymentId, {
        senders: [sender],
        beforeClaim,
        boundClaim: boundClaim(),
      }),
      confirmPayment(fixture.paymentId, {
        senders: [sender],
        beforeClaim,
        boundClaim: boundClaim(),
      }),
    ]);

    expect(assertions).toBe(1);
    expect(sends).toBe(1);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /only a fresh quote/,
    );
  });
});

describe("evm sender — validation happens before any network", () => {
  const ctx = { vaultKeyId: newId() };

  it("rejects a malformed destination address", async () => {
    await expect(
      evmSender.quote(ctx, { to: "not-an-address", amountMinor: "1", asset: "USDC" })
    ).rejects.toThrow(/not a valid EVM address/);
  });

  it("rejects zero, negative, decimal, and non-numeric amounts", async () => {
    const to = "0x" + "2".repeat(40);
    for (const bad of ["0", "-5", "1.5", "1e6", "", "01"]) {
      await expect(
        evmSender.quote(ctx, { to, amountMinor: bad, asset: "USDC" })
      ).rejects.toThrow(/positive integer minor-unit/);
    }
  });

  it("rejects assets outside ETH/USDC", async () => {
    await expect(
      evmSender.quote(ctx, { to: "0x" + "2".repeat(40), amountMinor: "1", asset: "BTC" })
    ).rejects.toThrow(/moves ETH and USDC/);
  });
});
