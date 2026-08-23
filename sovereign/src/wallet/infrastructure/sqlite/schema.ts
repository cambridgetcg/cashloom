import type { Database } from "bun:sqlite";

/**
 * Wallet Kernel tables are deliberately namespaced. The sovereign node already
 * owns an `accounts` table whose one-account/one-currency shape is incompatible
 * with a multi-asset wallet account, so v2 must be additive on existing files.
 */
export const WALLET_KERNEL_TABLES = [
  "wk_schema_meta",
  "wk_wallets",
  "wk_assets",
  "wk_accounts",
  "wk_positions",
  "wk_connections",
  "wk_signers",
  "wk_payment_intents",
  "wk_intent_events",
  "wk_idempotency_requests",
  "wk_quotes",
  "wk_simulations",
  "wk_authorizations",
  "wk_agent_capability_usage",
  "wk_agent_authorizations",
  "wk_reservations",
  "wk_signed_artifacts",
  "wk_executions",
  "wk_receipts",
  "wk_chain_sightings",
  "wk_chain_consensus",
  "wk_reservation_resolutions",
  "wk_ledger_accounts",
  "wk_journal_entries",
  "wk_postings",
  "wk_observations",
  "wk_reconciliation_links",
  "wk_webhook_inbox",
  "wk_outbox",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wk_schema_meta (
  version      INTEGER PRIMARY KEY,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS wk_wallets (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  owner_ref     TEXT,
  policy_ref    TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','LOCKED','ARCHIVED')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wk_assets (
  id               TEXT PRIMARY KEY,
  instrument_id    TEXT,
  kind             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  name             TEXT NOT NULL,
  decimals         INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 255),
  chain_id         TEXT,
  contract_address TEXT,
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_assets_instrument_idx ON wk_assets(instrument_id);

CREATE TABLE IF NOT EXISTS wk_accounts (
  id             TEXT PRIMARY KEY,
  wallet_id      TEXT NOT NULL REFERENCES wk_wallets(id),
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  rail           TEXT NOT NULL,
  chain_id       TEXT,
  account_ref    TEXT,
  address        TEXT,
  custody_mode   TEXT NOT NULL CHECK (custody_mode IN (
                    'watch_only','external_signer','local_self_custody',
                    'smart_account','managed_mpc','regulated_fiat_provider'
                  )),
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','LOCKED','DISCONNECTED','ARCHIVED')),
  metadata_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_accounts_wallet_idx ON wk_accounts(wallet_id);
CREATE INDEX IF NOT EXISTS wk_accounts_external_identity_idx
  ON wk_accounts(wallet_id, rail, account_ref)
  WHERE account_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS wk_positions (
  account_id       TEXT NOT NULL REFERENCES wk_accounts(id),
  asset_id         TEXT NOT NULL REFERENCES wk_assets(id),
  observed_atomic  TEXT NOT NULL DEFAULT '0' CHECK (
    observed_atomic = '0' OR
    (observed_atomic NOT GLOB '*[^0-9]*' AND substr(observed_atomic,1,1) BETWEEN '1' AND '9') OR
    (substr(observed_atomic,1,1) = '-' AND length(observed_atomic) > 1 AND
      substr(observed_atomic,2) NOT GLOB '*[^0-9]*' AND
      substr(observed_atomic,2,1) BETWEEN '1' AND '9')
  ),
  pending_atomic   TEXT NOT NULL DEFAULT '0' CHECK (
    pending_atomic = '0' OR
    (pending_atomic NOT GLOB '*[^0-9]*' AND substr(pending_atomic,1,1) BETWEEN '1' AND '9') OR
    (substr(pending_atomic,1,1) = '-' AND length(pending_atomic) > 1 AND
      substr(pending_atomic,2) NOT GLOB '*[^0-9]*' AND
      substr(pending_atomic,2,1) BETWEEN '1' AND '9')
  ),
  source            TEXT NOT NULL,
  source_cursor     TEXT,
  as_of             TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (account_id, asset_id)
);

CREATE TABLE IF NOT EXISTS wk_connections (
  id              TEXT PRIMARY KEY,
  wallet_id       TEXT NOT NULL REFERENCES wk_wallets(id),
  provider        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  external_ref    TEXT,
  credential_ref  TEXT,
  scopes_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at      TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_connections_wallet_idx ON wk_connections(wallet_id);

CREATE TABLE IF NOT EXISTS wk_signers (
  id                TEXT PRIMARY KEY,
  wallet_id         TEXT NOT NULL REFERENCES wk_wallets(id),
  account_id        TEXT REFERENCES wk_accounts(id),
  kind              TEXT NOT NULL CHECK (kind IN (
                      'EXTERNAL_WALLET','HARDWARE','LOCAL_ISOLATED',
                      'PASSKEY_SMART_ACCOUNT','MANAGED_MPC','FIAT_PROVIDER'
                    )),
  public_ref        TEXT,
  key_ref           TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','LOCKED','REVOKED','UNAVAILABLE')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_signers_account_idx ON wk_signers(account_id);

CREATE TABLE IF NOT EXISTS wk_payment_intents (
  id                  TEXT PRIMARY KEY,
  schema_version      TEXT NOT NULL,
  kind                TEXT NOT NULL,
  source_account_id   TEXT NOT NULL REFERENCES wk_accounts(id),
  asset_id            TEXT NOT NULL REFERENCES wk_assets(id),
  amount_atomic       TEXT NOT NULL CHECK (
    amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0' AND
    substr(amount_atomic,1,1) BETWEEN '1' AND '9'
  ),
  destination_json    TEXT NOT NULL CHECK (json_valid(destination_json)),
  fee_ceiling_atomic  TEXT CHECK (
    fee_ceiling_atomic IS NULL OR fee_ceiling_atomic = '0' OR
    (fee_ceiling_atomic NOT GLOB '*[^0-9]*' AND
      substr(fee_ceiling_atomic,1,1) BETWEEN '1' AND '9')
  ),
  fee_asset_id        TEXT REFERENCES wk_assets(id),
  state               TEXT NOT NULL,
  intent_hash         TEXT NOT NULL,
  created_by_type     TEXT NOT NULL,
  created_by_ref      TEXT NOT NULL,
  expires_at          TEXT,
  version             INTEGER NOT NULL DEFAULT 0,
  metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_intents_account_state_idx
  ON wk_payment_intents(source_account_id, state, created_at);
CREATE INDEX IF NOT EXISTS wk_intents_hash_idx ON wk_payment_intents(intent_hash);

CREATE TABLE IF NOT EXISTS wk_intent_events (
  id             TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL REFERENCES wk_payment_intents(id),
  sequence       INTEGER NOT NULL CHECK (sequence >= 0),
  event_type     TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT,
  actor_type     TEXT NOT NULL,
  actor_ref      TEXT NOT NULL,
  reason         TEXT,
  data_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  occurred_at    TEXT NOT NULL,
  UNIQUE (intent_id, sequence)
);
CREATE INDEX IF NOT EXISTS wk_intent_events_time_idx
  ON wk_intent_events(intent_id, occurred_at);

CREATE TABLE IF NOT EXISTS wk_idempotency_requests (
  scope               TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_kind       TEXT NOT NULL,
  response_id         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS wk_quotes (
  id                   TEXT PRIMARY KEY,
  intent_id            TEXT NOT NULL REFERENCES wk_payment_intents(id),
  provider             TEXT NOT NULL,
  quote_hash           TEXT NOT NULL,
  input_amount_atomic  TEXT NOT NULL CHECK (
    input_amount_atomic NOT GLOB '*[^0-9]*' AND input_amount_atomic <> '0' AND
    substr(input_amount_atomic,1,1) BETWEEN '1' AND '9'
  ),
  output_asset_id      TEXT REFERENCES wk_assets(id),
  output_amount_atomic TEXT CHECK (
    output_amount_atomic IS NULL OR output_amount_atomic = '0' OR
    (output_amount_atomic NOT GLOB '*[^0-9]*' AND
      substr(output_amount_atomic,1,1) BETWEEN '1' AND '9')
  ),
  fee_asset_id         TEXT REFERENCES wk_assets(id),
  fee_atomic           TEXT CHECK (
    fee_atomic IS NULL OR fee_atomic = '0' OR
    (fee_atomic NOT GLOB '*[^0-9]*' AND substr(fee_atomic,1,1) BETWEEN '1' AND '9')
  ),
  expires_at           TEXT NOT NULL,
  body_json            TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_quotes_intent_idx ON wk_quotes(intent_id, created_at);

CREATE TABLE IF NOT EXISTS wk_simulations (
  id                TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES wk_payment_intents(id),
  simulator         TEXT NOT NULL,
  simulation_hash   TEXT NOT NULL,
  result            TEXT NOT NULL,
  reference         TEXT,
  body_json         TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_simulations_intent_idx ON wk_simulations(intent_id, created_at);

CREATE TABLE IF NOT EXISTS wk_authorizations (
  id              TEXT PRIMARY KEY,
  intent_id       TEXT NOT NULL REFERENCES wk_payment_intents(id),
  intent_hash     TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  actor_ref       TEXT NOT NULL,
  method          TEXT NOT NULL,
  grant_hash      TEXT NOT NULL UNIQUE,
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','CONSUMED','REVOKED','EXPIRED')),
  expires_at      TEXT,
  consumed_at     TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_authorizations_intent_idx ON wk_authorizations(intent_id);

CREATE TABLE IF NOT EXISTS wk_agent_capability_usage (
  grant_id          TEXT PRIMARY KEY,
  revocation_nonce  INTEGER NOT NULL CHECK (revocation_nonce >= 0),
  intent_count      INTEGER NOT NULL CHECK (intent_count >= 0),
  spent_json        TEXT NOT NULL CHECK (json_valid(spent_json)),
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wk_agent_authorizations (
  id                    TEXT PRIMARY KEY,
  payment_intent_id     TEXT REFERENCES wk_payment_intents(id),
  wallet_id             TEXT NOT NULL,
  grant_id              TEXT NOT NULL,
  grant_revocation_nonce INTEGER NOT NULL CHECK (grant_revocation_nonce >= 0),
  capability_record_id  TEXT NOT NULL,
  intent_id             TEXT NOT NULL,
  delegate_key_id       TEXT NOT NULL,
  intent_record_id      TEXT NOT NULL UNIQUE,
  simulation_record_id  TEXT NOT NULL,
  policy_hash           TEXT NOT NULL,
  source_account        TEXT NOT NULL,
  declared_spends_json  TEXT NOT NULL CHECK (json_valid(declared_spends_json)),
  payees_json            TEXT NOT NULL CHECK (json_valid(payees_json)),
  body_json              TEXT NOT NULL CHECK (json_valid(body_json)),
  body_sha256            TEXT NOT NULL,
  signature              TEXT,
  host_authority         TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('RESERVED','ATTESTED','CONSUMED','REVOKED')),
  expires_at             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  attested_at            TEXT,
  consumed_at            TEXT
);
CREATE INDEX IF NOT EXISTS wk_agent_authorizations_payment_idx
  ON wk_agent_authorizations(payment_intent_id, status);

CREATE TABLE IF NOT EXISTS wk_reservations (
  id             TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL REFERENCES wk_payment_intents(id),
  account_id     TEXT NOT NULL REFERENCES wk_accounts(id),
  asset_id       TEXT NOT NULL REFERENCES wk_assets(id),
  kind           TEXT NOT NULL CHECK (kind IN ('BALANCE','BUDGET','UTXO','NONCE')),
  resource_key   TEXT,
  amount_atomic  TEXT NOT NULL CHECK (
    amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0' AND
    substr(amount_atomic,1,1) BETWEEN '1' AND '9'
  ),
  state          TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (state IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  expires_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  consumed_at    TEXT,
  released_at    TEXT
);
CREATE INDEX IF NOT EXISTS wk_reservations_balance_idx
  ON wk_reservations(account_id, asset_id, state, expires_at);
-- The ACTIVE+CONSUMED resource uniqueness index is installed only after the
-- migration audit below. Creating it here would make an old file with
-- conflicting pre-release claims abort before CashLoom can explain which
-- invariant requires operator review.

-- Exact public wire bytes produced by a signer. The row is appended in the
-- same transaction that consumes its one-shot signing authorization, so a
-- process failure can leave either a retryable authorization or a recoverable
-- artifact, but never a consumed authorization with no durable result.
CREATE TABLE IF NOT EXISTS wk_signed_artifacts (
  id                 TEXT PRIMARY KEY,
  authorization_id   TEXT NOT NULL UNIQUE REFERENCES wk_authorizations(id),
  intent_id          TEXT NOT NULL REFERENCES wk_payment_intents(id),
  intent_hash        TEXT NOT NULL,
  key_id             TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  encoding           TEXT NOT NULL CHECK (encoding = 'hex'),
  payload            TEXT NOT NULL CHECK (
                       length(payload) >= 4 AND length(payload) <= 524290 AND
                       length(payload) % 2 = 0 AND substr(payload,1,2) = '0x' AND
                       payload = lower(payload) AND
                       substr(payload,3) NOT GLOB '*[^0-9a-f]*'
                     ),
  envelope_hash      TEXT NOT NULL,
  external_tx_id     TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_signed_artifacts_envelope_uq
  ON wk_signed_artifacts(envelope_hash, external_tx_id);
CREATE INDEX IF NOT EXISTS wk_signed_artifacts_intent_idx
  ON wk_signed_artifacts(intent_id, created_at);

CREATE TABLE IF NOT EXISTS wk_executions (
  id                 TEXT PRIMARY KEY,
  intent_id          TEXT NOT NULL REFERENCES wk_payment_intents(id),
  sequence           INTEGER NOT NULL CHECK (sequence >= 0),
  rail               TEXT NOT NULL,
  state              TEXT NOT NULL,
  idempotency_key    TEXT,
  prepared_ref       TEXT,
  submission_ref     TEXT,
  network_tx_id      TEXT,
  request_hash       TEXT,
  signed_artifact_id TEXT REFERENCES wk_signed_artifacts(id),
  response_json      TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  ambiguous          INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
  error_code         TEXT,
  error_message      TEXT,
  version            INTEGER NOT NULL DEFAULT 0,
  submitted_at       TEXT,
  settled_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (intent_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_executions_rail_idempotency_uq
  ON wk_executions(rail, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wk_executions_intent_idx ON wk_executions(intent_id, sequence);

CREATE TABLE IF NOT EXISTS wk_receipts (
  id             TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL REFERENCES wk_payment_intents(id),
  execution_id   TEXT REFERENCES wk_executions(id),
  kind           TEXT NOT NULL,
  receipt_hash   TEXT NOT NULL UNIQUE,
  body_json      TEXT NOT NULL CHECK (json_valid(body_json)),
  observed_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_receipts_intent_idx ON wk_receipts(intent_id, created_at);

-- Provider-specific, append-only statements about one public transaction.
-- Block numbers remain decimal strings so chain truth never crosses a
-- JavaScript/SQLite integer precision boundary.
CREATE TABLE IF NOT EXISTS wk_chain_sightings (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES wk_payment_intents(id),
  execution_id     TEXT NOT NULL REFERENCES wk_executions(id),
  chain_id         TEXT NOT NULL CHECK (length(trim(chain_id)) > 0),
  network_tx_id    TEXT NOT NULL CHECK (length(trim(network_tx_id)) > 0),
  provider_id      TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
  evidence_hash    TEXT NOT NULL CHECK (length(trim(evidence_hash)) > 0),
  visibility       TEXT NOT NULL CHECK (visibility IN ('NOT_FOUND','MEMPOOL','INCLUDED')),
  outcome          TEXT NOT NULL CHECK (outcome IN ('UNKNOWN','SUCCESS','REVERTED')),
  security_level   TEXT NOT NULL CHECK (security_level IN ('UNSAFE','SAFE','FINALIZED')),
  block_hash       TEXT,
  block_number     TEXT CHECK (
                     block_number IS NULL OR block_number = '0' OR
                     (block_number NOT GLOB '*[^0-9]*' AND
                      substr(block_number,1,1) BETWEEN '1' AND '9')
                   ),
  body_json        TEXT NOT NULL CHECK (json_valid(body_json)),
  observed_at      TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  CHECK (
    (visibility = 'INCLUDED' AND outcome IN ('SUCCESS','REVERTED') AND
     block_hash IS NOT NULL AND length(trim(block_hash)) > 0 AND block_number IS NOT NULL)
    OR
    (visibility IN ('NOT_FOUND','MEMPOOL') AND outcome = 'UNKNOWN' AND
     security_level = 'UNSAFE' AND block_hash IS NULL AND block_number IS NULL)
  ),
  CHECK (security_level = 'UNSAFE' OR visibility = 'INCLUDED')
);
CREATE INDEX IF NOT EXISTS wk_chain_sightings_execution_idx
  ON wk_chain_sightings(execution_id, fetched_at, id);
CREATE INDEX IF NOT EXISTS wk_chain_sightings_transaction_idx
  ON wk_chain_sightings(chain_id, network_tx_id, provider_id, fetched_at, id);
CREATE INDEX IF NOT EXISTS wk_chain_sightings_intent_idx
  ON wk_chain_sightings(intent_id, fetched_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS wk_chain_sightings_fact_uq
  ON wk_chain_sightings(
    intent_id, execution_id, chain_id, network_tx_id, provider_id,
    evidence_hash, visibility, outcome, security_level,
    COALESCE(block_hash,''), COALESCE(block_number,''), observed_at, fetched_at
  );

-- A consensus row is a durable decision over already-recorded independent
-- provider statements. provider_ids_json is a canonical sorted JSON array;
-- migration-managed triggers below additionally enforce distinct providers
-- and exact execution/transaction binding.
CREATE TABLE IF NOT EXISTS wk_chain_consensus (
  id                TEXT PRIMARY KEY,
  intent_id         TEXT NOT NULL REFERENCES wk_payment_intents(id),
  execution_id      TEXT NOT NULL REFERENCES wk_executions(id),
  chain_id          TEXT NOT NULL CHECK (length(trim(chain_id)) > 0),
  network_tx_id     TEXT NOT NULL CHECK (length(trim(network_tx_id)) > 0),
  evidence_hash     TEXT NOT NULL CHECK (length(trim(evidence_hash)) > 0),
  visibility        TEXT NOT NULL CHECK (visibility IN ('NOT_FOUND','MEMPOOL','INCLUDED')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('UNKNOWN','SUCCESS','REVERTED')),
  security_level    TEXT NOT NULL CHECK (security_level IN ('UNSAFE','SAFE','FINALIZED')),
  block_hash        TEXT,
  block_number      TEXT CHECK (
                      block_number IS NULL OR block_number = '0' OR
                      (block_number NOT GLOB '*[^0-9]*' AND
                       substr(block_number,1,1) BETWEEN '1' AND '9')
                    ),
  provider_ids_json TEXT NOT NULL CHECK (
                      json_valid(provider_ids_json) AND
                      json_type(provider_ids_json) = 'array'
                    ),
  quorum            INTEGER NOT NULL CHECK (
                      quorum > 0 AND quorum <= json_array_length(provider_ids_json)
                    ),
  body_json         TEXT NOT NULL CHECK (json_valid(body_json)),
  decided_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  CHECK (
    (visibility = 'INCLUDED' AND outcome IN ('SUCCESS','REVERTED') AND
     block_hash IS NOT NULL AND length(trim(block_hash)) > 0 AND block_number IS NOT NULL)
    OR
    (visibility IN ('NOT_FOUND','MEMPOOL') AND outcome = 'UNKNOWN' AND
     security_level = 'UNSAFE' AND block_hash IS NULL AND block_number IS NULL)
  ),
  CHECK (security_level = 'UNSAFE' OR visibility = 'INCLUDED')
);
CREATE INDEX IF NOT EXISTS wk_chain_consensus_execution_idx
  ON wk_chain_consensus(execution_id, decided_at, id);
CREATE INDEX IF NOT EXISTS wk_chain_consensus_transaction_idx
  ON wk_chain_consensus(chain_id, network_tx_id, decided_at, id);
CREATE INDEX IF NOT EXISTS wk_chain_consensus_intent_idx
  ON wk_chain_consensus(intent_id, decided_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS wk_chain_consensus_fact_uq
  ON wk_chain_consensus(
    intent_id, execution_id, chain_id, network_tx_id, evidence_hash,
    visibility, outcome, security_level, COALESCE(block_hash,''),
    COALESCE(block_number,'')
  );

-- A consumed resource claim may be reopened only by the reconciliation path.
-- The evidence row is retained permanently so resource reuse can be audited.
CREATE TABLE IF NOT EXISTS wk_reservation_resolutions (
  id                    TEXT PRIMARY KEY,
  reservation_id        TEXT NOT NULL UNIQUE REFERENCES wk_reservations(id),
  intent_id             TEXT NOT NULL REFERENCES wk_payment_intents(id),
  execution_id          TEXT NOT NULL REFERENCES wk_executions(id),
  evidence_receipt_id   TEXT NOT NULL REFERENCES wk_receipts(id),
  evidence_receipt_hash TEXT NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('DROPPED','REPLACED')),
  match_basis           TEXT NOT NULL CHECK (match_basis IN (
                          'exact-rail-reference','exact-transaction-id',
                          'provider-idempotency-key'
                        )),
  matched_reference     TEXT NOT NULL,
  verifier_type         TEXT NOT NULL,
  verifier_ref          TEXT NOT NULL,
  data_json             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_reservation_resolutions_intent_idx
  ON wk_reservation_resolutions(intent_id, created_at);

CREATE TABLE IF NOT EXISTS wk_ledger_accounts (
  id                  TEXT PRIMARY KEY,
  wallet_id           TEXT REFERENCES wk_wallets(id),
  external_account_id TEXT REFERENCES wk_accounts(id),
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'ASSET','LIABILITY','EQUITY','INCOME','EXPENSE','CLEARING'
                      )),
  status              TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wk_journal_entries (
  id                TEXT PRIMARY KEY,
  description       TEXT NOT NULL,
  effective_at      TEXT NOT NULL,
  reference_type    TEXT,
  reference_id      TEXT,
  entry_fingerprint TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','POSTED')),
  metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at        TEXT NOT NULL,
  posted_at         TEXT
);
CREATE INDEX IF NOT EXISTS wk_journal_reference_idx
  ON wk_journal_entries(reference_type, reference_id);

CREATE TABLE IF NOT EXISTS wk_postings (
  id                TEXT PRIMARY KEY,
  journal_entry_id  TEXT NOT NULL REFERENCES wk_journal_entries(id),
  posting_index     INTEGER NOT NULL CHECK (posting_index >= 0),
  ledger_account_id TEXT NOT NULL REFERENCES wk_ledger_accounts(id),
  asset_id          TEXT NOT NULL REFERENCES wk_assets(id),
  direction         TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_atomic     TEXT NOT NULL CHECK (
    amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0' AND
    substr(amount_atomic,1,1) BETWEEN '1' AND '9'
  ),
  memo              TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (journal_entry_id, posting_index)
);
CREATE INDEX IF NOT EXISTS wk_postings_account_idx
  ON wk_postings(ledger_account_id, asset_id, created_at);

CREATE TABLE IF NOT EXISTS wk_observations (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES wk_accounts(id),
  asset_id       TEXT REFERENCES wk_assets(id),
  provider       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  amount_atomic  TEXT CHECK (
    amount_atomic IS NULL OR amount_atomic = '0' OR
    (amount_atomic NOT GLOB '*[^0-9]*' AND substr(amount_atomic,1,1) BETWEEN '1' AND '9') OR
    (substr(amount_atomic,1,1) = '-' AND length(amount_atomic) > 1 AND
      substr(amount_atomic,2) NOT GLOB '*[^0-9]*' AND
      substr(amount_atomic,2,1) BETWEEN '1' AND '9')
  ),
  state          TEXT,
  occurred_at    TEXT NOT NULL,
  body_json      TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at     TEXT NOT NULL,
  UNIQUE (provider, account_id, external_id)
);

CREATE TABLE IF NOT EXISTS wk_reconciliation_links (
  id                TEXT PRIMARY KEY,
  observation_id    TEXT NOT NULL REFERENCES wk_observations(id),
  intent_id          TEXT REFERENCES wk_payment_intents(id),
  execution_id       TEXT REFERENCES wk_executions(id),
  journal_entry_id   TEXT REFERENCES wk_journal_entries(id),
  match_kind         TEXT NOT NULL,
  confidence_bps     INTEGER NOT NULL CHECK (confidence_bps >= 0 AND confidence_bps <= 10000),
  data_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at         TEXT NOT NULL,
  UNIQUE (observation_id, match_kind, intent_id, execution_id, journal_entry_id)
);

CREATE TABLE IF NOT EXISTS wk_webhook_inbox (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  delivery_id      TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  signature_ref    TEXT,
  status           TEXT NOT NULL DEFAULT 'RECEIVED'
                   CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at      TEXT NOT NULL,
  processed_at     TEXT,
  last_error       TEXT,
  UNIQUE (provider, delivery_id)
);

CREATE TABLE IF NOT EXISTS wk_outbox (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','PUBLISHING','PUBLISHED','FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at    TEXT NOT NULL,
  lease_until     TEXT,
  published_at    TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wk_outbox_delivery_idx
  ON wk_outbox(status, available_at, lease_until);

-- Intent events are audit facts, never mutable history.
CREATE TRIGGER IF NOT EXISTS wk_intent_events_no_update
BEFORE UPDATE ON wk_intent_events
BEGIN
  SELECT RAISE(ABORT, 'wk_intent_events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_intent_events_no_delete
BEFORE DELETE ON wk_intent_events
BEGIN
  SELECT RAISE(ABORT, 'wk_intent_events are append-only');
END;

-- A quote is the exact evidence reviewed by policy/authorization. Re-quoting
-- creates another row; the original body and hash remain inspectable.
CREATE TRIGGER IF NOT EXISTS wk_quotes_no_update
BEFORE UPDATE ON wk_quotes
BEGIN
  SELECT RAISE(ABORT, 'wk_quotes are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_quotes_no_delete
BEFORE DELETE ON wk_quotes
BEGIN
  SELECT RAISE(ABORT, 'wk_quotes are append-only');
END;

-- Receipts are evidence. Corrections are represented by another receipt.
CREATE TRIGGER IF NOT EXISTS wk_receipts_no_update
BEFORE UPDATE ON wk_receipts
BEGIN
  SELECT RAISE(ABORT, 'wk_receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_receipts_no_delete
BEFORE DELETE ON wk_receipts
BEGIN
  SELECT RAISE(ABORT, 'wk_receipts are append-only');
END;

-- Generic observations and their reconciliation links are also evidence.
-- A correction is a new external observation/link, never a history rewrite.
CREATE TRIGGER IF NOT EXISTS wk_observations_no_update
BEFORE UPDATE ON wk_observations
BEGIN
  SELECT RAISE(ABORT, 'wk_observations are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_observations_no_delete
BEFORE DELETE ON wk_observations
BEGIN
  SELECT RAISE(ABORT, 'wk_observations are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_reconciliation_links_no_update
BEFORE UPDATE ON wk_reconciliation_links
BEGIN
  SELECT RAISE(ABORT, 'wk_reconciliation_links are append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_reconciliation_links_no_delete
BEFORE DELETE ON wk_reconciliation_links
BEGIN
  SELECT RAISE(ABORT, 'wk_reconciliation_links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS wk_reservation_resolutions_no_update
BEFORE UPDATE ON wk_reservation_resolutions
BEGIN
  SELECT RAISE(ABORT, 'reservation resolution evidence is append-only');
END;
CREATE TRIGGER IF NOT EXISTS wk_reservation_resolutions_no_delete
BEFORE DELETE ON wk_reservation_resolutions
BEGIN
  SELECT RAISE(ABORT, 'reservation resolution evidence is append-only');
END;

-- A posted journal is immutable. Reversals require a new balanced entry.
CREATE TRIGGER IF NOT EXISTS wk_journal_posted_no_update
BEFORE UPDATE ON wk_journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_journal_posted_no_delete
BEFORE DELETE ON wk_journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_postings_no_insert_after_posted
BEFORE INSERT ON wk_postings
WHEN EXISTS (
  SELECT 1 FROM wk_journal_entries
  WHERE id = NEW.journal_entry_id AND status = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_postings_no_update_after_posted
BEFORE UPDATE ON wk_postings
WHEN EXISTS (
  SELECT 1 FROM wk_journal_entries
  WHERE id = OLD.journal_entry_id AND status = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_postings_no_delete_after_posted
BEFORE DELETE ON wk_postings
WHEN EXISTS (
  SELECT 1 FROM wk_journal_entries
  WHERE id = OLD.journal_entry_id AND status = 'POSTED'
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable');
END;
`;

const AUTHORIZATION_TRIGGERS = `
-- The fields a signer relies on cannot be rebound, and a terminal one-time
-- grant cannot be made ACTIVE again by an accidental direct SQL update.
CREATE TRIGGER IF NOT EXISTS wk_authorizations_binding_immutable
BEFORE UPDATE ON wk_authorizations
WHEN OLD.intent_id IS NOT NEW.intent_id
  OR OLD.intent_hash IS NOT NEW.intent_hash
  OR OLD.key_id IS NOT NEW.key_id
  OR OLD.request_hash IS NOT NEW.request_hash
  OR OLD.grant_hash IS NOT NEW.grant_hash
  OR OLD.actor_type IS NOT NEW.actor_type
  OR OLD.actor_ref IS NOT NEW.actor_ref
  OR OLD.method IS NOT NEW.method
  OR OLD.constraints_json IS NOT NEW.constraints_json
  OR OLD.expires_at IS NOT NEW.expires_at
BEGIN
  SELECT RAISE(ABORT, 'signing authorization binding is immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_authorizations_terminal_immutable
BEFORE UPDATE ON wk_authorizations
WHEN OLD.status <> 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'consumed signing authorizations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS wk_authorizations_no_delete
BEFORE DELETE ON wk_authorizations
BEGIN
  SELECT RAISE(ABORT, 'signing authorizations are audit evidence');
END;
`;

const SIGNED_ARTIFACT_AND_EXECUTION_TRIGGERS = `
-- An artifact may only be appended against the still-active authorization it
-- exactly satisfies. Authorization consumption, below, requires this row to
-- be visible in the same transaction.
CREATE TRIGGER wk_signed_artifacts_authorization_binding_insert
BEFORE INSERT ON wk_signed_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM wk_authorizations authorization
  WHERE authorization.id = NEW.authorization_id
    AND authorization.status = 'ACTIVE'
    AND authorization.intent_id = NEW.intent_id
    AND authorization.intent_hash = NEW.intent_hash
    AND authorization.key_id = NEW.key_id
    AND authorization.request_hash = NEW.request_hash
    AND (authorization.expires_at IS NULL OR authorization.expires_at > NEW.created_at)
    AND (authorization.expires_at IS NULL OR authorization.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)
BEGIN
  SELECT RAISE(ABORT, 'signed artifact does not match an active authorization');
END;

-- A signature commits the selected nonce/UTXOs just as strongly as it commits
-- the one-shot authorization. Refuse to create recoverable wire bytes unless
-- every claim is still live, then consume every claim in this same INSERT
-- statement. This prevents an expiry sweep from making a signed resource
-- available to a second payment during a crash before execution linkage.
CREATE TRIGGER wk_signed_artifacts_reservations_binding_insert
BEFORE INSERT ON wk_signed_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM wk_reservations reservation
  WHERE reservation.intent_id = NEW.intent_id
) OR EXISTS (
  SELECT 1 FROM wk_reservations reservation
  WHERE reservation.intent_id = NEW.intent_id
    AND (
      reservation.state <> 'ACTIVE'
      OR (reservation.expires_at IS NOT NULL AND reservation.expires_at <= NEW.created_at)
      OR (reservation.expires_at IS NOT NULL AND reservation.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signed artifact requires live intent reservations');
END;

CREATE TRIGGER wk_signed_artifacts_consume_authorization_insert
AFTER INSERT ON wk_signed_artifacts
BEGIN
  UPDATE wk_authorizations
  SET status='CONSUMED', consumed_at=NEW.created_at
  WHERE id=NEW.authorization_id AND status='ACTIVE'
    AND intent_id=NEW.intent_id AND intent_hash=NEW.intent_hash
    AND key_id=NEW.key_id AND request_hash=NEW.request_hash;
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'signed artifact could not consume its authorization')
  END;
END;

CREATE TRIGGER wk_signed_artifacts_consume_reservations_insert
AFTER INSERT ON wk_signed_artifacts
BEGIN
  UPDATE wk_reservations
  SET state='CONSUMED', version=version+1,
      updated_at=NEW.created_at, consumed_at=NEW.created_at
  WHERE intent_id=NEW.intent_id AND state='ACTIVE';
  SELECT CASE WHEN changes() < 1 OR EXISTS (
    SELECT 1 FROM wk_reservations
    WHERE intent_id=NEW.intent_id AND state <> 'CONSUMED'
  ) THEN RAISE(ABORT, 'signed artifact could not consume its reservations')
  END;
END;

CREATE TRIGGER wk_signed_artifacts_no_update
BEFORE UPDATE ON wk_signed_artifacts
BEGIN
  SELECT RAISE(ABORT, 'signed artifacts are append-only execution evidence');
END;
CREATE TRIGGER wk_signed_artifacts_no_delete
BEFORE DELETE ON wk_signed_artifacts
BEGIN
  SELECT RAISE(ABORT, 'signed artifacts are append-only execution evidence');
END;

CREATE TRIGGER wk_authorizations_consumption_requires_artifact
BEFORE UPDATE ON wk_authorizations
WHEN OLD.status = 'ACTIVE' AND NEW.status = 'CONSUMED' AND NOT EXISTS (
  SELECT 1 FROM wk_signed_artifacts artifact
  WHERE artifact.authorization_id = OLD.id
    AND artifact.intent_id = OLD.intent_id
    AND artifact.intent_hash = OLD.intent_hash
    AND artifact.key_id = OLD.key_id
    AND artifact.request_hash = OLD.request_hash
)
BEGIN
  SELECT RAISE(ABORT, 'signing authorization consumption requires a durable signed artifact');
END;

CREATE TRIGGER wk_executions_initial_state
BEFORE INSERT ON wk_executions
WHEN NEW.state <> 'prepared'
BEGIN
  SELECT RAISE(ABORT, 'execution must begin prepared');
END;

CREATE TRIGGER wk_executions_state_transition
BEFORE UPDATE ON wk_executions
WHEN OLD.state IS NOT NEW.state AND NOT (
  (OLD.state = 'prepared' AND NEW.state IN ('signed','failed'))
  OR (OLD.state = 'signed' AND NEW.state IN ('submitted','ambiguous','failed'))
  OR (OLD.state = 'submitted' AND NEW.state IN ('succeeded','failed','ambiguous','dropped','replaced'))
  OR (OLD.state = 'ambiguous' AND NEW.state IN ('submitted','succeeded','failed','dropped','replaced'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid execution state transition');
END;

-- Request identity is immutable from creation. Once an artifact is linked,
-- its transaction id and response evidence can only be carried forward.
CREATE TRIGGER wk_executions_evidence_immutable
BEFORE UPDATE ON wk_executions
WHEN OLD.id IS NOT NEW.id
  OR OLD.intent_id IS NOT NEW.intent_id
  OR OLD.sequence IS NOT NEW.sequence
  OR OLD.rail IS NOT NEW.rail
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.prepared_ref IS NOT NEW.prepared_ref
  OR OLD.request_hash IS NOT NEW.request_hash
  OR (OLD.network_tx_id IS NOT NULL AND OLD.network_tx_id IS NOT NEW.network_tx_id)
  OR (OLD.signed_artifact_id IS NOT NULL AND OLD.signed_artifact_id IS NOT NEW.signed_artifact_id)
  OR (OLD.signed_artifact_id IS NOT NULL AND OLD.response_json IS NOT NEW.response_json)
BEGIN
  SELECT RAISE(ABORT, 'execution request or signed evidence is immutable');
END;

CREATE TRIGGER wk_executions_signed_artifact_binding_insert
BEFORE INSERT ON wk_executions
WHEN NEW.state IN ('signed','submitted','ambiguous','succeeded') AND (
  NEW.signed_artifact_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM wk_signed_artifacts artifact
    WHERE artifact.id = NEW.signed_artifact_id
      AND artifact.authorization_id = NEW.prepared_ref
      AND artifact.intent_id = NEW.intent_id
      AND artifact.request_hash = NEW.request_hash
      AND artifact.external_tx_id = NEW.network_tx_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'signed execution is not bound to its durable artifact');
END;

CREATE TRIGGER wk_executions_signed_artifact_binding_update
BEFORE UPDATE ON wk_executions
WHEN NEW.state IN ('signed','submitted','ambiguous','succeeded') AND (
  NEW.signed_artifact_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM wk_signed_artifacts artifact
    WHERE artifact.id = NEW.signed_artifact_id
      AND artifact.authorization_id = NEW.prepared_ref
      AND artifact.intent_id = NEW.intent_id
      AND artifact.request_hash = NEW.request_hash
      AND artifact.external_tx_id = NEW.network_tx_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'signed execution is not bound to its durable artifact');
END;
`;

const CHAIN_TRUTH_TRIGGERS = `
-- Both foreign keys must describe the same execution, intent and immutable
-- public transaction. Separate FKs alone cannot express that relationship.
CREATE TRIGGER wk_chain_sightings_execution_binding
BEFORE INSERT ON wk_chain_sightings
WHEN NOT EXISTS (
  SELECT 1 FROM wk_executions execution
  WHERE execution.id = NEW.execution_id
    AND execution.intent_id = NEW.intent_id
    AND execution.network_tx_id = NEW.network_tx_id
)
BEGIN
  SELECT RAISE(ABORT, 'chain sighting does not match execution transaction identity');
END;

CREATE TRIGGER wk_chain_consensus_execution_binding
BEFORE INSERT ON wk_chain_consensus
WHEN NOT EXISTS (
  SELECT 1 FROM wk_executions execution
  WHERE execution.id = NEW.execution_id
    AND execution.intent_id = NEW.intent_id
    AND execution.network_tx_id = NEW.network_tx_id
)
BEGIN
  SELECT RAISE(ABORT, 'chain consensus does not match execution transaction identity');
END;

-- A quorum names independent providers in deterministic byte order and can
-- only be recorded when every named provider has already supplied matching
-- chain evidence. This turns consensus into an auditable decision, not a
-- caller-controlled outcome flag.
CREATE TRIGGER wk_chain_consensus_provider_quorum
BEFORE INSERT ON wk_chain_consensus
WHEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.provider_ids_json)
    WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) = 0
  )
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.provider_ids_json))
       <> json_array_length(NEW.provider_ids_json)
  OR NEW.provider_ids_json IS NOT (
    SELECT json_group_array(value)
    FROM (SELECT value FROM json_each(NEW.provider_ids_json) ORDER BY value)
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.provider_ids_json) provider
    WHERE NOT EXISTS (
      SELECT 1 FROM wk_chain_sightings sighting
      WHERE sighting.intent_id = NEW.intent_id
        AND sighting.execution_id = NEW.execution_id
        AND sighting.chain_id = NEW.chain_id
        AND sighting.network_tx_id = NEW.network_tx_id
        AND sighting.provider_id = provider.value
        AND sighting.evidence_hash = NEW.evidence_hash
        AND sighting.visibility = NEW.visibility
        AND sighting.outcome = NEW.outcome
        AND sighting.security_level = NEW.security_level
        AND sighting.block_hash IS NEW.block_hash
        AND sighting.block_number IS NEW.block_number
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'chain consensus requires sorted distinct providers with matching sightings');
END;

CREATE TRIGGER wk_chain_sightings_no_update
BEFORE UPDATE ON wk_chain_sightings
BEGIN
  SELECT RAISE(ABORT, 'wk_chain_sightings are append-only');
END;
CREATE TRIGGER wk_chain_sightings_no_delete
BEFORE DELETE ON wk_chain_sightings
BEGIN
  SELECT RAISE(ABORT, 'wk_chain_sightings are append-only');
END;
CREATE TRIGGER wk_chain_consensus_no_update
BEFORE UPDATE ON wk_chain_consensus
BEGIN
  SELECT RAISE(ABORT, 'wk_chain_consensus is append-only');
END;
CREATE TRIGGER wk_chain_consensus_no_delete
BEFORE DELETE ON wk_chain_consensus
BEGIN
  SELECT RAISE(ABORT, 'wk_chain_consensus is append-only');
END;
`;

const IDENTITY_TRIGGERS = `
-- Stable ids cannot be rebound to a different economic or custody identity.
-- Display names, symbols, status and metadata remain intentionally mutable.
CREATE TRIGGER IF NOT EXISTS wk_assets_identity_immutable
BEFORE UPDATE ON wk_assets
WHEN OLD.id IS NOT NEW.id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.decimals IS NOT NEW.decimals
  OR OLD.chain_id IS NOT NEW.chain_id
  OR OLD.contract_address IS NOT NEW.contract_address
BEGIN
  SELECT RAISE(ABORT, 'asset identity is immutable under a stable id');
END;
CREATE TRIGGER IF NOT EXISTS wk_accounts_identity_immutable
BEFORE UPDATE ON wk_accounts
WHEN OLD.id IS NOT NEW.id
  OR OLD.wallet_id IS NOT NEW.wallet_id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.rail IS NOT NEW.rail
  OR OLD.chain_id IS NOT NEW.chain_id
  OR OLD.account_ref IS NOT NEW.account_ref
  OR OLD.address IS NOT NEW.address
  OR OLD.custody_mode IS NOT NEW.custody_mode
BEGIN
  SELECT RAISE(ABORT, 'account and custody identity is immutable under a stable id');
END;
`;

const AGENT_AUTHORIZATION_TRIGGERS = `
-- Signed agent authority is bound to one immutable grant/intent/payment body.
CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_initial_state
BEFORE INSERT ON wk_agent_authorizations
WHEN NEW.status <> 'RESERVED'
  OR NEW.signature IS NOT NULL
  OR NEW.attested_at IS NOT NULL
  OR NEW.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent authorization must begin reserved and unattested');
END;

CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_binding_immutable
BEFORE UPDATE ON wk_agent_authorizations
WHEN OLD.id IS NOT NEW.id
  OR OLD.payment_intent_id IS NOT NEW.payment_intent_id
  OR OLD.wallet_id IS NOT NEW.wallet_id
  OR OLD.grant_id IS NOT NEW.grant_id
  OR OLD.grant_revocation_nonce IS NOT NEW.grant_revocation_nonce
  OR OLD.capability_record_id IS NOT NEW.capability_record_id
  OR OLD.intent_id IS NOT NEW.intent_id
  OR OLD.delegate_key_id IS NOT NEW.delegate_key_id
  OR OLD.intent_record_id IS NOT NEW.intent_record_id
  OR OLD.simulation_record_id IS NOT NEW.simulation_record_id
  OR OLD.policy_hash IS NOT NEW.policy_hash
  OR OLD.source_account IS NOT NEW.source_account
  OR OLD.declared_spends_json IS NOT NEW.declared_spends_json
  OR OLD.payees_json IS NOT NEW.payees_json
  OR OLD.body_json IS NOT NEW.body_json
  OR OLD.body_sha256 IS NOT NEW.body_sha256
  OR OLD.host_authority IS NOT NEW.host_authority
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'agent authorization binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_status_transition
BEFORE UPDATE ON wk_agent_authorizations
WHEN OLD.status IS NOT NEW.status AND NOT (
  (OLD.status = 'RESERVED' AND NEW.status = 'ATTESTED'
    AND OLD.signature IS NULL AND NEW.signature IS NOT NULL
    AND OLD.attested_at IS NULL AND NEW.attested_at IS NOT NULL
    AND OLD.consumed_at IS NEW.consumed_at)
  OR (OLD.status = 'ATTESTED' AND NEW.status = 'CONSUMED'
    AND OLD.signature IS NEW.signature
    AND OLD.attested_at IS NEW.attested_at
    AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
  OR (OLD.status IN ('RESERVED','ATTESTED') AND NEW.status = 'REVOKED'
    AND OLD.signature IS NEW.signature
    AND OLD.attested_at IS NEW.attested_at
    AND OLD.consumed_at IS NEW.consumed_at)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid agent authorization status transition');
END;

CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_evidence_immutable
BEFORE UPDATE ON wk_agent_authorizations
WHEN (OLD.signature IS NOT NEW.signature
   OR OLD.attested_at IS NOT NEW.attested_at
   OR OLD.consumed_at IS NOT NEW.consumed_at)
  AND NOT (
    (OLD.status = 'RESERVED' AND NEW.status = 'ATTESTED'
      AND OLD.signature IS NULL AND NEW.signature IS NOT NULL
      AND OLD.attested_at IS NULL AND NEW.attested_at IS NOT NULL
      AND OLD.consumed_at IS NEW.consumed_at)
    OR (OLD.status = 'ATTESTED' AND NEW.status = 'CONSUMED'
      AND OLD.signature IS NEW.signature
      AND OLD.attested_at IS NEW.attested_at
      AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'agent authorization evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_blank_delegate_guard
BEFORE UPDATE ON wk_agent_authorizations
WHEN trim(OLD.delegate_key_id) = '' AND NEW.status IN ('ATTESTED','CONSUMED')
BEGIN
  SELECT RAISE(ABORT, 'legacy agent authorization has no bound delegate key');
END;

CREATE TRIGGER IF NOT EXISTS wk_agent_authorizations_no_delete
BEFORE DELETE ON wk_agent_authorizations
BEGIN
  SELECT RAISE(ABORT, 'agent authorizations are audit evidence');
END;
`;

const RESERVATION_TRANSITION_TRIGGERS = `
-- Direct SQL cannot casually reopen a signing resource. The reconciliation
-- transaction must first append the unique durable resolution evidence row.
CREATE TRIGGER IF NOT EXISTS wk_reservations_consumed_transition_guard
BEFORE UPDATE ON wk_reservations
WHEN OLD.state = 'CONSUMED' AND NEW.state IS NOT OLD.state AND (
  NEW.state <> 'RELEASED' OR NOT EXISTS (
    SELECT 1 FROM wk_reservation_resolutions
    WHERE reservation_id = OLD.id AND intent_id = OLD.intent_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'consumed reservation requires reconciliation evidence');
END;
`;

/** Install the additive Wallet Kernel v2 schema on a caller-owned database. */
export function installWalletKernelSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  const install = db.transaction(() => {
    db.exec(SCHEMA);
    // v6's evidence identity is execution-scoped. The same public transaction
    // may legitimately be imported under another intent/execution without
    // allowing either audit trail to rewrite the other.
    db.exec(`
      DROP INDEX IF EXISTS wk_chain_sightings_fact_uq;
      CREATE UNIQUE INDEX wk_chain_sightings_fact_uq
        ON wk_chain_sightings(
          intent_id, execution_id, chain_id, network_tx_id, provider_id,
          evidence_hash, visibility, outcome, security_level,
          COALESCE(block_hash,''), COALESCE(block_number,''), observed_at, fetched_at
        );
      DROP INDEX IF EXISTS wk_chain_consensus_fact_uq;
      CREATE UNIQUE INDEX wk_chain_consensus_fact_uq
        ON wk_chain_consensus(
          intent_id, execution_id, chain_id, network_tx_id, evidence_hash,
          visibility, outcome, security_level, COALESCE(block_hash,''),
          COALESCE(block_number,'')
        );
    `);
    // Pre-release v2 databases may contain the original generic authorization
    // row. Grow it without dropping approvals; unbound legacy rows cannot be
    // consumed through WalletKernelStore because their bindings are NULL.
    const authorizationColumns = db.query("PRAGMA table_info(wk_authorizations)").all() as Array<{
      name: string;
    }>;
    for (const column of ["intent_hash", "key_id", "request_hash"] as const) {
      if (!authorizationColumns.some((candidate) => candidate.name === column)) {
        db.exec(`ALTER TABLE wk_authorizations ADD COLUMN ${column} TEXT`);
      }
    }
    const agentAuthorizationColumns = db
      .query("PRAGMA table_info(wk_agent_authorizations)")
      .all() as Array<{ name: string }>;
    if (!agentAuthorizationColumns.some((candidate) => candidate.name === "grant_revocation_nonce")) {
      db.exec(
        "ALTER TABLE wk_agent_authorizations ADD COLUMN grant_revocation_nonce INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!agentAuthorizationColumns.some((candidate) => candidate.name === "expires_at")) {
      db.exec("ALTER TABLE wk_agent_authorizations ADD COLUMN expires_at TEXT");
    }
    if (!agentAuthorizationColumns.some((candidate) => candidate.name === "delegate_key_id")) {
      db.exec(
        "ALTER TABLE wk_agent_authorizations ADD COLUMN delegate_key_id TEXT NOT NULL DEFAULT ''",
      );
    }
    // Canonical/provider identity is not account-row identity. Legacy files can
    // contain two independently-labelled rows for one address, and v2 keeps
    // both until an explicit review or merge operation.
    db.exec("DROP INDEX IF EXISTS wk_accounts_external_identity_uq");
    db.exec(`
      CREATE INDEX IF NOT EXISTS wk_accounts_external_identity_idx
      ON wk_accounts(wallet_id, rail, account_ref)
      WHERE account_ref IS NOT NULL
    `);
    // Signing consumes a nonce/UTXO reservation; it does not make the resource
    // reusable. Keep the claim through broadcast ambiguity and settlement.
    db.exec("DROP INDEX IF EXISTS wk_reservations_active_resource_uq");
    const conflictingClaim = db.query(`
      SELECT account_id, kind, resource_key, COUNT(*) AS claim_count
      FROM wk_reservations
      WHERE state IN ('ACTIVE','CONSUMED') AND resource_key IS NOT NULL
      GROUP BY account_id, kind, resource_key
      HAVING COUNT(*) > 1
      ORDER BY account_id, kind, resource_key
      LIMIT 1
    `).get() as {
      account_id: string;
      kind: string;
      resource_key: string;
      claim_count: number;
    } | null;
    if (conflictingClaim) {
      throw new Error(
        `Wallet Kernel migration blocked: ${conflictingClaim.claim_count} live/consumed ${conflictingClaim.kind} claims share resource ${conflictingClaim.resource_key} on account ${conflictingClaim.account_id}. Quarantine and reconcile the pre-release reservations before retrying.`,
      );
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS wk_reservations_claimed_resource_uq
      ON wk_reservations(account_id, kind, resource_key)
      WHERE state IN ('ACTIVE','CONSUMED') AND resource_key IS NOT NULL
    `);
    // Repair the only safe pre-release crash shape: an artifact was durable
    // but its still-ACTIVE claims had not yet been advanced by pay.ts. Once
    // exact bytes exist those resources can never be released by TTL alone.
    db.exec(`
      UPDATE wk_reservations
      SET state='CONSUMED', version=version+1,
          updated_at=COALESCE((
            SELECT MIN(artifact.created_at) FROM wk_signed_artifacts artifact
            WHERE artifact.intent_id=wk_reservations.intent_id
          ), updated_at),
          consumed_at=COALESCE((
            SELECT MIN(artifact.created_at) FROM wk_signed_artifacts artifact
            WHERE artifact.intent_id=wk_reservations.intent_id
          ), updated_at)
      WHERE state='ACTIVE' AND EXISTS (
        SELECT 1 FROM wk_signed_artifacts artifact
        WHERE artifact.intent_id=wk_reservations.intent_id
      )
    `);
    const executionColumns = db.query("PRAGMA table_info(wk_executions)").all() as Array<{ name: string }>;
    if (!executionColumns.some((candidate) => candidate.name === "version")) {
      db.exec("ALTER TABLE wk_executions ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
    if (!executionColumns.some((candidate) => candidate.name === "signed_artifact_id")) {
      db.exec("ALTER TABLE wk_executions ADD COLUMN signed_artifact_id TEXT");
    }
    // Managed safety definitions changed during the v2 pre-release. Always
    // replace every mutable definition so an older IF NOT EXISTS trigger
    // cannot silently retain weaker identity, authority, reservation,
    // recovery, or evidence semantics on an upgraded database.
    for (const trigger of [
      "wk_authorizations_binding_immutable",
      "wk_authorizations_terminal_immutable",
      "wk_authorizations_no_delete",
      "wk_assets_identity_immutable",
      "wk_accounts_identity_immutable",
      "wk_agent_authorizations_initial_state",
      "wk_agent_authorizations_binding_immutable",
      "wk_agent_authorizations_status_transition",
      "wk_agent_authorizations_evidence_immutable",
      "wk_agent_authorizations_blank_delegate_guard",
      "wk_agent_authorizations_no_delete",
      "wk_reservations_consumed_transition_guard",
      "wk_signed_artifacts_authorization_binding_insert",
      "wk_signed_artifacts_reservations_binding_insert",
      "wk_signed_artifacts_consume_authorization_insert",
      "wk_signed_artifacts_consume_reservations_insert",
      "wk_signed_artifacts_no_update",
      "wk_signed_artifacts_no_delete",
      "wk_authorizations_consumption_requires_artifact",
      "wk_executions_initial_state",
      "wk_executions_state_transition",
      "wk_executions_evidence_immutable",
      "wk_executions_signed_artifact_binding_insert",
      "wk_executions_signed_artifact_binding_update",
      "wk_chain_sightings_execution_binding",
      "wk_chain_consensus_execution_binding",
      "wk_chain_consensus_provider_quorum",
      "wk_chain_sightings_no_update",
      "wk_chain_sightings_no_delete",
      "wk_chain_consensus_no_update",
      "wk_chain_consensus_no_delete",
    ] as const) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec(AUTHORIZATION_TRIGGERS);
    db.exec(SIGNED_ARTIFACT_AND_EXECUTION_TRIGGERS);
    db.exec(IDENTITY_TRIGGERS);
    db.exec(AGENT_AUTHORIZATION_TRIGGERS);
    db.exec(RESERVATION_TRANSITION_TRIGGERS);
    db.exec(CHAIN_TRUTH_TRIGGERS);
    db.query("INSERT OR IGNORE INTO wk_schema_meta (version) VALUES (5)").run();
    db.query("INSERT OR IGNORE INTO wk_schema_meta (version) VALUES (6)").run();
  });
  install.immediate();
}
