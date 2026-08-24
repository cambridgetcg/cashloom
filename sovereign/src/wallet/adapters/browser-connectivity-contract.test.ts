import { describe, expect, test } from "bun:test";
import {
  keccak256,
  type TransactionSerializableEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  boundSignRequestSchema,
  hashBoundSignRequest,
  type EvmTransactionSignRequest,
} from "../domain/signing.ts";
import type { JsonValue } from "../domain/intent.ts";
import {
  hardwareSigningHandoffSchema,
  hashCanonicalContract,
  hashUtf8,
  walletConnectRequestBindingSchema,
  walletConnectSessionBindingSchema,
} from "../integrations/index.ts";
import {
  hardwareEvmProviderEvidenceSchema,
  verifyHardwareEvmSignedTransaction,
} from "./hardware-evm-verifier.ts";
import {
  hashWalletConnectTransactionParams,
  verifyWalletConnectEvmSignedTransaction,
  walletConnectProviderEvidenceSchema,
  walletConnectRequestStateSchema,
  walletConnectSessionStateSchema,
} from "./walletconnect-verifier.ts";

// Variable dynamic imports keep the server typecheck boundary independent of
// DOM library versions while Bun still executes the real browser modules.
const browserHardwareModulePath: string =
  "../../../ui/src/integrations/hardware-evm.ts";
const browserWalletConnectModulePath: string =
  "../../../ui/src/integrations/walletconnect.ts";
const browserHardware = await import(browserHardwareModulePath);
const browserWalletConnect = await import(browserWalletConnectModulePath);

const PRIVATE_KEY = `0x${"07".repeat(32)}` as const;
const signer = privateKeyToAccount(PRIVATE_KEY);
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const OTHER_RECIPIENT = "0x9999999999999999999999999999999999999999" as const;
const ACCOUNT = `eip155:8453:${signer.address.toLowerCase()}` as const;
const NOW = new Date("2029-12-31T23:50:00.000Z");
const REQUEST_EXPIRES = "2030-01-01T00:00:00.000Z";
const SESSION_EXPIRES = "2030-01-01T01:00:00.000Z";
const TOPIC = "walletconnect-cross-tier-secret-topic";

