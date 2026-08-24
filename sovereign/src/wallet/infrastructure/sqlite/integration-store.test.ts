import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBoundSignRequest } from "../../domain/signing.ts";
import {
  hashErc4337UserOperationBinding,
  hashHexData,
  hashUtf8,
} from "../../integrations/index.ts";
import { WalletKernelStore } from "./store.ts";
import { WalletIntegrationStore, WalletIntegrationStoreError } from "./integration-store.ts";

const open: Database[] = [];
const dirs: string[] = [];
const LATER = "2030-01-01T00:05:00.000Z";
const AFTER = "2030-01-01T00:06:00.000Z";
const NOW = () => new Date("2030-01-01T00:00:00.000Z");
const H = (text: string) => hashUtf8(text);
const account = "eip155:8453:0x1111111111111111111111111111111111111111";
const PUBLIC_KEY = `0x04${"11".repeat(64)}` as `0x${string}`;
const POLICY = Object.freeze({ rpId: "wallet.example", originHash: H("wallet-origin") });

afterEach(() => {
  while (open.length) open.pop()?.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const database = (): Database => {
  const db = new Database(":memory:");
  open.push(db);
  new WalletKernelStore(db);
  return db;
};

const seed = (db: Database): void => {
  const at = NOW().toISOString();
  db.query("INSERT INTO wk_wallets(id,label,metadata_json,created_at,updated_at) VALUES('wallet-1','wallet','{}',?,?)").run(at, at);
  db.query("INSERT INTO wk_connections(id,wallet_id,provider,kind,scopes_json,status,metadata_json,created_at,updated_at) VALUES('connection-1','wallet-1','test','TEST','[]','ACTIVE','{}',?,?)").run(at, at);
  db.query("INSERT INTO wk_signers(id,wallet_id,kind,capabilities_json,status,created_at,updated_at) VALUES('signer-1','wallet-1','PASSKEY_SMART_ACCOUNT','{}','ACTIVE',?,?)").run(at, at);
};

const setup = (options: { policy?: boolean; now?: () => Date } = {}) => {
  const db = database();
  seed(db);
  const store = new WalletIntegrationStore(db, {
    now: options.now ?? NOW,
    ...(options.policy === false ? {} : { webAuthnPolicy: POLICY }),
  });
  return { db, store };
};

const project = (
  store: WalletIntegrationStore,
  kind: "WEBAUTHN" | "HARDWARE" | "WALLETCONNECT" | "ERC4337" | "FIAT",
  signer = false,
): void => {
  store.putConnection({ connectionId: "connection-1", kind, bindingHash: H("connection") });
  if (signer) store.putSigner({ signerId: "signer-1", connectionId: "connection-1", bindingHash: H("signer") });
};

const registrationCeremony = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "cashloom.webauthn-registration/1",
  ceremony_id: "registration-1",
  signer_id: "signer-1",
  account_id: account,
  rp_id: POLICY.rpId,
  origin_hash: POLICY.originHash,
  challenge_hash: H("registration-challenge"),
  expires_at: LATER,
  kind: "registration",
  require_user_verification: true,
  attestation_policy: "none",
  ...overrides,
});

const verifiedRegistration = (overrides: Record<string, unknown> = {}) => ({
  credential: {
    credential_id: "credential_1",
    public_key: PUBLIC_KEY,
    sign_count: "0",
    counter_supported: false,
    user_verified: true,
    backup_eligible: false,
    backed_up: false,
    device_type: "single_device",
    attestation_assurance: "none",
    transports: ["internal"],
  },
  evidence: {
    schema_version: "cashloom.webauthn-registration-evidence/1",
    ceremony_id: "registration-1",
    credential_id: "credential_1",
    rp_id: POLICY.rpId,
    origin_hash: POLICY.originHash,
    attestation_object_hash: H("attestation"),
    client_data_hash: H("client-data"),
    user_present: true,
    user_verified: true,
    verified_at: NOW().toISOString(),
  },
  ...overrides,
});

const register = (store: WalletIntegrationStore): void => {
  const ceremony = registrationCeremony();
  store.createWebAuthnCeremony(ceremony);
  store.consumeVerifiedWebAuthnRegistration({ ceremony, registration: verifiedRegistration() });
};

const assertionCeremony = (input: { id: string; prior: string; challenge?: string }) => ({
  schema_version: "cashloom.webauthn-assertion/1",
  ceremony_id: input.id,
  signer_id: "signer-1",
  account_id: account,
  credential_id: "credential_1",
  rp_id: POLICY.rpId,
  origin_hash: POLICY.originHash,
  challenge_hash: H(input.challenge ?? `${input.id}-challenge`),
  expires_at: LATER,
  kind: "assertion",
  authorization: {
    authorization_id: `${input.id}-authorization`,
    intent_hash: H(`${input.id}-intent`),
    request_hash: H(`${input.id}-request`),
    expires_at: LATER,
  },
  require_user_presence: true,
  require_user_verification: true,
  prior_sign_count: input.prior,
});

