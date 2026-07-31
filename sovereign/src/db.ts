/** The sovereign ledger — one SQLite file, zero infra.
 *
 *  bun:sqlite ships inside Bun; there is nothing to install, start, or host.
 *  All money amounts are TEXT minor-unit strings (BigInt-exact — an 18-decimal
 *  wei amount never touches a float; house doctrine inherited from the
 *  connector seam). The DB file lives next to the process by default
 *  (~/.cashloom/sovereign.db) — your keys, your data, your machine.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installCashLoomV2Schema } from "./protocol/v2/schema.ts";

const dataDir = process.env.CASHLOOM_DATA_DIR ?? join(homedir(), ".cashloom");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// Private v2 records and sealed vault blobs share this local directory. Fail
// closed if an existing install cannot be tightened; a permissive data
// directory is not an acceptable fallback.
chmodSync(dataDir, 0o700);

export const DB_PATH = join(dataDir, "sovereign.db");

if (existsSync(DB_PATH)) chmodSync(DB_PATH, 0o600);
export const db = new Database(DB_PATH, { create: true });
// The file is empty on first creation at this point, so restrict it before
// schema or private record bytes are written.
chmodSync(DB_PATH, 0o600);

const hardenSqliteSidecars = (): void => {
  for (const path of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
};

// Install the wait policy before WAL negotiation: two fresh processes can
// otherwise race on PRAGMA journal_mode before either connection has a busy
// handler. A second local node waits instead of failing during startup or
// payment bookkeeping.
db.exec("PRAGMA busy_timeout = 5000;");
// WAL: safe concurrent reads while a sync writes; still a single local file.
// SQLite's journal-mode transition does not invoke the configured busy handler
// in Bun 1.3, so two processes opening a legacy non-WAL file need one bounded
// explicit retry loop around this one startup pragma.
const walDeadline = Date.now() + 5_000;
for (;;) {
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    break;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "SQLITE_BUSY" || Date.now() >= walDeadline) throw error;
    Bun.sleepSync(25);
  }
}
db.exec("PRAGMA foreign_keys = ON;");
hardenSqliteSidecars();

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
-- The v2 discovery authority is one stable pseudonymous node key. Concurrent
-- first activation across processes may do redundant crypto work, but only
-- one sealed key can win this dedicated label.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_v2_node_authority
  ON vault_keys(label)
  WHERE kind = 'secret' AND label = 'cashloom-v2-node-authority';

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
  execution_fee_ceiling_minor TEXT,
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

-- Exact public transaction evidence is committed in the same SQLite
-- transaction that advances the account nonce to "signed". A restart can
-- therefore distinguish "never signed" from "signed; do not retry" without
-- asking an RPC or reopening the vault.
CREATE TABLE IF NOT EXISTS evm_signed_transactions (
  payment_id              TEXT PRIMARY KEY REFERENCES payments(id),
  chain_id                INTEGER NOT NULL,
  from_address            TEXT NOT NULL CHECK (from_address = lower(from_address)),
  nonce                   INTEGER NOT NULL CHECK (nonce >= 0),
  unsigned_payload        BLOB NOT NULL,
  unsigned_payload_sha256 TEXT NOT NULL,
  signed_payload          BLOB NOT NULL,
  signed_payload_sha256   TEXT NOT NULL,
  tx_hash                 TEXT NOT NULL UNIQUE,
  created_at              TEXT NOT NULL
);

-- Stripe-hosted Checkout is an inbound collection for one connected seller,
-- not an outbound PaymentSender. Keep its asynchronous provider lifecycle and
-- idempotency evidence separate from crypto payments and their negative ledger
-- entries. This first contract is sandbox-only: livemode can never be true.
CREATE TABLE IF NOT EXISTS stripe_checkout_operations (
  id                     TEXT PRIMARY KEY,
  intent_id              TEXT NOT NULL UNIQUE,
  account_id             TEXT NOT NULL REFERENCES accounts(id),
  connected_account_id   TEXT NOT NULL,
  currency               TEXT NOT NULL,
  amount_minor           TEXT NOT NULL,
  purpose                TEXT NOT NULL,
  return_base_url        TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL UNIQUE,
  request_sha256         TEXT NOT NULL,
  request_json           TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (
    status IN (
      'prepared',
      'submitting',
      'submitted',
      'submission_unknown',
      'provider_reported_paid',
      'expired',
      'rejected'
    )
  ),
  checkout_session_id    TEXT,
  payment_intent_id      TEXT,
  checkout_url           TEXT,
  livemode               INTEGER NOT NULL DEFAULT 0 CHECK (livemode = 0),
  error_code             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_checkout_session
  ON stripe_checkout_operations(checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_checkout_payment_intent
  ON stripe_checkout_operations(payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- Raw webhook bodies are verified but deliberately not retained. The digest
-- gives replay/tamper evidence without turning the local ledger into a store
-- for customer-shaped provider payloads.
CREATE TABLE IF NOT EXISTS stripe_webhook_inbox (
  event_id                TEXT PRIMARY KEY,
  payload_sha256          TEXT NOT NULL,
  operation_id            TEXT REFERENCES stripe_checkout_operations(id),
  connected_account_id    TEXT NOT NULL,
  event_type              TEXT NOT NULL,
  object_id               TEXT,
  disposition             TEXT NOT NULL CHECK (
    disposition IN ('applied', 'ignored', 'refused', 'unmatched')
  ),
  received_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_operation
  ON stripe_webhook_inbox(operation_id, received_at);

`);

installCashLoomV2Schema(db);

// Forward-only additive payment fields: CREATE TABLE IF NOT EXISTS cannot grow
// an existing file, so probe and patch — idempotent.
const growPayments = db.transaction(() => {
  const paymentColumns = db.query("PRAGMA table_info(payments)").all() as {
    name: string;
  }[];
  if (!paymentColumns.some((c) => c.name === "detail")) {
    db.exec("ALTER TABLE payments ADD COLUMN detail TEXT");
  }
  if (!paymentColumns.some((c) => c.name === "execution_fee_ceiling_minor")) {
    db.exec("ALTER TABLE payments ADD COLUMN execution_fee_ceiling_minor TEXT");
  }
});
// The probe runs after the writer lock is held, so two fresh CashLoom processes
// cannot both decide to add the same legacy column.
growPayments.immediate();
hardenSqliteSidecars();

export const newId = (): string => crypto.randomUUID();
