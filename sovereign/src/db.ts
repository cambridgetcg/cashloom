/** The sovereign ledger — one SQLite file, zero infra.
 *
 *  bun:sqlite ships inside Bun; there is nothing to install, start, or host.
 *  All money amounts are TEXT minor-unit strings (BigInt-exact — an 18-decimal
 *  wei amount never touches a float; house doctrine inherited from the
 *  connector seam). The DB file lives next to the process by default
 *  (~/.cashloom/sovereign.db) — your keys, your data, your machine.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.CASHLOOM_DATA_DIR ?? join(homedir(), ".cashloom");
mkdirSync(dataDir, { recursive: true });

export const DB_PATH = join(dataDir, "sovereign.db");

export const db = new Database(DB_PATH, { create: true });

// WAL: safe concurrent reads while a sync writes; still a single local file.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// A second process on the same file (a stray dev node) must make writers
// wait, not throw SQLITE_BUSY mid-payment-bookkeeping.
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- An Account is one balance-bearing store on a rail (connector-synced or a
-- local wallet). It holds no funds itself — the labelled container a balance
-- syncs into (doctrine ported from the original Account model).
CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  rail                TEXT NOT NULL,             -- STRIPE|BANK|CRYPTO|CASH|PLATFORM_CREDIT|GIFT_CARD
  connector_type      TEXT,                      -- read-rail connector, if synced
  display_name        TEXT NOT NULL,
  currency            TEXT NOT NULL,
  decimals            INTEGER NOT NULL,
  balance_minor       TEXT NOT NULL DEFAULT '0', -- integer minor units as TEXT
  balance_as_of       TEXT,
  external_account_id TEXT,                      -- rail's own id (address, wallet uuid, acct id)
  credential_ref      TEXT,                      -- env-var NAME, never a value
  vault_key_id        TEXT,                      -- local signing key backing this account, if any
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The ledger. external_id is the rail's own stable id; the UNIQUE index is
-- the dedupe: a re-synced row is a skip, never a double.
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  external_id  TEXT,
  title        TEXT NOT NULL,
  amount_minor TEXT NOT NULL,                    -- SIGNED minor units: negative = out
  category     TEXT,
  date         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'MANUAL',   -- MANUAL|CONNECTOR|CSV|PAYMENT
  raw          TEXT,                             -- untouched provider payload (reconciliation only)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedupe
  ON transactions(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);

-- Local key custody. enc_blob is Argon2id(passphrase)->AES-256-GCM sealed;
-- plaintext key material NEVER touches this table, any log, or the network.
CREATE TABLE IF NOT EXISTS vault_keys (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL,                      -- 'evm' | 'btc' | 'secret'
  address    TEXT,                               -- public address (derivable, safe to store)
  enc_blob   BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Outbound payments: every send is quoted first (fee disclosed), confirmed
-- explicitly, and recorded whatever happens. NEVER auto-retried.
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  rail         TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  asset        TEXT NOT NULL,
  amount_minor TEXT NOT NULL,
  fee_minor    TEXT,
  status       TEXT NOT NULL,                    -- quoted|confirmed|broadcast|failed
  tx_hash      TEXT,
  error        TEXT,
  detail       TEXT,                             -- opaque sender state (e.g. BTC coin selection); never key material
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT
);

-- EVM nonces are an account-wide sequence, not a payment-local field. Two
-- different confirmed payments may otherwise read the same RPC "pending"
-- nonce and sign conflicting transactions. Reservations are durable and
-- scoped by chain + normalized sender. Only a state that proves raw dispatch
-- never began may release its nonce for reuse.
CREATE TABLE IF NOT EXISTS evm_nonce_reservations (
  payment_id   TEXT PRIMARY KEY REFERENCES payments(id),
  chain_id     INTEGER NOT NULL,
  from_address TEXT NOT NULL CHECK (from_address = lower(from_address)),
  nonce        INTEGER NOT NULL CHECK (nonce >= 0),
  state        TEXT NOT NULL CHECK (
    state IN (
      'reserved',
      'signed',
      'submitting',
      'submitted',
      'submission_unknown',
      'released_pre_submit'
    )
  ),
  tx_hash      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evm_nonce_live
  ON evm_nonce_reservations(chain_id, from_address, nonce)
  WHERE state != 'released_pre_submit';
CREATE UNIQUE INDEX IF NOT EXISTS idx_evm_nonce_hash
  ON evm_nonce_reservations(chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;
`);

// payments.detail arrived with the BTC sender; CREATE TABLE IF NOT EXISTS
// cannot grow an existing file, so probe and patch — idempotent.
const paymentColumns = db.query("PRAGMA table_info(payments)").all() as { name: string }[];
if (!paymentColumns.some((c) => c.name === "detail")) {
  db.exec("ALTER TABLE payments ADD COLUMN detail TEXT");
}

export const newId = (): string => crypto.randomUUID();