const assertionEvidence = (ceremonyId: string, signCount: string) => ({
  schema_version: "cashloom.webauthn-evidence/1",
  ceremony_id: ceremonyId,
  credential_id: "credential_1",
  rp_id: POLICY.rpId,
  origin_hash: POLICY.originHash,
  user_present: true,
  user_verified: true,
  sign_count: signCount,
  authenticator_data_hash: H(`${ceremonyId}-data`),
  signature_hash: H(`${ceremonyId}-signature`),
  verified_at: NOW().toISOString(),
} as const);

const hardwareHandoff = (suffix = "1") => {
  const request = {
    schema_version: "cashloom.sign-request/1",
    request_id: `sign-request-${suffix}`,
    intent_hash: H(`hardware-intent-${suffix}`),
    authorization_id: `hardware-authorization-${suffix}`,
    expires_at: LATER,
    kind: "evm-transaction",
    chain_id: "eip155:8453",
    signer_account_id: account,
    to_account_id: "eip155:8453:0x2222222222222222222222222222222222222222",
    nonce: "1",
    value_atomic: "1",
    data: "0x",
    gas_limit: "21000",
    fee: { kind: "eip1559", max_fee_per_gas_atomic: "2", max_priority_fee_per_gas_atomic: "1" },
  } as const;
  const requestHash = hashBoundSignRequest(request);
  return {
    schema_version: "cashloom.hardware-signing-handoff/1",
    handoff_id: `handoff-${suffix}`,
    signer_id: "signer-1",
    device_binding_hash: H("device"),
    transport: "usb",
    authorization: {
      authorization_id: request.authorization_id,
      intent_hash: request.intent_hash,
      request_hash: requestHash,
      expires_at: LATER,
    },
    request,
    request_hash: requestHash,
    expires_at: LATER,
  } as const;
};

const ercRequest = (requestId = "userop-1") => {
  const operation = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: "1",
    init_code: "0x",
    factory: null,
    factory_data_hash: null,
    call_data: "0x",
    call_data_hash: hashHexData("0x"),
    account_gas_limits: `0x${"2".padStart(32, "0")}${"3".padStart(32, "0")}`,
    call_gas_limit: "3",
    verification_gas_limit: "2",
    pre_verification_gas: "4",
    gas_fees: `0x${"5".padStart(32, "0")}${"6".padStart(32, "0")}`,
    max_fee_per_gas: "6",
    max_priority_fee_per_gas: "5",
    paymaster_and_data: "0x",
    paymaster: null,
    paymaster_verification_gas_limit: null,
    paymaster_post_op_gas_limit: null,
    paymaster_data_hash: null,
    signature: "0x",
  } as const;
  const raw = {
    schema_version: "cashloom.erc4337-userop/0.7",
    request_id: requestId,
    intent_hash: H("erc-intent"),
    authorization: {
      authorization_id: "erc-authorization-1",
      intent_hash: H("erc-intent"),
      request_hash: H("placeholder"),
      expires_at: LATER,
    },
    chain_id: "eip155:8453",
    entry_point: "0x3333333333333333333333333333333333333333",
    account_id: account,
    nonce_key: "0",
    nonce_sequence: "1",
    user_operation: operation,
    user_operation_binding_hash: H("placeholder"),
    expires_at: LATER,
  } as const;
  const bindingHash = hashErc4337UserOperationBinding(raw);
  return {
    ...raw,
    authorization: { ...raw.authorization, request_hash: bindingHash },
    user_operation_binding_hash: bindingHash,
  };
};

const redirectBinding = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "cashloom.fiat-redirect-binding/1",
  flow_id: "flow-1",
  provider_id: "provider-1",
  issuer_hash: H("issuer"),
  redirect_uri_hash: H("redirect"),
  state_hash: H("state"),
  pkce_verifier_hash: H("pkce"),
  expires_at: LATER,
  ...overrides,
});

const fiatAuthorization = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "cashloom.regulated-fiat-payment-authorization/1",
  authorization_id: "fiat-auth-1",
  intent_hash: H("fiat-intent"),
  provider_id: "provider-1",
  connection_id: "connection-1",
  provider_account_ref_hash: H("account"),
  beneficiary_ref_hash: H("beneficiary"),
  amount: { asset: { kind: "fiat", currency: "USD" }, atomic: "1" },
  provider_idempotency_key_hash: H("idem"),
  redirect_flow_id: "flow-1",
  expires_at: LATER,
  ...overrides,
});

