import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("refuses a known asset that does not match the account position", async () => {
    const id = makeAccount(newId());
    await expect(
      quotePayment({ accountId: id, to: "0x" + "1".repeat(40), amountMinor: "1", asset: "ETH" }),
    ).rejects.toThrow(/holds USDC; it cannot send ETH/);
  });

  it("never routes a generic Ethereum account to Base by symbol", async () => {
    const keyId = newId();
    const address = `0x${"3".repeat(40)}`;
    db.query(
      `INSERT INTO vault_keys (id, label, kind, address, enc_blob)
       VALUES (?, 'routing-only fixture', 'evm', ?, ?)`,
    ).run(keyId, address, new Uint8Array([1]));
    const accountId = newId();
    const ethereum = "eip155:1";
    db.query(
      `INSERT INTO accounts
         (id, rail, display_name, currency, decimals, external_account_id,
          chain_id, asset_id, account_ref, vault_key_id)
       VALUES (?, 'CRYPTO', 'Ethereum USDC', 'USDC', 6, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      address,
      ethereum,
      `${ethereum}/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`,
      `${ethereum}:${address}`,
      keyId,
    );
    await expect(
      quotePayment({ accountId, to: `0x${"4".repeat(40)}`, amountMinor: "1", asset: "USDC" }),
    ).rejects.toThrow(/will not guess a chain/);
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