const preparedInput = {
  schema_version: "cashloom.sign-request/1",
  request_id: "cross-tier-prepared-request",
  intent_hash: hashUtf8("cross-tier-intent"),
  authorization_id: "cross-tier-authorization",
  expires_at: REQUEST_EXPIRES,
  kind: "evm-transaction",
  chain_id: "eip155:8453",
  signer_account_id: ACCOUNT,
  to_account_id: `eip155:8453:${RECIPIENT}`,
  nonce: "9",
  value_atomic: "23",
  data: "0x",
  gas_limit: "21000",
  fee: {
    kind: "eip1559",
    max_fee_per_gas_atomic: "3000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
} as const;

const prepared = boundSignRequestSchema.parse(
  preparedInput,
) as EvmTransactionSignRequest;

const transaction = (
  overrides: Partial<TransactionSerializableEIP1559> = {},
): TransactionSerializableEIP1559 => ({
  type: "eip1559",
  chainId: 8453,
  nonce: 9,
  to: RECIPIENT,
  value: 23n,
  data: "0x",
  gas: 21000n,
  maxFeePerGas: 3000000000n,
  maxPriorityFeePerGas: 1000000000n,
  accessList: [],
  ...overrides,
});

const sign = (overrides: Partial<TransactionSerializableEIP1559> = {}) =>
  signer.signTransaction(transaction(overrides));

const hardwareHandoff = async () => {
  const requestHash = hashBoundSignRequest(prepared);
  expect(String(await browserHardware.hashEvmSignRequest(preparedInput))).toBe(
    String(requestHash),
  );
  return hardwareSigningHandoffSchema.parse({
    schema_version: "cashloom.hardware-signing-handoff/1",
    handoff_id: "cross-tier-hardware-handoff",
    signer_id: "cross-tier-hardware-signer",
    device_binding_hash: hashUtf8("cross-tier-device-public-binding"),
    transport: "usb",
    authorization: {
      authorization_id: prepared.authorization_id,
      intent_hash: prepared.intent_hash,
      request_hash: requestHash,
      expires_at: prepared.expires_at,
    },
    request: prepared,
    request_hash: requestHash,
    expires_at: prepared.expires_at,
  });
};

const browserHardwareEvidence = async (
  raw: `0x${string}`,
) => {
  const handoff = await hardwareHandoff();
  const transport = {
    kind: "usb",
    async confirmAndSignExactEvm(input: {
      readonly device_binding_hash: string;
      readonly request_hash: string;
    }) {
      return {
        account_id: prepared.signer_account_id,
        device_binding_hash: input.device_binding_hash,
        request_hash: input.request_hash,
        serialized_transaction: raw,
        transaction_hash: keccak256(raw),
        user_confirmed: true,
      };
    },
  };
  const browserEvidence = await browserHardware.executeHardwareEvmHandoff(
    handoff,
    transport,
    { now: NOW },
  );
  return { handoff, browserEvidence };
};

const walletConnectFixture = async (raw: `0x${string}`) => {
  const browserSession = await browserWalletConnect.projectWalletConnectSession({
    topic: TOPIC,
    peer_public_key: "cross-tier-walletconnect-peer-public-key",
    namespaces: [{
      chain_id: "eip155:8453",
      accounts: [ACCOUNT],
      methods: ["eth_signTransaction"],
      events: ["accountsChanged", "chainChanged"],
    }],
    expires_at: SESSION_EXPIRES,
  }, NOW);
  const session = walletConnectSessionBindingSchema.parse(browserSession);
  const requestHash = hashBoundSignRequest(prepared);
  const browserParamsHash = await browserWalletConnect
    .hashWalletConnectTransactionParams(preparedInput);
  const serverParamsHash = hashWalletConnectTransactionParams(prepared);
  expect(String(browserParamsHash)).toBe(String(serverParamsHash));

  const approved = {
    schema_version: "cashloom.walletconnect-request/2",
    session_id: browserSession.session_id,
    request_id: "cross-tier-walletconnect-request",
    chain_id: "eip155:8453",
    account_id: ACCOUNT,
    method: "eth_signTransaction",
    params_hash: browserParamsHash,
    authorization: {
      authorization_id: prepared.authorization_id,
      intent_hash: prepared.intent_hash,
      request_hash: requestHash,
      expires_at: prepared.expires_at,
    },
    request_hash: requestHash,
    expires_at: prepared.expires_at,
  };
  const browserRequest = await browserWalletConnect.projectWalletConnectRequest(
    browserSession,
    approved,
    preparedInput,
    {
      topic: TOPIC,
      request_id: approved.request_id,
      chain_id: approved.chain_id,
      account_id: approved.account_id,
      method: approved.method,
      params: await browserWalletConnect.walletConnectTransactionParams(preparedInput),
    },
    NOW,
  );
  const request = walletConnectRequestBindingSchema.parse(browserRequest);
  const browserEvidence = await browserWalletConnect.projectWalletConnectSignedEvidence(
    browserSession,
    browserRequest,
    {
      topic: TOPIC,
      request_id: browserRequest.request_id,
      serialized_transaction: raw,
      transaction_hash: keccak256(raw),
    },
    NOW,
  );
  const evidence = walletConnectProviderEvidenceSchema.parse(browserEvidence);
  const sessionHash = hashCanonicalContract(session as unknown as JsonValue);
  expect(String(browserEvidence.session_binding_hash)).toBe(String(sessionHash));
  const sessionState = walletConnectSessionStateSchema.parse({
    session_id: session.session_id,
    binding_hash: sessionHash,
    status: "ACTIVE",
    expires_at: session.expires_at,
  });
  const requestState = walletConnectRequestStateSchema.parse({
    session_id: session.session_id,
    request_id: request.request_id,
    request_hash: request.request_hash,
    params_hash: request.params_hash,
    status: "PENDING",
    version: 0,
    expires_at: request.expires_at,
  });
  return { session, sessionState, request, requestState, evidence };
};

describe("browser-to-server external signer contracts", () => {
  test("parses and independently verifies browser hardware evidence", async () => {
    const raw = await sign();
    const { handoff, browserEvidence } = await browserHardwareEvidence(raw);
    const evidence = hardwareEvmProviderEvidenceSchema.parse(browserEvidence);
    const artifact = await verifyHardwareEvmSignedTransaction({
      handoff,
      evidence,
      now: NOW,
    });

    expect(Object.keys(evidence).sort()).toEqual([
      "account_id", "authorization_id", "chain_id", "device_binding_hash", "handoff_id",
      "request_hash", "request_id", "schema_version", "serialized_transaction", "signer_id",
      "transaction_hash", "transport",
    ]);
    expect(artifact.payload).toBe(raw);
    expect(artifact.external_tx_id).toBe(keccak256(raw));
  });

  test("server rejects a browser-carried hardware transaction substitution", async () => {
    const raw = await sign({ to: OTHER_RECIPIENT });
    const { handoff, browserEvidence } = await browserHardwareEvidence(raw);
    const evidence = hardwareEvmProviderEvidenceSchema.parse(browserEvidence);
    await expect(verifyHardwareEvmSignedTransaction({
      handoff,
      evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "integration_evidence_rejected" });
  });

  test("parses and independently verifies browser WalletConnect evidence", async () => {
    const raw = await sign();
    const value = await walletConnectFixture(raw);
    const artifact = await verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.sessionState,
      request_state: value.requestState,
      request: value.request,
      prepared_request: prepared,
      evidence: value.evidence,
      now: NOW,
    });

    expect(artifact.payload).toBe(raw);
    expect(artifact.external_tx_id).toBe(keccak256(raw));
    expect(artifact.persistence_guard.expected_request_version).toBe(0);
  });

  test("both browser and server refuse WalletConnect mutation paths", async () => {
    await expect(browserWalletConnect.projectWalletConnectSession({
      topic: TOPIC,
      peer_public_key: "cross-tier-walletconnect-peer-public-key",
      namespaces: [{
        chain_id: "eip155:8453",
        accounts: [ACCOUNT],
        methods: ["eth_signTransaction", "eth_signTypedData_v4"],
        events: ["accountsChanged", "chainChanged"],
      }],
      expires_at: SESSION_EXPIRES,
    }, NOW)).rejects.toMatchObject({ code: "walletconnect_refused" });

    const maliciousRaw = await sign({ to: OTHER_RECIPIENT });
    const value = await walletConnectFixture(maliciousRaw);
    await expect(verifyWalletConnectEvmSignedTransaction({
      session: value.session,
      session_state: value.sessionState,
      request_state: value.requestState,
      request: value.request,
      prepared_request: prepared,
      evidence: value.evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "integration_evidence_rejected" });
  });
});
