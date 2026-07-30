import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "cashloom-evm-nonce-migration-test-"));
process.env.CASHLOOM_DATA_DIR = dataDir;
const databasePath = join(dataDir, "sovereign.db");

// Exact payment/account shape immediately before the nonce-coordination
// migration. Importing db.ts must add the new table and preserve these rows.
const legacy = new Database(databasePath, { create: true });
legacy.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY,
  rail                TEXT NOT NULL,
  connector_type      TEXT,
  display_name        TEXT NOT NULL,
  currency            TEXT NOT NULL,
  decimals            INTEGER NOT NULL,
  balance_minor       TEXT NOT NULL DEFAULT '0',
  balance_as_of       TEXT,
  external_account_id TEXT,
  credential_ref      TEXT,
  vault_key_id        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  rail         TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  asset        TEXT NOT NULL,
  amount_minor TEXT NOT NULL,
  fee_minor    TEXT,
  status       TEXT NOT NULL,
  tx_hash      TEXT,
  error        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT
);
INSERT INTO accounts
  (id, rail, display_name, currency, decimals, vault_key_id)
VALUES
  ('legacy-account', 'CRYPTO', 'legacy EVM', 'ETH', 18, 'legacy-key');
INSERT INTO payments
  (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status)
VALUES
  ('legacy-payment', 'legacy-account', 'evm-base',
   '0xffffffffffffffffffffffffffffffffffffffff', 'ETH', '1', '1', 'confirmed');
`);
legacy.close();

const { db } = await import("../db.ts");
const { reserveEvmNonce } = await import("./evm-nonce.ts");

describe("EVM nonce migration", () => {
  it("grows an existing sovereign database in place and preserves payment state", () => {
    const columns = new Set(
      (
        db.query("PRAGMA table_info(evm_nonce_reservations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const column of [
      "payment_id",
      "chain_id",
      "from_address",
      "nonce",
      "state",
      "tx_hash",
      "created_at",
      "updated_at",
    ]) {
      expect(columns.has(column), column).toBe(true);
    }

    const legacyPayment = db
      .query("SELECT status, detail FROM payments WHERE id = 'legacy-payment'")
      .get() as { status: string; detail: string | null };
    expect(legacyPayment).toEqual({ status: "confirmed", detail: null });
    expect(
      reserveEvmNonce({
        paymentId: "legacy-payment",
        chainId: 8453,
        fromAddress: `0x${"1".repeat(40)}`,
        pendingNonce: 17,
      }),
    ).toBe(17);

    const indexes = new Set(
      (
        db.query("PRAGMA index_list(evm_nonce_reservations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    expect(indexes.has("idx_evm_nonce_live")).toBe(true);
    expect(indexes.has("idx_evm_nonce_hash")).toBe(true);
  });
});
