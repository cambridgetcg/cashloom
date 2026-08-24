import { describe, expect, test } from "bun:test";
import {
  hashEvmSignRequest,
  hashWalletConnectTransactionParams,
  projectWalletConnectRequest,
  projectWalletConnectSession,
  projectWalletConnectSignedEvidence,
  walletConnectTransactionParams,
  type EvmSignRequestWire,
  type Sha256Digest,
  type WalletConnectRequestProjection,
} from "../src/integrations";

const HASH = (character: string) => `sha256:${character.repeat(64)}` as Sha256Digest;
const ACCOUNT = `eip155:8453:0x${"1".repeat(40)}`;
const TOPIC = "walletconnect-topic-secret-canary";
const PEER = "peer-public-key-canary-value";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const EXPIRES = "2026-08-24T12:05:00.000Z";
const SESSION_EXPIRES = "2026-08-24T12:10:00.000Z";

const prepared = (): EvmSignRequestWire => ({
  schema_version: "cashloom.sign-request/1",
  request_id: "prepared-request-1",
  intent_hash: HASH("a"),
  authorization_id: "authorization-1",
  expires_at: EXPIRES,
  kind: "evm-transaction",
  chain_id: "eip155:8453",
  signer_account_id: ACCOUNT,
  to_account_id: `eip155:8453:0x${"2".repeat(40)}`,
  nonce: "7",
  value_atomic: "1000000000000000",
  data: "0x",
  gas_limit: "21000",
  fee: {
    kind: "eip1559",
    max_fee_per_gas_atomic: "2000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
});

const rawSession = () => ({
  topic: TOPIC,
  peer_public_key: PEER,
  namespaces: [{
    chain_id: "eip155:8453",
    accounts: [ACCOUNT],
    methods: ["eth_signTransaction"],
    events: ["chainChanged", "accountsChanged"],
  }],
  expires_at: SESSION_EXPIRES,
});

const fixture = async () => {
  const request = prepared();
  const session = await projectWalletConnectSession(rawSession(), NOW);
  const requestHash = await hashEvmSignRequest(request);
  const paramsHash = await hashWalletConnectTransactionParams(request);
  const approved: WalletConnectRequestProjection = {
    schema_version: "cashloom.walletconnect-request/2",
    session_id: session.session_id,
    request_id: "walletconnect-request-1",
    chain_id: "eip155:8453",
    account_id: ACCOUNT,
    method: "eth_signTransaction",
    params_hash: paramsHash,
    authorization: {
      authorization_id: request.authorization_id,
      intent_hash: request.intent_hash,
      request_hash: requestHash,
      expires_at: request.expires_at,
    },
    request_hash: requestHash,
    expires_at: request.expires_at,
  };
  const live = {
    topic: TOPIC,
    request_id: approved.request_id,
    chain_id: approved.chain_id,
    account_id: approved.account_id,
    method: approved.method,
    params: await walletConnectTransactionParams(request),
  };
  return { request, session, approved, live, requestHash, paramsHash };
};

describe("WalletConnect public projection", () => {
  test("emits the server's exact Base least-privilege session and no relay material", async () => {
    const session = await projectWalletConnectSession(rawSession(), NOW);
    expect(session).toEqual({
      schema_version: "cashloom.walletconnect-session/2",
      session_id: expect.stringMatching(/^wc\.[0-9a-f]{48}$/),
      peer_public_key_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      namespaces: [{
        chain_id: "eip155:8453",
        accounts: [ACCOUNT],
        methods: ["eth_signTransaction"],
        events: ["accountsChanged", "chainChanged"],
      }],
      expires_at: SESSION_EXPIRES,
    });
    expect(JSON.stringify(session)).not.toContain(TOPIC);
    expect(JSON.stringify(session)).not.toContain(PEER);
  });

  test("binds the approved request to the exact prepared request and semantic params", async () => {
    const value = await fixture();
    const projected = await projectWalletConnectRequest(
      value.session,
      value.approved,
      value.request,
      value.live,
      NOW,
    );
    expect(projected).toEqual(value.approved);
    expect(projected.params_hash).toBe(value.paramsHash);
    expect(projected.request_hash).toBe(value.requestHash);
    expect(JSON.stringify(projected)).not.toContain(TOPIC);
    expect(JSON.stringify(projected)).not.toContain("chainId");
  });

  test("strips the topic and emits the server's exact signed-evidence contract", async () => {
    const value = await fixture();
    const request = await projectWalletConnectRequest(
      value.session,
      value.approved,
      value.request,
      value.live,
      NOW,
    );
    const evidence = await projectWalletConnectSignedEvidence(value.session, request, {
      topic: TOPIC,
      request_id: request.request_id,
      serialized_transaction: "0x1234",
      transaction_hash: `0x${"e".repeat(64)}`,
    }, NOW);
    expect(evidence).toEqual({
      schema_version: "cashloom.walletconnect-evidence/1",
      outcome: "SIGNED",
      session_id: value.session.session_id,
      request_id: request.request_id,
      session_binding_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      peer_public_key_hash: value.session.peer_public_key_hash,
      authorization_id: value.request.authorization_id,
      request_hash: value.requestHash,
      params_hash: value.paramsHash,
      chain_id: "eip155:8453",
      account_id: ACCOUNT,
      method: "eth_signTransaction",
      expires_at: EXPIRES,
      serialized_transaction: "0x1234",
      transaction_hash: `0x${"e".repeat(64)}`,
    });
    expect(JSON.stringify(evidence)).not.toContain(TOPIC);
  });

  test("refuses over-broad, event-blind, multi-account, and non-Base sessions", async () => {
    const namespace = rawSession().namespaces[0]!;
    for (const namespaces of [
      [{ ...namespace, methods: ["eth_signTransaction", "eth_signTypedData_v4"] }],
      [{ ...namespace, methods: ["eth_sendTransaction"] }],
      [{ ...namespace, events: ["accountsChanged"] }],
      [{ ...namespace, accounts: [...namespace.accounts, `eip155:8453:0x${"9".repeat(40)}`] }],
      [{ ...namespace, chain_id: "eip155:1", accounts: [`eip155:1:0x${"1".repeat(40)}`] }],
      [namespace, namespace],
    ]) {
      await expect(projectWalletConnectSession({ ...rawSession(), namespaces }, NOW))
        .rejects.toMatchObject({ code: "walletconnect_refused" });
    }
  });

  test("refuses send fallback plus topic/account/chain/method/params/prepared mutations", async () => {
    const value = await fixture();
    for (const live of [
      { ...value.live, method: "eth_sendTransaction" as const },
      { ...value.live, topic: "another-walletconnect-topic" },
      { ...value.live, account_id: `eip155:8453:0x${"9".repeat(40)}` },
      { ...value.live, chain_id: "eip155:1" },
      { ...value.live, method: "eth_signTypedData_v4" as const },
      { ...value.live, params: [{ value: "0x2" }] },
    ]) {
      await expect(projectWalletConnectRequest(
        value.session,
        value.approved,
        value.request,
        live,
        NOW,
      )).rejects.toMatchObject({ code: "walletconnect_refused" });
    }

    await expect(projectWalletConnectRequest(
      value.session,
      value.approved,
      { ...value.request, value_atomic: "2" },
      value.live,
      NOW,
    )).rejects.toMatchObject({ code: "walletconnect_refused" });
  });
});
