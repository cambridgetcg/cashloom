import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentSender } from "./senders/types.ts";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-pay-test-"));

const { db, newId } = await import("./db.ts");
const { quotePayment, confirmPayment } = await import("./pay.ts");
const { evmSender } = await import("./senders/evm.sender.ts");

const makeAccount = (vaultKeyId: string | null): string => {
  const id = newId();
  db.query(
    `INSERT INTO accounts (id, rail, display_name, currency, decimals, vault_key_id)
     VALUES (?, 'CRYPTO', 'wallet', 'USDC', 6, ?)`
  ).run(id, vaultKeyId);
  return id;
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
