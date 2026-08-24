import { describe, expect, test } from "bun:test";
import { keccak256, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  boundSignRequestSchema,
  hashBoundSignRequest,
  type EvmTransactionSignRequest,
} from "../domain/signing.ts";
import type { JsonValue } from "../domain/intent.ts";
import {
  IntegrationContractError,
  hashCanonicalContract,
  hashUtf8,
  walletConnectRequestBindingSchema,
  walletConnectSessionBindingSchema,
} from "../integrations/index.ts";
import {
  hashWalletConnectTransactionParams,
  verifyWalletConnectEvmSignedTransaction,
  walletConnectProviderEvidenceSchema,
  walletConnectRequestStateSchema,
  walletConnectSessionStateSchema,
  type WalletConnectProviderEvidence,
} from "./walletconnect-verifier.ts";

const PRIVATE_KEY = `0x${"03".repeat(32)}` as const;
const signer = privateKeyToAccount(PRIVATE_KEY);
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const OTHER_RECIPIENT = "0x4444444444444444444444444444444444444444" as const;
const NOW = new Date("2029-12-31T23:50:00.000Z");
const REQUEST_EXPIRES = "2030-01-01T00:00:00.000Z";
const SESSION_EXPIRES = "2030-01-01T01:00:00.000Z";
const ACCOUNT = `eip155:8453:${signer.address.toLowerCase()}` as const;

