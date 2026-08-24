import type { Database } from "bun:sqlite";

/** Additive external-integration schema. It deliberately depends on v2 core. */
export const WALLET_INTEGRATION_TABLES = [
  "wk_integration_schema_meta",
  "wk_integration_connections",
  "wk_integration_signers",
  "wk_integration_interactions",
  "wk_integration_interaction_events",
  "wk_webauthn_credentials",
  "wk_webauthn_ceremonies",
  "wk_webauthn_evidence",
  "wk_walletconnect_sessions",
  "wk_external_artifacts",
  "wk_late_external_artifact_evidence",
  "wk_erc4337_operations",
  "wk_fiat_consents",
  "wk_fiat_authorization_sessions",
  "wk_fiat_payees",
  "wk_fiat_request_attempts",
  "wk_fiat_request_outcomes",
  "wk_fiat_webhook_evidence",
] as const;

export const WALLET_INTEGRATION_SCHEMA_VERSION = 2 as const;

const SHA256_CHECK = "GLOB 'sha256:[0-9a-f]*' AND length";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wk_integration_schema_meta (
  version INTEGER PRIMARY KEY, installed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wk_integration_connections (
  connection_id TEXT PRIMARY KEY REFERENCES wk_connections(id),
  kind TEXT NOT NULL CHECK (kind IN ('WEBAUTHN','HARDWARE','WALLETCONNECT','ERC4337','FIAT')),
  binding_hash TEXT NOT NULL CHECK (binding_hash ${SHA256_CHECK}(binding_hash)=71),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','EXPIRED','UNAVAILABLE')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_integration_signers (
  signer_id TEXT PRIMARY KEY REFERENCES wk_signers(id),
  connection_id TEXT NOT NULL REFERENCES wk_integration_connections(connection_id),
  binding_hash TEXT NOT NULL CHECK (binding_hash ${SHA256_CHECK}(binding_hash)=71),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','UNAVAILABLE')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_integration_interactions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES wk_integration_connections(connection_id),
  signer_id TEXT REFERENCES wk_integration_signers(signer_id),
  kind TEXT NOT NULL CHECK(kind IN ('hardware','walletconnect','erc4337')),
  intent_hash TEXT CHECK (intent_hash IS NULL OR (intent_hash ${SHA256_CHECK}(intent_hash)=71)),
  request_hash TEXT NOT NULL CHECK (request_hash ${SHA256_CHECK}(request_hash)=71),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','REFUSED','EXPIRED','REVOKED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
  CHECK ((status='COMPLETED') = (completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_integration_interaction_events (
  id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES wk_integration_interactions(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0), event_type TEXT NOT NULL,
  result_hash TEXT CHECK(result_hash IS NULL OR (result_hash ${SHA256_CHECK}(result_hash)=71)),
  occurred_at TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  UNIQUE(interaction_id, sequence)
);
CREATE TABLE IF NOT EXISTS wk_webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  signer_id TEXT NOT NULL REFERENCES wk_integration_signers(signer_id),
  account_id TEXT NOT NULL, rp_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK (origin_hash ${SHA256_CHECK}(origin_hash)=71),
  public_key TEXT NOT NULL CHECK (
    length(public_key)=132 AND substr(public_key,1,4)='0x04' AND
    public_key=lower(public_key) AND substr(public_key,3) NOT GLOB '*[^0-9a-f]*'
  ),
  public_key_hash TEXT NOT NULL CHECK (public_key_hash ${SHA256_CHECK}(public_key_hash)=71),
  counter_policy TEXT NOT NULL CHECK (counter_policy IN ('MONOTONIC','ZERO_ALLOWED')),
  sign_count TEXT NOT NULL CHECK (
    sign_count <> '' AND sign_count NOT GLOB '*[^0-9]*' AND
    (sign_count='0' OR substr(sign_count,1,1) BETWEEN '1' AND '9')
  ),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_webauthn_ceremonies (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('REGISTRATION','ASSERTION')),
  signer_id TEXT NOT NULL REFERENCES wk_integration_signers(signer_id),
  credential_id TEXT REFERENCES wk_webauthn_credentials(credential_id),
  account_id TEXT NOT NULL, authorization_id TEXT,
  prior_sign_count TEXT CHECK(prior_sign_count IS NULL OR (
    prior_sign_count <> '' AND prior_sign_count NOT GLOB '*[^0-9]*' AND
    (prior_sign_count='0' OR substr(prior_sign_count,1,1) BETWEEN '1' AND '9')
  )),
  rp_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK(origin_hash ${SHA256_CHECK}(origin_hash)=71),
  challenge_hash TEXT NOT NULL CHECK(challenge_hash ${SHA256_CHECK}(challenge_hash)=71),
  intent_hash TEXT CHECK(intent_hash IS NULL OR (intent_hash ${SHA256_CHECK}(intent_hash)=71)),
  request_hash TEXT CHECK(request_hash IS NULL OR (request_hash ${SHA256_CHECK}(request_hash)=71)),
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONSUMED','EXPIRED','REVOKED')),
  expires_at TEXT NOT NULL, consumed_at TEXT,
  CHECK ((status='CONSUMED') = (consumed_at IS NOT NULL)),
  CHECK (
    (kind='REGISTRATION' AND credential_id IS NULL AND authorization_id IS NULL AND
      intent_hash IS NULL AND request_hash IS NULL AND prior_sign_count IS NULL) OR
    (kind='ASSERTION' AND credential_id IS NOT NULL AND authorization_id IS NOT NULL AND
      intent_hash IS NOT NULL AND request_hash IS NOT NULL AND prior_sign_count IS NOT NULL)
  ),
  UNIQUE(signer_id, challenge_hash)
);
CREATE TABLE IF NOT EXISTS wk_webauthn_evidence (
  ceremony_id TEXT PRIMARY KEY REFERENCES wk_webauthn_ceremonies(id),
  kind TEXT NOT NULL CHECK(kind IN ('REGISTRATION','ASSERTION')),
  credential_id TEXT NOT NULL REFERENCES wk_webauthn_credentials(credential_id),
  rp_id TEXT NOT NULL,
  origin_hash TEXT NOT NULL CHECK(origin_hash ${SHA256_CHECK}(origin_hash)=71),
  primary_evidence_hash TEXT NOT NULL CHECK(primary_evidence_hash ${SHA256_CHECK}(primary_evidence_hash)=71),
  secondary_evidence_hash TEXT NOT NULL CHECK(secondary_evidence_hash ${SHA256_CHECK}(secondary_evidence_hash)=71),
  sign_count TEXT CHECK(sign_count IS NULL OR (
    sign_count <> '' AND sign_count NOT GLOB '*[^0-9]*' AND
    (sign_count='0' OR substr(sign_count,1,1) BETWEEN '1' AND '9')
  )),
  verified_at TEXT NOT NULL,
  CHECK ((kind='REGISTRATION') = (sign_count IS NULL))
);
CREATE TABLE IF NOT EXISTS wk_walletconnect_sessions (
  session_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES wk_integration_connections(connection_id),
  peer_public_key_hash TEXT NOT NULL CHECK(peer_public_key_hash ${SHA256_CHECK}(peer_public_key_hash)=71),
  binding_hash TEXT NOT NULL CHECK(binding_hash ${SHA256_CHECK}(binding_hash)=71),
  namespaces_json TEXT NOT NULL CHECK(json_valid(namespaces_json)),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_external_artifacts (
  id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE REFERENCES wk_integration_interactions(id),
  kind TEXT NOT NULL, intent_hash TEXT NOT NULL CHECK(intent_hash ${SHA256_CHECK}(intent_hash)=71),
  request_hash TEXT NOT NULL CHECK(request_hash ${SHA256_CHECK}(request_hash)=71),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ${SHA256_CHECK}(artifact_hash)=71),
  external_id_hash TEXT CHECK(external_id_hash IS NULL OR (external_id_hash ${SHA256_CHECK}(external_id_hash)=71)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wk_late_external_artifact_evidence (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES wk_integration_interactions(id),
  kind TEXT NOT NULL,
  intent_hash TEXT NOT NULL CHECK(intent_hash ${SHA256_CHECK}(intent_hash)=71),
  request_hash TEXT NOT NULL CHECK(request_hash ${SHA256_CHECK}(request_hash)=71),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ${SHA256_CHECK}(artifact_hash)=71),
  external_id_hash TEXT CHECK(external_id_hash IS NULL OR (external_id_hash ${SHA256_CHECK}(external_id_hash)=71)),
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wk_erc4337_operations (
  id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE REFERENCES wk_integration_interactions(id),
  chain_id TEXT NOT NULL, entry_point TEXT NOT NULL, sender TEXT NOT NULL,
  nonce_key TEXT NOT NULL, nonce_sequence TEXT NOT NULL,
  binding_hash TEXT NOT NULL CHECK(binding_hash ${SHA256_CHECK}(binding_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('PREPARED','SIGNED','SUBMITTED','AMBIGUOUS','SETTLED','FAILED','REVERTED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(chain_id, entry_point, sender, nonce_key, nonce_sequence)
);
CREATE TABLE IF NOT EXISTS wk_fiat_consents (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES wk_integration_connections(connection_id),
  provider_id TEXT NOT NULL,
  consent_ref_hash TEXT NOT NULL CHECK(consent_ref_hash ${SHA256_CHECK}(consent_ref_hash)=71),
  account_ref_hash TEXT NOT NULL CHECK(account_ref_hash ${SHA256_CHECK}(account_ref_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL)),
  UNIQUE(provider_id, consent_ref_hash)
);
CREATE TABLE IF NOT EXISTS wk_fiat_authorization_sessions (
  id TEXT PRIMARY KEY, consent_id TEXT NOT NULL REFERENCES wk_fiat_consents(id),
  provider_id TEXT NOT NULL,
  redirect_uri_hash TEXT NOT NULL CHECK(redirect_uri_hash ${SHA256_CHECK}(redirect_uri_hash)=71),
  issuer_hash TEXT NOT NULL CHECK(issuer_hash ${SHA256_CHECK}(issuer_hash)=71),
  state_hash TEXT NOT NULL UNIQUE CHECK(state_hash ${SHA256_CHECK}(state_hash)=71),
  pkce_verifier_hash TEXT NOT NULL CHECK(pkce_verifier_hash ${SHA256_CHECK}(pkce_verifier_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONSUMED','EXPIRED','REVOKED')),
  expires_at TEXT NOT NULL, consumed_at TEXT,
  CHECK ((status='CONSUMED') = (consumed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS wk_fiat_payees (
  id TEXT PRIMARY KEY, consent_id TEXT NOT NULL REFERENCES wk_fiat_consents(id),
  beneficiary_ref_hash TEXT NOT NULL CHECK(beneficiary_ref_hash ${SHA256_CHECK}(beneficiary_ref_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL, revoked_at TEXT,
  CHECK ((status='REVOKED') = (revoked_at IS NOT NULL)),
  UNIQUE(consent_id, beneficiary_ref_hash)
);
CREATE TABLE IF NOT EXISTS wk_fiat_request_attempts (
  id TEXT PRIMARY KEY,
  consent_id TEXT NOT NULL REFERENCES wk_fiat_consents(id),
  payee_id TEXT NOT NULL REFERENCES wk_fiat_payees(id),
  authorization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES wk_integration_connections(connection_id),
  provider_id TEXT NOT NULL,
  redirect_flow_id TEXT REFERENCES wk_fiat_authorization_sessions(id),
  intent_hash TEXT NOT NULL CHECK(intent_hash ${SHA256_CHECK}(intent_hash)=71),
  authorization_hash TEXT NOT NULL CHECK(authorization_hash ${SHA256_CHECK}(authorization_hash)=71),
  provider_idempotency_key_hash TEXT NOT NULL CHECK(provider_idempotency_key_hash ${SHA256_CHECK}(provider_idempotency_key_hash)=71),
  outcome TEXT NOT NULL DEFAULT 'PREPARED' CHECK(outcome='PREPARED'),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(consent_id, provider_idempotency_key_hash)
);
CREATE TABLE IF NOT EXISTS wk_fiat_request_outcomes (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES wk_fiat_request_attempts(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUBMITTED','AMBIGUOUS')),
  provider_payment_ref_hash TEXT CHECK(provider_payment_ref_hash IS NULL OR (provider_payment_ref_hash ${SHA256_CHECK}(provider_payment_ref_hash)=71)),
  response_hash TEXT NOT NULL CHECK(response_hash ${SHA256_CHECK}(response_hash)=71),
  occurred_at TEXT NOT NULL,
  CHECK(outcome='AMBIGUOUS' OR provider_payment_ref_hash IS NOT NULL),
  UNIQUE(attempt_id, sequence),
  UNIQUE(attempt_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_fiat_request_outcome_once
ON wk_fiat_request_outcomes(attempt_id);
CREATE TABLE IF NOT EXISTS wk_fiat_webhook_evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES wk_fiat_request_attempts(id),
  provider_id TEXT NOT NULL, delivery_id TEXT NOT NULL, event_type TEXT NOT NULL,
  /* Kept under the legacy column name for additive v1 migration; only a digest is stored. */
  provider_payment_ref TEXT NOT NULL CHECK(provider_payment_ref ${SHA256_CHECK}(provider_payment_ref)=71),
  provider_payment_ref_hash TEXT NOT NULL CHECK(provider_payment_ref_hash ${SHA256_CHECK}(provider_payment_ref_hash)=71),
  payload_hash TEXT NOT NULL CHECK(payload_hash ${SHA256_CHECK}(payload_hash)=71),
  signature_key_id TEXT NOT NULL,
  signature_hash TEXT NOT NULL CHECK(signature_hash ${SHA256_CHECK}(signature_hash)=71),
  occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','settled','failed','reversed','refunded','charged_back')),
  UNIQUE(provider_id, delivery_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wk_fiat_webhook_delivery_once
ON wk_fiat_webhook_evidence(provider_id,delivery_id);
`;

const HARDENING = `
DROP TRIGGER IF EXISTS wk_integration_connections_identity_immutable;
DROP TRIGGER IF EXISTS wk_integration_connections_status_monotonic;
DROP TRIGGER IF EXISTS wk_integration_connections_no_delete;
DROP TRIGGER IF EXISTS wk_integration_signers_identity_immutable;
DROP TRIGGER IF EXISTS wk_integration_signers_status_monotonic;
DROP TRIGGER IF EXISTS wk_integration_signers_no_delete;
DROP TRIGGER IF EXISTS wk_integration_interactions_identity_immutable;
DROP TRIGGER IF EXISTS wk_integration_interactions_status_monotonic;
DROP TRIGGER IF EXISTS wk_integration_interactions_no_delete;
DROP TRIGGER IF EXISTS wk_integration_interaction_events_no_update;
DROP TRIGGER IF EXISTS wk_integration_interaction_events_no_delete;
DROP TRIGGER IF EXISTS wk_webauthn_credentials_identity_immutable;
DROP TRIGGER IF EXISTS wk_webauthn_credentials_counter_monotonic;
DROP TRIGGER IF EXISTS wk_webauthn_credentials_status_monotonic;
DROP TRIGGER IF EXISTS wk_webauthn_credentials_no_delete;
DROP TRIGGER IF EXISTS wk_webauthn_ceremonies_binding_immutable;
DROP TRIGGER IF EXISTS wk_webauthn_ceremonies_status_monotonic;
DROP TRIGGER IF EXISTS wk_webauthn_ceremonies_no_delete;
DROP TRIGGER IF EXISTS wk_webauthn_evidence_no_update;
DROP TRIGGER IF EXISTS wk_webauthn_evidence_no_delete;
DROP TRIGGER IF EXISTS wk_walletconnect_sessions_identity_immutable;
DROP TRIGGER IF EXISTS wk_walletconnect_sessions_status_monotonic;
DROP TRIGGER IF EXISTS wk_walletconnect_sessions_no_delete;
DROP TRIGGER IF EXISTS wk_external_artifacts_no_update;
DROP TRIGGER IF EXISTS wk_external_artifacts_no_delete;
DROP TRIGGER IF EXISTS wk_late_external_artifact_evidence_no_update;
DROP TRIGGER IF EXISTS wk_late_external_artifact_evidence_no_delete;
DROP TRIGGER IF EXISTS wk_erc4337_operations_identity_immutable;
DROP TRIGGER IF EXISTS wk_erc4337_operations_status_monotonic;
DROP TRIGGER IF EXISTS wk_erc4337_operations_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_consents_identity_immutable;
DROP TRIGGER IF EXISTS wk_fiat_consents_status_monotonic;
DROP TRIGGER IF EXISTS wk_fiat_consents_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_authorization_sessions_identity_immutable;
DROP TRIGGER IF EXISTS wk_fiat_authorization_sessions_status_monotonic;
DROP TRIGGER IF EXISTS wk_fiat_authorization_sessions_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_payees_identity_immutable;
DROP TRIGGER IF EXISTS wk_fiat_payees_status_monotonic;
DROP TRIGGER IF EXISTS wk_fiat_payees_no_update;
DROP TRIGGER IF EXISTS wk_fiat_payees_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_request_attempts_prepared_only;
DROP TRIGGER IF EXISTS wk_fiat_request_attempts_no_update;
DROP TRIGGER IF EXISTS wk_fiat_request_attempts_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_request_outcomes_no_update;
DROP TRIGGER IF EXISTS wk_fiat_request_outcomes_no_delete;
DROP TRIGGER IF EXISTS wk_fiat_webhook_evidence_no_update;
DROP TRIGGER IF EXISTS wk_fiat_webhook_evidence_no_delete;

CREATE TRIGGER wk_integration_connections_identity_immutable BEFORE UPDATE ON wk_integration_connections
WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.kind IS NOT OLD.kind OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'integration connection identity is immutable'); END;
CREATE TRIGGER wk_integration_connections_status_monotonic BEFORE UPDATE OF status,revoked_at ON wk_integration_connections
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at) OR (OLD.status='ACTIVE' AND NEW.status IN ('REVOKED','EXPIRED','UNAVAILABLE') AND ((NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL) OR (NEW.status<>'REVOKED' AND NEW.revoked_at IS NULL))))
BEGIN SELECT RAISE(ABORT, 'integration connection status transition refused'); END;
CREATE TRIGGER wk_integration_connections_no_delete BEFORE DELETE ON wk_integration_connections BEGIN SELECT RAISE(ABORT, 'integration connections are retained as authority evidence'); END;
CREATE TRIGGER wk_integration_signers_identity_immutable BEFORE UPDATE ON wk_integration_signers
WHEN NEW.signer_id IS NOT OLD.signer_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'integration signer identity is immutable'); END;
CREATE TRIGGER wk_integration_signers_status_monotonic BEFORE UPDATE OF status,revoked_at ON wk_integration_signers
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at) OR (OLD.status='ACTIVE' AND NEW.status IN ('REVOKED','UNAVAILABLE') AND ((NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL) OR (NEW.status='UNAVAILABLE' AND NEW.revoked_at IS NULL))))
BEGIN SELECT RAISE(ABORT, 'integration signer status transition refused'); END;
CREATE TRIGGER wk_integration_signers_no_delete BEFORE DELETE ON wk_integration_signers BEGIN SELECT RAISE(ABORT, 'integration signers are retained as authority evidence'); END;
CREATE TRIGGER wk_integration_interactions_identity_immutable BEFORE UPDATE ON wk_integration_interactions
WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.signer_id IS NOT OLD.signer_id OR NEW.kind IS NOT OLD.kind OR NEW.intent_hash IS NOT OLD.intent_hash OR NEW.request_hash IS NOT OLD.request_hash OR NEW.binding_json IS NOT OLD.binding_json OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'integration interaction identity is immutable'); END;
CREATE TRIGGER wk_integration_interactions_status_monotonic BEFORE UPDATE OF status,completed_at ON wk_integration_interactions
WHEN NOT ((NEW.status=OLD.status AND NEW.completed_at IS OLD.completed_at) OR (OLD.status='PENDING' AND NEW.status='COMPLETED' AND NEW.completed_at IS NOT NULL) OR (OLD.status='PENDING' AND NEW.status IN ('REFUSED','EXPIRED','REVOKED') AND NEW.completed_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'integration interaction status transition refused'); END;
CREATE TRIGGER wk_integration_interactions_no_delete BEFORE DELETE ON wk_integration_interactions BEGIN SELECT RAISE(ABORT, 'integration interactions are retained as audit evidence'); END;
CREATE TRIGGER wk_integration_interaction_events_no_update BEFORE UPDATE ON wk_integration_interaction_events BEGIN SELECT RAISE(ABORT, 'integration interaction events are append-only'); END;
CREATE TRIGGER wk_integration_interaction_events_no_delete BEFORE DELETE ON wk_integration_interaction_events BEGIN SELECT RAISE(ABORT, 'integration interaction events are append-only'); END;

CREATE TRIGGER wk_webauthn_credentials_identity_immutable BEFORE UPDATE ON wk_webauthn_credentials
WHEN NEW.credential_id IS NOT OLD.credential_id OR NEW.signer_id IS NOT OLD.signer_id OR NEW.account_id IS NOT OLD.account_id OR NEW.rp_id IS NOT OLD.rp_id OR NEW.origin_hash IS NOT OLD.origin_hash OR NEW.public_key IS NOT OLD.public_key OR NEW.public_key_hash IS NOT OLD.public_key_hash OR NEW.counter_policy IS NOT OLD.counter_policy OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'WebAuthn credential identity is immutable'); END;
CREATE TRIGGER wk_webauthn_credentials_counter_monotonic BEFORE UPDATE OF sign_count ON wk_webauthn_credentials
WHEN NEW.sign_count <> OLD.sign_count AND (length(NEW.sign_count) < length(OLD.sign_count) OR (length(NEW.sign_count)=length(OLD.sign_count) AND NEW.sign_count < OLD.sign_count))
BEGIN SELECT RAISE(ABORT, 'WebAuthn sign counter cannot decrease'); END;
CREATE TRIGGER wk_webauthn_credentials_status_monotonic BEFORE UPDATE OF status,revoked_at ON wk_webauthn_credentials
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at) OR (OLD.status='ACTIVE' AND NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'WebAuthn credential status transition refused'); END;
CREATE TRIGGER wk_webauthn_credentials_no_delete BEFORE DELETE ON wk_webauthn_credentials BEGIN SELECT RAISE(ABORT, 'WebAuthn credentials are retained as audit evidence'); END;
CREATE TRIGGER wk_webauthn_ceremonies_binding_immutable BEFORE UPDATE ON wk_webauthn_ceremonies
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.signer_id IS NOT OLD.signer_id OR NEW.credential_id IS NOT OLD.credential_id OR NEW.account_id IS NOT OLD.account_id OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.prior_sign_count IS NOT OLD.prior_sign_count OR NEW.rp_id IS NOT OLD.rp_id OR NEW.origin_hash IS NOT OLD.origin_hash OR NEW.challenge_hash IS NOT OLD.challenge_hash OR NEW.intent_hash IS NOT OLD.intent_hash OR NEW.request_hash IS NOT OLD.request_hash OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'WebAuthn ceremony binding is immutable'); END;
CREATE TRIGGER wk_webauthn_ceremonies_status_monotonic BEFORE UPDATE OF status,consumed_at ON wk_webauthn_ceremonies
WHEN NOT ((NEW.status=OLD.status AND NEW.consumed_at IS OLD.consumed_at) OR (OLD.status='PENDING' AND NEW.status='CONSUMED' AND NEW.consumed_at IS NOT NULL) OR (OLD.status='PENDING' AND NEW.status IN ('EXPIRED','REVOKED') AND NEW.consumed_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'WebAuthn ceremony status transition refused'); END;
CREATE TRIGGER wk_webauthn_ceremonies_no_delete BEFORE DELETE ON wk_webauthn_ceremonies BEGIN SELECT RAISE(ABORT, 'WebAuthn ceremonies are append-only audit evidence'); END;
CREATE TRIGGER wk_webauthn_evidence_no_update BEFORE UPDATE ON wk_webauthn_evidence BEGIN SELECT RAISE(ABORT, 'WebAuthn evidence is append-only'); END;
CREATE TRIGGER wk_webauthn_evidence_no_delete BEFORE DELETE ON wk_webauthn_evidence BEGIN SELECT RAISE(ABORT, 'WebAuthn evidence is append-only'); END;

CREATE TRIGGER wk_walletconnect_sessions_identity_immutable BEFORE UPDATE ON wk_walletconnect_sessions
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.peer_public_key_hash IS NOT OLD.peer_public_key_hash OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.namespaces_json IS NOT OLD.namespaces_json OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'WalletConnect session identity is immutable'); END;
CREATE TRIGGER wk_walletconnect_sessions_status_monotonic BEFORE UPDATE OF status,revoked_at,version ON wk_walletconnect_sessions
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at AND NEW.version=OLD.version) OR (OLD.status='ACTIVE' AND NEW.version=OLD.version+1 AND NEW.status IN ('REVOKED','EXPIRED') AND ((NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL) OR (NEW.status='EXPIRED' AND NEW.revoked_at IS NULL))))
BEGIN SELECT RAISE(ABORT, 'WalletConnect session status transition refused'); END;
CREATE TRIGGER wk_walletconnect_sessions_no_delete BEFORE DELETE ON wk_walletconnect_sessions BEGIN SELECT RAISE(ABORT, 'WalletConnect sessions are retained as audit evidence'); END;
CREATE TRIGGER wk_external_artifacts_no_update BEFORE UPDATE ON wk_external_artifacts BEGIN SELECT RAISE(ABORT, 'external artifacts are append-only'); END;
CREATE TRIGGER wk_external_artifacts_no_delete BEFORE DELETE ON wk_external_artifacts BEGIN SELECT RAISE(ABORT, 'external artifacts are append-only'); END;
CREATE TRIGGER wk_late_external_artifact_evidence_no_update BEFORE UPDATE ON wk_late_external_artifact_evidence BEGIN SELECT RAISE(ABORT, 'late external artifact evidence is append-only'); END;
CREATE TRIGGER wk_late_external_artifact_evidence_no_delete BEFORE DELETE ON wk_late_external_artifact_evidence BEGIN SELECT RAISE(ABORT, 'late external artifact evidence is append-only'); END;
CREATE TRIGGER wk_erc4337_operations_identity_immutable BEFORE UPDATE ON wk_erc4337_operations
WHEN NEW.id IS NOT OLD.id OR NEW.interaction_id IS NOT OLD.interaction_id OR NEW.chain_id IS NOT OLD.chain_id OR NEW.entry_point IS NOT OLD.entry_point OR NEW.sender IS NOT OLD.sender OR NEW.nonce_key IS NOT OLD.nonce_key OR NEW.nonce_sequence IS NOT OLD.nonce_sequence OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'ERC-4337 nonce and binding identity are immutable'); END;
CREATE TRIGGER wk_erc4337_operations_status_monotonic BEFORE UPDATE OF status ON wk_erc4337_operations
WHEN NOT (NEW.status=OLD.status OR (OLD.status='PREPARED' AND NEW.status IN ('SIGNED','FAILED')) OR (OLD.status='SIGNED' AND NEW.status IN ('SUBMITTED','FAILED')) OR (OLD.status='SUBMITTED' AND NEW.status='AMBIGUOUS'))
BEGIN SELECT RAISE(ABORT, 'ERC-4337 status transition refused'); END;
CREATE TRIGGER wk_erc4337_operations_no_delete BEFORE DELETE ON wk_erc4337_operations BEGIN SELECT RAISE(ABORT, 'ERC-4337 nonce claims are permanent'); END;

CREATE TRIGGER wk_fiat_consents_identity_immutable BEFORE UPDATE ON wk_fiat_consents
WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.provider_id IS NOT OLD.provider_id OR NEW.consent_ref_hash IS NOT OLD.consent_ref_hash OR NEW.account_ref_hash IS NOT OLD.account_ref_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'fiat consent identity is immutable'); END;
CREATE TRIGGER wk_fiat_consents_status_monotonic BEFORE UPDATE OF status,revoked_at ON wk_fiat_consents
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at) OR (OLD.status='ACTIVE' AND NEW.status IN ('REVOKED','EXPIRED') AND ((NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL) OR (NEW.status='EXPIRED' AND NEW.revoked_at IS NULL))))
BEGIN SELECT RAISE(ABORT, 'fiat consent status transition refused'); END;
CREATE TRIGGER wk_fiat_consents_no_delete BEFORE DELETE ON wk_fiat_consents BEGIN SELECT RAISE(ABORT, 'fiat consents are retained as authority evidence'); END;
CREATE TRIGGER wk_fiat_authorization_sessions_identity_immutable BEFORE UPDATE ON wk_fiat_authorization_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.consent_id IS NOT OLD.consent_id OR NEW.provider_id IS NOT OLD.provider_id OR NEW.redirect_uri_hash IS NOT OLD.redirect_uri_hash OR NEW.issuer_hash IS NOT OLD.issuer_hash OR NEW.state_hash IS NOT OLD.state_hash OR NEW.pkce_verifier_hash IS NOT OLD.pkce_verifier_hash OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'fiat authorization session identity is immutable'); END;
CREATE TRIGGER wk_fiat_authorization_sessions_status_monotonic BEFORE UPDATE OF status,consumed_at ON wk_fiat_authorization_sessions
WHEN NOT ((NEW.status=OLD.status AND NEW.consumed_at IS OLD.consumed_at) OR (OLD.status='PENDING' AND NEW.status='CONSUMED' AND NEW.consumed_at IS NOT NULL) OR (OLD.status='PENDING' AND NEW.status IN ('EXPIRED','REVOKED') AND NEW.consumed_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'fiat authorization session status transition refused'); END;
CREATE TRIGGER wk_fiat_authorization_sessions_no_delete BEFORE DELETE ON wk_fiat_authorization_sessions BEGIN SELECT RAISE(ABORT, 'fiat authorization sessions are retained as audit evidence'); END;
CREATE TRIGGER wk_fiat_payees_identity_immutable BEFORE UPDATE ON wk_fiat_payees
WHEN NEW.id IS NOT OLD.id OR NEW.consent_id IS NOT OLD.consent_id OR NEW.beneficiary_ref_hash IS NOT OLD.beneficiary_ref_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'fiat payee identity is immutable'); END;
CREATE TRIGGER wk_fiat_payees_status_monotonic BEFORE UPDATE OF status,revoked_at ON wk_fiat_payees
WHEN NOT ((NEW.status=OLD.status AND NEW.revoked_at IS OLD.revoked_at) OR (OLD.status='ACTIVE' AND NEW.status='REVOKED' AND NEW.revoked_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'fiat payee status transition refused'); END;
CREATE TRIGGER wk_fiat_request_attempts_prepared_only BEFORE INSERT ON wk_fiat_request_attempts WHEN NEW.outcome<>'PREPARED' BEGIN SELECT RAISE(ABORT, 'fiat authorization must be durably PREPARED before network I/O'); END;
CREATE TRIGGER wk_fiat_request_attempts_no_update BEFORE UPDATE ON wk_fiat_request_attempts BEGIN SELECT RAISE(ABORT, 'fiat prepared requests are immutable'); END;
CREATE TRIGGER wk_fiat_request_attempts_no_delete BEFORE DELETE ON wk_fiat_request_attempts BEGIN SELECT RAISE(ABORT, 'fiat prepared requests are permanent idempotency evidence'); END;
CREATE TRIGGER wk_fiat_request_outcomes_no_update BEFORE UPDATE ON wk_fiat_request_outcomes BEGIN SELECT RAISE(ABORT, 'fiat transport outcomes are append-only'); END;
CREATE TRIGGER wk_fiat_request_outcomes_no_delete BEFORE DELETE ON wk_fiat_request_outcomes BEGIN SELECT RAISE(ABORT, 'fiat transport outcomes are append-only'); END;
CREATE TRIGGER wk_fiat_webhook_evidence_no_update BEFORE UPDATE ON wk_fiat_webhook_evidence BEGIN SELECT RAISE(ABORT, 'fiat webhook evidence is append-only'); END;
CREATE TRIGGER wk_fiat_webhook_evidence_no_delete BEFORE DELETE ON wk_fiat_webhook_evidence BEGIN SELECT RAISE(ABORT, 'fiat webhook evidence is append-only'); END;
`;

const columns = (db: Database, table: string): Set<string> =>
  new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));

const addColumn = (db: Database, table: string, known: Set<string>, definition: string): void => {
  const name = definition.slice(0, definition.indexOf(" "));
  if (!known.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
};

export function installWalletIntegrationSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  for (const table of ["wk_connections", "wk_signers", "wk_payment_intents", "wk_executions"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error("Wallet Kernel core schema must be installed before integration schema.");
    }
  }
  db.transaction(() => {
    db.exec(SCHEMA);

    // Version 2 is additive. Legacy rows without these fields remain audit
    // evidence, but operational methods fail closed until they are migrated.
    const credentialColumns = columns(db, "wk_webauthn_credentials");
    addColumn(db, "wk_webauthn_credentials", credentialColumns,
      "public_key TEXT CHECK (public_key IS NULL OR (length(public_key)=132 AND substr(public_key,1,4)='0x04' AND public_key=lower(public_key) AND substr(public_key,3) NOT GLOB '*[^0-9a-f]*'))");
    const ceremonyColumns = columns(db, "wk_webauthn_ceremonies");
    addColumn(db, "wk_webauthn_ceremonies", ceremonyColumns, "account_id TEXT");
    addColumn(db, "wk_webauthn_ceremonies", ceremonyColumns, "authorization_id TEXT");
    addColumn(db, "wk_webauthn_ceremonies", ceremonyColumns, "prior_sign_count TEXT");
    const walletConnectColumns = columns(db, "wk_walletconnect_sessions");
    addColumn(db, "wk_walletconnect_sessions", walletConnectColumns, "namespaces_json TEXT CHECK(namespaces_json IS NULL OR json_valid(namespaces_json))");
    addColumn(db, "wk_walletconnect_sessions", walletConnectColumns, "version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)");
    const sessionColumns = columns(db, "wk_fiat_authorization_sessions");
    addColumn(db, "wk_fiat_authorization_sessions", sessionColumns, "provider_id TEXT");
    const attemptColumns = columns(db, "wk_fiat_request_attempts");
    addColumn(db, "wk_fiat_request_attempts", attemptColumns, "authorization_id TEXT");
    addColumn(db, "wk_fiat_request_attempts", attemptColumns, "connection_id TEXT REFERENCES wk_integration_connections(connection_id)");
    addColumn(db, "wk_fiat_request_attempts", attemptColumns, "provider_id TEXT");
    addColumn(db, "wk_fiat_request_attempts", attemptColumns, "redirect_flow_id TEXT REFERENCES wk_fiat_authorization_sessions(id)");
    addColumn(db, "wk_fiat_request_attempts", attemptColumns, "expires_at TEXT");
    const webhookColumns = columns(db, "wk_fiat_webhook_evidence");
    addColumn(db, "wk_fiat_webhook_evidence", webhookColumns, "attempt_id TEXT REFERENCES wk_fiat_request_attempts(id)");
    addColumn(db, "wk_fiat_webhook_evidence", webhookColumns,
      "provider_payment_ref_hash TEXT CHECK(provider_payment_ref_hash IS NULL OR (provider_payment_ref_hash GLOB 'sha256:[0-9a-f]*' AND length(provider_payment_ref_hash)=71))");

    db.exec(HARDENING);
    const installedAt = new Date().toISOString();
    db.query("INSERT OR IGNORE INTO wk_integration_schema_meta(version, installed_at) VALUES (1, ?)").run(installedAt);
    db.query("INSERT OR IGNORE INTO wk_integration_schema_meta(version, installed_at) VALUES (2, ?)").run(installedAt);
  })();
}