describe("WalletIntegrationStore", () => {
  it("requires core schema and refuses WebAuthn operations without an exact fixed RP/origin policy", () => {
    const raw = new Database(":memory:");
    open.push(raw);
    expect(() => new WalletIntegrationStore(raw)).toThrow("core schema");

    const { store } = setup({ policy: false });
    project(store, "WEBAUTHN", true);
    expect(() => store.createWebAuthnCeremony(registrationCeremony())).toThrow("WEBAUTHN_POLICY_REFUSED");

    const configured = setup();
    project(configured.store, "WEBAUTHN", true);
    expect(() => configured.store.createWebAuthnCeremony(registrationCeremony({ rp_id: "com" }))).toThrow("WEBAUTHN_POLICY_REFUSED");
    expect(() => configured.store.createWebAuthnCeremony(registrationCeremony({ origin_hash: H("foreign-origin") }))).toThrow("WEBAUTHN_POLICY_REFUSED");
  });

  it("atomically consumes registration, derives the durable public-key hash, and retains immutable evidence", () => {
    const { db, store } = setup();
    project(store, "WEBAUTHN", true);
    const ceremony = registrationCeremony();
    store.createWebAuthnCeremony(ceremony);
    const credential = store.consumeVerifiedWebAuthnRegistration({ ceremony, registration: verifiedRegistration() });

    expect(credential.public_key).toBe(PUBLIC_KEY);
    expect(credential.public_key_hash).toBe(hashHexData(PUBLIC_KEY));
    expect(store.getWebAuthnCredential("credential_1").public_key).toBe(PUBLIC_KEY);
    expect(db.query("SELECT kind FROM wk_webauthn_evidence WHERE ceremony_id='registration-1'").get()).toEqual({ kind: "REGISTRATION" });
    expect(() => store.consumeVerifiedWebAuthnRegistration({ ceremony, registration: verifiedRegistration() })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
    expect(() => db.query("UPDATE wk_webauthn_credentials SET public_key_hash=? WHERE credential_id='credential_1'").run(H("attacker"))).toThrow("immutable");
    expect(() => db.query("DELETE FROM wk_webauthn_credentials WHERE credential_id='credential_1'").run()).toThrow("audit evidence");
    expect(() => db.query("DELETE FROM wk_webauthn_evidence WHERE ceremony_id='registration-1'").run()).toThrow("append-only");

    const secondCeremony = registrationCeremony({ ceremony_id: "registration-2", challenge_hash: H("registration-2-challenge") });
    const baseRegistration = verifiedRegistration();
    const foreignEvidence = {
      credential: { ...baseRegistration.credential, credential_id: "credential_2" },
      evidence: { ...baseRegistration.evidence, ceremony_id: "registration-2", credential_id: "credential_2", origin_hash: H("foreign-origin") },
    };
    store.createWebAuthnCeremony(secondCeremony);
    expect(() => store.consumeVerifiedWebAuthnRegistration({ ceremony: secondCeremony, registration: foreignEvidence })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
    expect(db.query("SELECT COUNT(*) count FROM wk_webauthn_credentials WHERE credential_id='credential_2'").get()).toEqual({ count: 0 });
    expect(db.query("SELECT status FROM wk_webauthn_ceremonies WHERE id='registration-2'").get()).toEqual({ status: "PENDING" });
  });

  it("binds every assertion field to the durable ceremony/key and consumes it once", () => {
    const { db, store } = setup();
    project(store, "WEBAUTHN", true);
    register(store);
    const ceremony = assertionCeremony({ id: "assertion-1", prior: "0" });
    store.createWebAuthnCeremony(ceremony);

    const wrongAuthorization = {
      ...ceremony,
      authorization: { ...ceremony.authorization, authorization_id: "foreign-authorization" },
    };
    expect(() => store.consumeVerifiedWebAuthnAssertion({ ceremony: wrongAuthorization, evidence: assertionEvidence("assertion-1", "0") })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
    store.consumeVerifiedWebAuthnAssertion({ ceremony, evidence: assertionEvidence("assertion-1", "0") });
    expect(() => store.consumeVerifiedWebAuthnAssertion({ ceremony, evidence: assertionEvidence("assertion-1", "0") })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
    expect(db.query("SELECT kind,sign_count FROM wk_webauthn_evidence WHERE ceremony_id='assertion-1'").get()).toEqual({ kind: "ASSERTION", sign_count: "0" });

    const wrongAccount = assertionCeremony({ id: "assertion-2", prior: "0" });
    expect(() => store.createWebAuthnCeremony({ ...wrongAccount, account_id: "eip155:8453:0x2222222222222222222222222222222222222222" })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
  });

  it("allows all-zero authenticators until a nonzero counter appears, then rejects zero and rollback", () => {
    const { db, store } = setup();
    project(store, "WEBAUTHN", true);
    register(store);

    const zero = assertionCeremony({ id: "zero-1", prior: "0" });
    store.createWebAuthnCeremony(zero);
    store.consumeVerifiedWebAuthnAssertion({ ceremony: zero, evidence: assertionEvidence("zero-1", "0") });

    const startsCounting = assertionCeremony({ id: "zero-2", prior: "0" });
    store.createWebAuthnCeremony(startsCounting);
    store.consumeVerifiedWebAuthnAssertion({ ceremony: startsCounting, evidence: assertionEvidence("zero-2", "2") });
    expect(store.getWebAuthnCredential("credential_1").sign_count).toBe("2");

    const rollback = assertionCeremony({ id: "zero-3", prior: "2" });
    store.createWebAuthnCeremony(rollback);
    expect(() => store.consumeVerifiedWebAuthnAssertion({ ceremony: rollback, evidence: assertionEvidence("zero-3", "0") })).toThrow("WEBAUTHN_COUNTER_REFUSED");
    expect(() => db.query("UPDATE wk_webauthn_credentials SET sign_count='1' WHERE credential_id='credential_1'").run()).toThrow("cannot decrease");
  });

  it("uses strict per-kind interaction projections and never persists arbitrary event data", () => {
    const { db, store } = setup();
    project(store, "HARDWARE", true);
    const handoff = hardwareHandoff();
    expect(() => store.createInteraction({
      id: "interaction-bad",
      connectionId: "connection-1",
      signerId: "signer-1",
      kind: "hardware",
      intentHash: handoff.authorization.intent_hash,
      requestHash: handoff.request_hash,
      binding: { ...handoff, memo: "innocent-key-secret-value" },
      expiresAt: LATER,
    })).toThrow();

    store.createInteraction({
      id: "interaction-1",
      connectionId: "connection-1",
      signerId: "signer-1",
      kind: "hardware",
      intentHash: handoff.authorization.intent_hash,
      requestHash: handoff.request_hash,
      binding: handoff,
      expiresAt: LATER,
    });
    store.appendVerifiedInteractionEventEvidence({
      id: "event-1",
      interactionId: "interaction-1",
      sequence: 0,
      eventType: "HARDWARE_VERIFIED",
      resultHash: H("verified"),
      occurredAt: NOW().toISOString(),
      note: "must-not-persist",
    } as Parameters<typeof store.appendVerifiedInteractionEventEvidence>[0]);
    expect(db.query("SELECT data_json FROM wk_integration_interaction_events WHERE id='event-1'").get()).toEqual({ data_json: "{}" });
    expect(() => store.appendVerifiedInteractionEventEvidence({ id: "event-wrong-kind", interactionId: "interaction-1", sequence: 1, eventType: "WALLETCONNECT_VERIFIED", resultHash: H("wrong"), occurredAt: NOW().toISOString() })).toThrow("INTERACTION_EVENT_REFUSED");
    expect(JSON.stringify(db.query("SELECT binding_json FROM wk_integration_interactions WHERE id='interaction-1'").get())).not.toContain("gas_limit");
    expect(() => db.query("DELETE FROM wk_integration_interactions WHERE id='interaction-1'").run()).toThrow("audit evidence");
  });

  it("gates WalletConnect sessions by active kind, expiry, namespaces, and immutable identity", () => {
    const wrong = setup();
    project(wrong.store, "FIAT");
    const session = {
      schema_version: "cashloom.walletconnect-session/2",
      session_id: "session-1",
      peer_public_key_hash: H("peer"),
      namespaces: [{ chain_id: "eip155:8453", accounts: [account], methods: ["eth_signTransaction"], events: [] }],
      expires_at: LATER,
    } as const;
    expect(() => wrong.store.putWalletConnectSession(session, "connection-1")).toThrow("WALLETCONNECT_SESSION_REFUSED");

    const { db, store } = setup();
    project(store, "WALLETCONNECT");
    store.putWalletConnectSession(session, "connection-1");
    const request = {
      schema_version: "cashloom.walletconnect-request/2",
      session_id: "session-1",
      request_id: "wc-request-1",
      chain_id: "eip155:8453",
      account_id: account,
      method: "eth_signTransaction",
      params_hash: H("params"),
      authorization: { authorization_id: "wc-auth-1", intent_hash: H("wc-intent"), request_hash: H("wc-request"), expires_at: LATER },
      request_hash: H("wc-request"),
      expires_at: LATER,
    } as const;
    const externalTxId = `0x${"ab".repeat(32)}` as const;
    const sessionHash = (db.query("SELECT binding_hash FROM wk_walletconnect_sessions WHERE session_id='session-1'").get() as { binding_hash: ReturnType<typeof H> }).binding_hash;
    const guardFor = (requestId: string, bindingHash: string) => ({
      policy: "ACTIVE_SESSION_PENDING_REQUEST_ARTIFACT_CAS",
      session_id: "session-1",
      session_binding_hash: bindingHash,
      expected_session_status: "ACTIVE",
      request_id: requestId,
      expected_request_status: "PENDING",
      expected_request_version: 0,
      request_hash: H("wc-request"),
      params_hash: H("params"),
      authorization_id: "wc-auth-1",
      external_tx_id: externalTxId,
    } as const);
    store.createInteraction({ id: "wc-interaction-1", connectionId: "connection-1", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), binding: request, expiresAt: LATER });
    expect(() => store.createInteraction({ id: "wc-interaction-2", connectionId: "connection-1", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), binding: { ...request, method: "eth_signTypedData_v4" }, expiresAt: LATER })).toThrow("INTERACTION_BINDING_REFUSED");
    expect(() => db.query("UPDATE wk_walletconnect_sessions SET binding_hash=? WHERE session_id='session-1'").run(H("mutated"))).toThrow("immutable");
    expect(() => db.query("DELETE FROM wk_walletconnect_sessions WHERE session_id='session-1'").run()).toThrow("audit evidence");

    expect(() => store.persistVerifiedExternalArtifact({ interactionId: "wc-interaction-1", expectedVersion: 0, eventId: "wc-missing-guard-event", artifactId: "wc-missing-guard-artifact", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), artifactHash: H("wc-artifact"), externalIdHash: hashHexData(externalTxId) })).toThrow("WALLETCONNECT_PERSISTENCE_GUARD_REFUSED");
    expect(() => store.persistVerifiedExternalArtifact({ interactionId: "wc-interaction-1", expectedVersion: 0, eventId: "wc-wrong-guard-event", artifactId: "wc-wrong-guard-artifact", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), artifactHash: H("wc-artifact"), externalIdHash: hashHexData(externalTxId), walletConnectGuard: { ...guardFor("wc-request-1", sessionHash), session_binding_hash: H("wrong-session") } })).toThrow("INTERACTION_COMPARE_AND_SET_FAILED");
    expect(db.query("SELECT status FROM wk_integration_interactions WHERE id='wc-interaction-1'").get()).toEqual({ status: "PENDING" });
    store.persistVerifiedExternalArtifact({ interactionId: "wc-interaction-1", expectedVersion: 0, eventId: "wc-live-event", artifactId: "wc-live-artifact", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), artifactHash: H("wc-artifact"), externalIdHash: hashHexData(externalTxId), walletConnectGuard: guardFor("wc-request-1", sessionHash) });
    const pendingRequest = { ...request, request_id: "wc-request-pending" } as const;
    store.createInteraction({ id: "wc-pending-after-revoke", connectionId: "connection-1", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), binding: pendingRequest, expiresAt: LATER });
    store.revokeWalletConnectSession("session-1");
    expect(db.query("SELECT status FROM wk_integration_interactions WHERE id='wc-pending-after-revoke'").get()).toEqual({ status: "REVOKED" });
    expect(() => store.persistVerifiedExternalArtifact({ interactionId: "wc-pending-after-revoke", expectedVersion: 1, eventId: "wc-revoked-event", artifactId: "wc-revoked-artifact", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), artifactHash: H("wc-revoked"), externalIdHash: hashHexData(externalTxId), walletConnectGuard: { ...guardFor("wc-request-pending", sessionHash), expected_request_version: 1 } })).toThrow("INTERACTION_COMPARE_AND_SET_FAILED");
    expect(db.query("SELECT COUNT(*) count FROM wk_external_artifacts WHERE id='wc-revoked-artifact'").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) count FROM wk_integration_interaction_events WHERE id='wc-revoked-event'").get()).toEqual({ count: 0 });
    expect(() => store.createInteraction({ id: "wc-interaction-3", connectionId: "connection-1", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), binding: { ...request, request_id: "wc-request-3" }, expiresAt: LATER })).toThrow("INTERACTION_BINDING_REFUSED");

    let clock = NOW();
    const expired = setup({ now: () => clock });
    project(expired.store, "WALLETCONNECT");
    expired.store.putWalletConnectSession(session, "connection-1");
    const expiredSessionHash = (expired.db.query("SELECT binding_hash FROM wk_walletconnect_sessions WHERE session_id='session-1'").get() as { binding_hash: string }).binding_hash;
    expired.store.createInteraction({ id: "wc-expiring", connectionId: "connection-1", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), binding: request, expiresAt: LATER });
    clock = new Date(AFTER);
    expect(() => expired.store.persistVerifiedExternalArtifact({ interactionId: "wc-expiring", expectedVersion: 0, eventId: "wc-expired-event", artifactId: "wc-expired-artifact", kind: "walletconnect", intentHash: H("wc-intent"), requestHash: H("wc-request"), artifactHash: H("wc-expired"), externalIdHash: hashHexData(externalTxId), walletConnectGuard: guardFor("wc-request-1", expiredSessionHash) })).toThrow("INTERACTION_COMPARE_AND_SET_FAILED");
    expect(expired.db.query("SELECT COUNT(*) count FROM wk_external_artifacts").get()).toEqual({ count: 0 });
  });

  it("atomically gates new artifacts by live authority while retaining verified late evidence after revocation", () => {
    const { db, store } = setup();
    project(store, "HARDWARE", true);
    const handoff = hardwareHandoff("artifact");
    store.createInteraction({ id: "artifact-interaction", connectionId: "connection-1", signerId: "signer-1", kind: "hardware", intentHash: handoff.authorization.intent_hash, requestHash: handoff.request_hash, binding: handoff, expiresAt: LATER });
    store.persistVerifiedExternalArtifact({ interactionId: "artifact-interaction", expectedVersion: 0, eventId: "artifact-event", artifactId: "artifact-1", kind: "hardware", intentHash: handoff.authorization.intent_hash, requestHash: handoff.request_hash, artifactHash: H("artifact") });
    expect(db.query("SELECT status FROM wk_integration_interactions WHERE id='artifact-interaction'").get()).toEqual({ status: "COMPLETED" });

    const late = hardwareHandoff("late");
    store.createInteraction({ id: "late-interaction", connectionId: "connection-1", signerId: "signer-1", kind: "hardware", intentHash: late.authorization.intent_hash, requestHash: late.request_hash, binding: late, expiresAt: LATER });
    store.transitionConnection({ connectionId: "connection-1", expectedVersion: 0, status: "REVOKED" });
    expect(() => store.persistVerifiedExternalArtifact({ interactionId: "late-interaction", expectedVersion: 1, eventId: "late-event", artifactId: "late-artifact", kind: "hardware", intentHash: late.authorization.intent_hash, requestHash: late.request_hash, artifactHash: H("late-artifact") })).toThrow("INTERACTION_COMPARE_AND_SET_FAILED");
    store.importVerifiedExternalArtifactEvidence({ id: "late-artifact", interactionId: "late-interaction", kind: "hardware", intentHash: late.authorization.intent_hash, requestHash: late.request_hash, artifactHash: H("late-artifact") });
    expect(db.query("SELECT COUNT(*) count FROM wk_external_artifacts").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) count FROM wk_late_external_artifact_evidence").get()).toEqual({ count: 1 });
    expect(() => db.query("UPDATE wk_late_external_artifact_evidence SET artifact_hash=? WHERE id='late-artifact'").run(H("mutated"))).toThrow("append-only");
  });

  it("permanently claims ERC-4337 nonces and makes the nonce/binding tuple immutable", () => {
    const { db, store } = setup();
    project(store, "ERC4337");
    const operation = ercRequest();
    expect(() => store.createInteraction({ id: "erc-bad", connectionId: "connection-1", kind: "erc4337", intentHash: H("erc-intent"), requestHash: operation.authorization.request_hash, binding: { binding_hash: operation.user_operation_binding_hash, note: "secret" }, expiresAt: LATER })).toThrow();
    store.createInteraction({ id: "erc-interaction", connectionId: "connection-1", kind: "erc4337", intentHash: H("erc-intent"), requestHash: operation.authorization.request_hash, binding: { binding_hash: operation.user_operation_binding_hash }, expiresAt: LATER });
    store.createErc4337Operation(operation, "erc-interaction");
    expect(() => db.query("UPDATE wk_erc4337_operations SET nonce_sequence='2' WHERE id='userop-1'").run()).toThrow("immutable");
    expect(() => db.query("UPDATE wk_erc4337_operations SET binding_hash=? WHERE id='userop-1'").run(H("mutated"))).toThrow("immutable");
    expect(() => db.query("UPDATE wk_erc4337_operations SET status='SETTLED' WHERE id='userop-1'").run()).toThrow("transition refused");
    store.transitionErc4337Operation({ id: "userop-1", from: "PREPARED", to: "SIGNED" });
    store.transitionErc4337Operation({ id: "userop-1", from: "SIGNED", to: "SUBMITTED" });
    expect(() => store.transitionErc4337Operation({ id: "userop-1", from: "SUBMITTED", to: "SETTLED" })).toThrow("ERC4337_TRANSITION_REFUSED");
    store.transitionErc4337Operation({ id: "userop-1", from: "SUBMITTED", to: "AMBIGUOUS" });
    expect(() => store.transitionErc4337Operation({ id: "userop-1", from: "AMBIGUOUS", to: "SETTLED" })).toThrow("ERC4337_TRANSITION_REFUSED");
    expect(() => db.query("DELETE FROM wk_erc4337_operations WHERE id='userop-1'").run()).toThrow("permanent");
  });

  it("claims an ERC-4337 nonce across independent SQLite connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "cashloom-integration-"));
    dirs.push(dir);
    const path = join(dir, "wallet.db");
    const first = new Database(path);
    const second = new Database(path);
    open.push(first, second);
    new WalletKernelStore(first);
    seed(first);
    const one = new WalletIntegrationStore(first, { now: NOW });
    const two = new WalletIntegrationStore(second, { now: NOW });
    project(one, "ERC4337");
    const request = ercRequest();
    for (const [store, interactionId] of [[one, "interaction-1"], [two, "interaction-2"]] as const) {
      store.createInteraction({ id: interactionId, connectionId: "connection-1", kind: "erc4337", intentHash: H("erc-intent"), requestHash: request.authorization.request_hash, binding: { binding_hash: request.user_operation_binding_hash }, expiresAt: LATER });
    }
    one.createErc4337Operation(request, "interaction-1");
    expect(() => two.createErc4337Operation(ercRequest("userop-2"), "interaction-2")).toThrow();
  });

  it("binds fiat consent, redirect, payee, connection, provider, and idempotency before I/O", () => {
    const { db, store } = setup();
    project(store, "FIAT");
    store.createFiatConsent({ id: "consent-1", connectionId: "connection-1", providerId: "provider-1", consentRefHash: H("consent"), accountRefHash: H("account"), expiresAt: AFTER });
    expect(() => store.createFiatAuthorizationSession(redirectBinding({ provider_id: "provider-2" }), "consent-1")).toThrow("FIAT_AUTHORIZATION_SESSION_REFUSED");
    const redirect = redirectBinding();
    store.createFiatAuthorizationSession(redirect, "consent-1");
    expect(() => store.consumeFiatAuthorizationSession({ ...redirect, state_hash: H("wrong-state") }, "consent-1")).toThrow("FIAT_AUTHORIZATION_SESSION_REFUSED");
    store.consumeFiatAuthorizationSession(redirect, "consent-1");
    expect(() => store.consumeFiatAuthorizationSession(redirect, "consent-1")).toThrow("FIAT_AUTHORIZATION_SESSION_REFUSED");
    expect(() => db.query("DELETE FROM wk_fiat_authorization_sessions WHERE id='flow-1'").run()).toThrow("audit evidence");

    store.putFiatPayee({ id: "payee-1", consentId: "consent-1", beneficiaryRefHash: H("beneficiary") });
    const authorization = fiatAuthorization();
    const prepared = store.prepareFiatRequestAttempt({ id: "attempt-1", consentId: "consent-1", payeeId: "payee-1", authorization });
    expect(prepared).toEqual({ attemptId: "attempt-1", created: true });
    expect(db.query("SELECT outcome FROM wk_fiat_request_attempts WHERE id='attempt-1'").get()).toEqual({ outcome: "PREPARED" });
    expect(db.query("SELECT COUNT(*) count FROM wk_fiat_request_outcomes").get()).toEqual({ count: 0 });
    expect(store.prepareFiatRequestAttempt({ id: "different-id", consentId: "consent-1", payeeId: "payee-1", authorization })).toEqual({ attemptId: "attempt-1", created: false });
    expect(() => store.prepareFiatRequestAttempt({ id: "conflict", consentId: "consent-1", payeeId: "payee-1", authorization: fiatAuthorization({ amount: { asset: { kind: "fiat", currency: "USD" }, atomic: "2" } }) })).toThrow("FIAT_IDEMPOTENCY_CONFLICT");
    expect(() => store.appendFiatRequestAttempt({ id: "terminal", consentId: "consent-1", payeeId: "payee-1", authorization, outcome: "SETTLED" as "PREPARED" })).toThrow("FIAT_DIRECT_OUTCOME_REFUSED");
    expect(() => db.query("UPDATE wk_fiat_request_attempts SET outcome='SETTLED' WHERE id='attempt-1'").run()).toThrow("immutable");
  });

  it("appends only nonterminal transport outcomes and keeps terminal observer evidence separate and sanitized", () => {
    const { db, store } = setup();
    project(store, "FIAT");
    store.createFiatConsent({ id: "consent-1", connectionId: "connection-1", providerId: "provider-1", consentRefHash: H("consent"), accountRefHash: H("account"), expiresAt: AFTER });
    const redirect = redirectBinding();
    store.createFiatAuthorizationSession(redirect, "consent-1");
    store.consumeFiatAuthorizationSession(redirect, "consent-1");
    store.putFiatPayee({ id: "payee-1", consentId: "consent-1", beneficiaryRefHash: H("beneficiary") });
    store.prepareFiatRequestAttempt({ id: "attempt-1", consentId: "consent-1", payeeId: "payee-1", authorization: fiatAuthorization() });

    expect(() => store.appendFiatTransportOutcomeEvidence({ id: "terminal", attemptId: "attempt-1", sequence: 0, outcome: "SETTLED" as "SUBMITTED", responseHash: H("response"), providerPaymentRefHash: H("payment-1"), occurredAt: NOW().toISOString() })).toThrow("FIAT_DIRECT_OUTCOME_REFUSED");
    store.appendFiatTransportOutcomeEvidence({ id: "outcome-1", attemptId: "attempt-1", sequence: 0, outcome: "SUBMITTED", responseHash: H("response"), providerPaymentRefHash: hashUtf8("payment-1"), occurredAt: NOW().toISOString() });
    expect(db.query("SELECT outcome FROM wk_fiat_request_attempts WHERE id='attempt-1'").get()).toEqual({ outcome: "PREPARED" });
    expect(db.query("SELECT outcome FROM wk_fiat_request_outcomes WHERE id='outcome-1'").get()).toEqual({ outcome: "SUBMITTED" });

    const evidence = {
      schema_version: "cashloom.fiat-webhook-evidence/1",
      provider_id: "provider-1",
      delivery_id: "delivery-1",
      event_type: "payment.settled",
      provider_payment_ref: "payment-1",
      payload_hash: H("payload"),
      signature_key_id: "kid-1",
      signature_hash: H("signature"),
      occurred_at: NOW().toISOString(),
      received_at: LATER,
      state: "settled",
    } as const;
    expect(() => store.importVerifiedFiatWebhookEvidence({ ...evidence, provider_payment_ref: "payment-2" }, "webhook-wrong", "attempt-1")).toThrow("FIAT_WEBHOOK_BINDING_REFUSED");
    store.importVerifiedFiatWebhookEvidence(evidence, "webhook-1", "attempt-1");
    const stored = JSON.stringify(db.query("SELECT * FROM wk_fiat_webhook_evidence WHERE id='webhook-1'").get());
    expect(stored).not.toContain("payment-1");
    expect(stored).toContain(hashUtf8("payment-1"));
    expect(() => store.importVerifiedFiatWebhookEvidence({ ...evidence, payload_hash: H("altered-payload") }, "webhook-replay", "attempt-1")).toThrow();
    expect(() => db.query("DELETE FROM wk_fiat_webhook_evidence WHERE id='webhook-1'").run()).toThrow("append-only");
    expect(() => db.query("UPDATE wk_fiat_request_outcomes SET outcome='AMBIGUOUS' WHERE id='outcome-1'").run()).toThrow("append-only");
  });

  it("cascades signer revocation through credentials, ceremonies, and pending interactions", () => {
    const { db, store } = setup();
    project(store, "WEBAUTHN", true);
    register(store);
    const pending = assertionCeremony({ id: "signer-pending", prior: "0" });
    store.createWebAuthnCeremony(pending);
    store.transitionSigner({ signerId: "signer-1", expectedVersion: 0, status: "REVOKED" });
    expect(db.query("SELECT status FROM wk_integration_signers WHERE signer_id='signer-1'").get()).toEqual({ status: "REVOKED" });
    expect(db.query("SELECT status FROM wk_webauthn_credentials WHERE credential_id='credential_1'").get()).toEqual({ status: "REVOKED" });
    expect(db.query("SELECT status FROM wk_webauthn_ceremonies WHERE id='signer-pending'").get()).toEqual({ status: "REVOKED" });
    expect(() => db.query("DELETE FROM wk_integration_signers WHERE signer_id='signer-1'").run()).toThrow("authority evidence");
  });

  it("cascades connection revocation and makes every active operation fail closed", () => {
    const webAuthn = setup();
    project(webAuthn.store, "WEBAUTHN", true);
    register(webAuthn.store);
    const pending = assertionCeremony({ id: "pending-assertion", prior: "0" });
    webAuthn.store.createWebAuthnCeremony(pending);
    webAuthn.store.transitionConnection({ connectionId: "connection-1", expectedVersion: 0, status: "REVOKED" });
    expect(webAuthn.db.query("SELECT status FROM wk_integration_signers WHERE signer_id='signer-1'").get()).toEqual({ status: "REVOKED" });
    expect(webAuthn.db.query("SELECT status FROM wk_webauthn_credentials WHERE credential_id='credential_1'").get()).toEqual({ status: "REVOKED" });
    expect(webAuthn.db.query("SELECT status FROM wk_webauthn_ceremonies WHERE id='pending-assertion'").get()).toEqual({ status: "REVOKED" });
    expect(() => webAuthn.store.getWebAuthnCredential("credential_1")).toThrow("WEBAUTHN_CREDENTIAL_REFUSED");
    expect(() => webAuthn.store.consumeVerifiedWebAuthnAssertion({ ceremony: pending, evidence: assertionEvidence("pending-assertion", "0") })).toThrow("WEBAUTHN_CEREMONY_REFUSED");
    expect(() => webAuthn.db.query("DELETE FROM wk_integration_connections WHERE connection_id='connection-1'").run()).toThrow("authority evidence");

    const fiat = setup();
    project(fiat.store, "FIAT");
    fiat.store.createFiatConsent({ id: "consent-1", connectionId: "connection-1", providerId: "provider-1", consentRefHash: H("consent"), accountRefHash: H("account"), expiresAt: AFTER });
    fiat.store.createFiatAuthorizationSession(redirectBinding(), "consent-1");
    fiat.store.putFiatPayee({ id: "payee-1", consentId: "consent-1", beneficiaryRefHash: H("beneficiary") });
    const { redirect_flow_id: _unusedRedirect, ...directAuthorization } = fiatAuthorization();
    fiat.store.prepareFiatRequestAttempt({ id: "started-attempt", consentId: "consent-1", payeeId: "payee-1", authorization: directAuthorization });
    fiat.store.transitionConnection({ connectionId: "connection-1", expectedVersion: 0, status: "REVOKED" });
    expect(fiat.db.query("SELECT status FROM wk_fiat_consents WHERE id='consent-1'").get()).toEqual({ status: "REVOKED" });
    expect(fiat.db.query("SELECT status FROM wk_fiat_authorization_sessions WHERE id='flow-1'").get()).toEqual({ status: "REVOKED" });
    expect(fiat.db.query("SELECT status FROM wk_fiat_payees WHERE id='payee-1'").get()).toEqual({ status: "REVOKED" });
    expect(() => fiat.db.query("DELETE FROM wk_fiat_consents WHERE id='consent-1'").run()).toThrow("authority evidence");
    expect(() => fiat.store.consumeFiatAuthorizationSession(redirectBinding(), "consent-1")).toThrow("FIAT_AUTHORIZATION_SESSION_REFUSED");
    expect(() => fiat.store.prepareFiatRequestAttempt({ id: "attempt", consentId: "consent-1", payeeId: "payee-1", authorization: fiatAuthorization() })).toThrow("FIAT_ATTEMPT_BINDING_REFUSED");
    fiat.store.appendFiatTransportOutcomeEvidence({ id: "late-ambiguous", attemptId: "started-attempt", sequence: 0, outcome: "AMBIGUOUS", responseHash: H("timeout"), occurredAt: NOW().toISOString() });
    expect(fiat.db.query("SELECT outcome FROM wk_fiat_request_outcomes WHERE id='late-ambiguous'").get()).toEqual({ outcome: "AMBIGUOUS" });
  });
});