const preparedRequest = boundSignRequestSchema.parse({
  schema_version: "cashloom.sign-request/1",
  request_id: "prepared-request-1",
  intent_hash: hashUtf8("walletconnect-intent"),
  authorization_id: "walletconnect-authorization-1",
  expires_at: REQUEST_EXPIRES,
  kind: "evm-transaction",
  chain_id: "eip155:8453",
  signer_account_id: ACCOUNT,
  to_account_id: `eip155:8453:${RECIPIENT}`,
  nonce: "4",
  value_atomic: "19",
  data: "0x",
  gas_limit: "21000",
  fee: {
    kind: "eip1559",
    max_fee_per_gas_atomic: "3000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
}) as EvmTransactionSignRequest;

const transactionFor = (): TransactionSerializableEIP1559 => ({
  type: "eip1559",
  chainId: 8453,
  nonce: 4,
  to: RECIPIENT,
  value: 19n,
  data: "0x",
  gas: 21000n,
  maxFeePerGas: 3000000000n,
  maxPriorityFeePerGas: 1000000000n,
  accessList: [],
});

const sign = (overrides: Partial<TransactionSerializableEIP1559> = {}) =>
  signer.signTransaction({ ...transactionFor(), ...overrides });

const fixture = async () => {
  const requestHash = hashBoundSignRequest(preparedRequest);
  const paramsHash = hashWalletConnectTransactionParams(preparedRequest);
  const session = walletConnectSessionBindingSchema.parse({
    schema_version: "cashloom.walletconnect-session/2",
    session_id: "walletconnect-session-1",
    peer_public_key_hash: hashUtf8("walletconnect-peer-public-key"),
    namespaces: [{
      chain_id: "eip155:8453",
      accounts: [ACCOUNT],
      methods: ["eth_signTransaction"],
      events: ["accountsChanged", "chainChanged"],
    }],
    expires_at: SESSION_EXPIRES,
  });
  const sessionHash = hashCanonicalContract(session as unknown as JsonValue);
  const state = walletConnectSessionStateSchema.parse({
    session_id: session.session_id,
    binding_hash: sessionHash,
    status: "ACTIVE",
    expires_at: session.expires_at,
  });
  const request = walletConnectRequestBindingSchema.parse({
    schema_version: "cashloom.walletconnect-request/2",
    session_id: session.session_id,
    request_id: "walletconnect-provider-request-1",
    chain_id: "eip155:8453",
    account_id: ACCOUNT,
    method: "eth_signTransaction",
    params_hash: paramsHash,
    authorization: {
      authorization_id: preparedRequest.authorization_id,
      intent_hash: preparedRequest.intent_hash,
      request_hash: requestHash,
      expires_at: preparedRequest.expires_at,
    },
    request_hash: requestHash,
    expires_at: preparedRequest.expires_at,
  });
  const requestState = walletConnectRequestStateSchema.parse({
    session_id: session.session_id,
    request_id: request.request_id,
    request_hash: requestHash,
    params_hash: paramsHash,
    status: "PENDING",
    version: 3,
    expires_at: request.expires_at,
  });
  const raw = await sign();
  const evidence = walletConnectProviderEvidenceSchema.parse({
    schema_version: "cashloom.walletconnect-evidence/1",
    outcome: "SIGNED",
    session_id: session.session_id,
    request_id: request.request_id,
    session_binding_hash: sessionHash,
    peer_public_key_hash: session.peer_public_key_hash,
    authorization_id: preparedRequest.authorization_id,
    request_hash: requestHash,
    params_hash: paramsHash,
    chain_id: "eip155:8453",
    account_id: ACCOUNT,
    method: "eth_signTransaction",
    expires_at: preparedRequest.expires_at,
    serialized_transaction: raw,
    transaction_hash: keccak256(raw),
  }) as Extract<WalletConnectProviderEvidence, { outcome: "SIGNED" }>;
  return {
    session,
    sessionHash,
    state,
    request,
    requestState,
    requestHash,
    paramsHash,
    raw,
    evidence,
  };
};

const verify = async (
  overrides: Partial<Parameters<typeof verifyWalletConnectEvmSignedTransaction>[0]> = {},
) => {
  const value = await fixture();
  return verifyWalletConnectEvmSignedTransaction({
    session: value.session,
    session_state: value.state,
    request_state: value.requestState,
    request: value.request,
    prepared_request: preparedRequest,
    evidence: value.evidence,
    now: NOW,
    ...overrides,
  });
};

describe("WalletConnect Base EVM verifier", () => {
  test("accepts only an exact ACTIVE least-privilege session and freezes output", async () => {
    const value = await fixture();
    const artifact = await verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: value.requestState,
      request: value.request,
      prepared_request: preparedRequest,
      evidence: value.evidence,
      now: NOW,
    });

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact).toMatchObject({
      source: "walletconnect",
      session_id: value.session.session_id,
      walletconnect_request_id: value.request.request_id,
      session_binding_hash: value.sessionHash,
      authorization_id: preparedRequest.authorization_id,
      request_hash: value.requestHash,
      params_hash: value.paramsHash,
      chain_id: "eip155:8453",
      signer_account_id: ACCOUNT,
      encoding: "hex",
      payload: value.raw,
      external_tx_id: keccak256(value.raw),
      verified_at: NOW.toISOString(),
      persistence_guard: {
        policy: "ACTIVE_SESSION_PENDING_REQUEST_ARTIFACT_CAS",
        session_id: value.session.session_id,
        session_binding_hash: value.sessionHash,
        expected_session_status: "ACTIVE",
        request_id: value.request.request_id,
        expected_request_status: "PENDING",
        expected_request_version: 3,
        request_hash: value.requestHash,
        params_hash: value.paramsHash,
        authorization_id: preparedRequest.authorization_id,
        external_tx_id: keccak256(value.raw),
      },
    });
    expect(Object.isFrozen(artifact.persistence_guard)).toBe(true);
    expect(JSON.stringify(artifact)).not.toMatch(/wc:|topic|symkey|https?:\/\//i);
  });

  test("rejects transaction substitution after independently decoding raw bytes", async () => {
    const value = await fixture();
    const maliciousRaw = await sign({ to: OTHER_RECIPIENT });
    const evidence = walletConnectProviderEvidenceSchema.parse({
      ...value.evidence,
      serialized_transaction: maliciousRaw,
      transaction_hash: keccak256(maliciousRaw),
    });
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: value.requestState,
      request: value.request,
      prepared_request: preparedRequest,
      evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "integration_evidence_rejected" });
  });

  test("refuses changed, revoked, expired, or over-broad sessions", async () => {
    const value = await fixture();
    await expect(verify({
      session_state: { ...value.state, binding_hash: hashUtf8("changed-session") },
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });
    await expect(verify({
      session_state: { ...value.state, status: "REVOKED" },
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: value.requestState,
      request: value.request,
      prepared_request: preparedRequest,
      evidence: value.evidence,
      now: new Date(SESSION_EXPIRES),
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });

    const broadSession = walletConnectSessionBindingSchema.parse({
      ...value.session,
      namespaces: [{
        ...value.session.namespaces[0],
        methods: ["eth_signTransaction", "eth_sendTransaction"],
      }],
    });
    const broadHash = hashCanonicalContract(broadSession as unknown as JsonValue);
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: broadSession,
      session_state: {
        ...value.state,
        binding_hash: broadHash,
      },
      request_state: value.requestState,
      request: value.request,
      prepared_request: preparedRequest,
      evidence: {
        ...value.evidence,
        session_binding_hash: broadHash,
      },
      now: NOW,
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });

    const eventBlindSession = walletConnectSessionBindingSchema.parse({
      ...value.session,
      namespaces: [{ ...value.session.namespaces[0], events: [] }],
    });
    const eventBlindHash = hashCanonicalContract(
      eventBlindSession as unknown as JsonValue,
    );
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: eventBlindSession,
      session_state: { ...value.state, binding_hash: eventBlindHash },
      request_state: value.requestState,
      request: value.request,
      prepared_request: preparedRequest,
      evidence: { ...value.evidence, session_binding_hash: eventBlindHash },
      now: NOW,
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });
  });

  test("maps provider refusal/session lifecycle outcomes to one safe refusal", async () => {
    const value = await fixture();
    for (const outcome of ["REFUSED", "SESSION_CHANGED", "SESSION_REVOKED"] as const) {
      const evidence = walletConnectProviderEvidenceSchema.parse({
        schema_version: "cashloom.walletconnect-evidence/1",
        outcome,
        session_id: value.session.session_id,
        request_id: value.request.request_id,
      });
      await expect(verifyWalletConnectEvmSignedTransaction({
        session: value.session,
        session_state: value.state,
        request_state: value.requestState,
        request: value.request,
        prepared_request: preparedRequest,
        evidence,
        now: NOW,
      })).rejects.toMatchObject({ code: "walletconnect_session_refused" });
    }
  });

  test("requires a versioned PENDING request for atomic one-use persistence", async () => {
    const value = await fixture();
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: { ...value.requestState, status: "CONSUMED", version: 4 },
      request: value.request,
      prepared_request: preparedRequest,
      evidence: value.evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });

    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: {
        ...value.requestState,
        request_hash: hashUtf8("replayed-request-binding"),
      },
      request: value.request,
      prepared_request: preparedRequest,
      evidence: value.evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "walletconnect_session_refused" });
  });

  test("pins authorization, request/params hashes, account, method, and expiry", async () => {
    const value = await fixture();
    const mismatches: Partial<Extract<WalletConnectProviderEvidence, { outcome: "SIGNED" }>>[] = [
      { authorization_id: "other-authorization" },
      { request_hash: hashUtf8("other-request") },
      { params_hash: hashUtf8("other-params") },
      { account_id: `eip155:8453:${OTHER_RECIPIENT}` },
      { expires_at: "2029-12-31T23:59:00.000Z" },
    ];
    for (const mismatch of mismatches) {
      await expect(verifyWalletConnectEvmSignedTransaction({
        session: value.session,
        session_state: value.state,
        request_state: value.requestState,
        request: value.request,
        prepared_request: preparedRequest,
        evidence: { ...value.evidence, ...mismatch },
        now: NOW,
      })).rejects.toMatchObject({ code: "external_signer_mismatch" });
    }

    const alteredPrepared = boundSignRequestSchema.parse({
      ...preparedRequest,
      request_id: "prepared-request-replay",
    });
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.state,
      request_state: value.requestState,
      request: value.request,
      prepared_request: alteredPrepared,
      evidence: value.evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "external_signer_mismatch" });
  });

  test("strictly rejects and redacts URI, topic, symkey, and raw provider errors", async () => {
    const value = await fixture();
    const secret = "wc:topic@2?symKey=do-not-log";
    try {
      await verifyWalletConnectEvmSignedTransaction({
        session: value.session,
        session_state: value.state,
        request_state: value.requestState,
        request: value.request,
        prepared_request: preparedRequest,
        evidence: {
          ...value.evidence,
          topic: "secret-topic",
          symkey: "secret-symkey",
          provider_error: secret,
        } as unknown as WalletConnectProviderEvidence,
        now: NOW,
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationContractError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("secret-topic");
      expect(String(error)).not.toContain("secret-symkey");
    }
  });

  test("has no session SDK, custody, signer, sender, or broadcast dependency", async () => {
    const source = await Bun.file(
      new URL("./walletconnect-verifier.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/from\s+["'][^"']*(?:vault|senders?|pay|sign-client)[^"']*["']/);
    expect(source).not.toContain("sendRawTransaction");
    expect(source).not.toContain("confirmPayment");
    expect(source).not.toContain("resumePaymentBroadcast");
    expect(source).not.toContain("privateKeyToAccount");
  });
});
