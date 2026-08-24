import {
  assertLive,
  BrowserIntegrationError,
  canonicalize,
  exactKeys,
  hashCanonical,
  hashUtf8,
  type CanonicalJson,
  type Sha256Digest,
} from "./encoding";
import {
  BASE_MAINNET_CAIP2,
  hashEvmSignRequest,
  type EvmSignRequestWire,
} from "./hardware-evm";

export type WalletConnectMethod = "eth_signTransaction";
export type WalletConnectEvent = "accountsChanged" | "chainChanged";

export interface WalletConnectNamespaceProjection {
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly accounts: readonly string[];
  readonly methods: readonly [WalletConnectMethod];
  readonly events: readonly ["accountsChanged", "chainChanged"];
}

export interface WalletConnectSessionProjection {
  readonly schema_version: "cashloom.walletconnect-session/2";
  readonly session_id: string;
  readonly peer_public_key_hash: Sha256Digest;
  readonly namespaces: readonly [WalletConnectNamespaceProjection];
  readonly expires_at: string;
}

export interface WalletConnectRequestProjection {
  readonly schema_version: "cashloom.walletconnect-request/2";
  readonly session_id: string;
  readonly request_id: string;
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly account_id: string;
  readonly method: WalletConnectMethod;
  readonly params_hash: Sha256Digest;
  readonly authorization: {
    readonly authorization_id: string;
    readonly intent_hash: Sha256Digest;
    readonly request_hash: Sha256Digest;
    readonly expires_at: string;
  };
  readonly request_hash: Sha256Digest;
  readonly expires_at: string;
}

export interface WalletConnectSignedEvidence {
  readonly schema_version: "cashloom.walletconnect-evidence/1";
  readonly outcome: "SIGNED";
  readonly session_id: string;
  readonly request_id: string;
  readonly session_binding_hash: Sha256Digest;
  readonly peer_public_key_hash: Sha256Digest;
  readonly authorization_id: string;
  readonly request_hash: Sha256Digest;
  readonly params_hash: Sha256Digest;
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly account_id: string;
  readonly method: WalletConnectMethod;
  readonly expires_at: string;
  readonly serialized_transaction: `0x${string}`;
  readonly transaction_hash: `0x${string}`;
}

export interface RawWalletConnectSession {
  readonly topic: string;
  readonly peer_public_key: string;
  readonly namespaces: readonly Readonly<{
    readonly chain_id: string;
    readonly accounts: readonly string[];
    readonly methods: readonly string[];
    readonly events: readonly string[];
  }>[];
  readonly expires_at: string;
}

export interface RawWalletConnectRequest {
  readonly topic: string;
  readonly request_id: string;
  readonly chain_id: string;
  readonly account_id: string;
  readonly method: WalletConnectMethod | "eth_sendTransaction" | "eth_signTypedData_v4";
  readonly params: CanonicalJson;
}

export interface RawWalletConnectSignedResult {
  readonly topic: string;
  readonly request_id: string;
  readonly serialized_transaction: `0x${string}`;
  readonly transaction_hash: `0x${string}`;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const BASE_ACCOUNT = /^eip155:8453:0x[0-9a-f]{40}$/;
const SERIALIZED_TRANSACTION = /^0x(?:[0-9a-f]{2})+$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;

const sessionId = (topicHash: Sha256Digest): string =>
  `wc.${topicHash.slice("sha256:".length, "sha256:".length + 48)}`;

const addressOf = (accountId: string): `0x${string}` =>
  accountId.slice(BASE_MAINNET_CAIP2.length + 1) as `0x${string}`;

const quantity = (value: string): `0x${string}` =>
  `0x${BigInt(value).toString(16)}`;

const refuse = (): never => {
  throw new BrowserIntegrationError("walletconnect_refused");
};

const sessionIdForTopic = async (topic: unknown): Promise<string> => {
  if (typeof topic !== "string" || topic.length < 16 || topic.length > 512) {
    return refuse();
  }
  try {
    return sessionId(await hashUtf8(topic, 512));
  } catch {
    return refuse();
  }
};

const hashPublicText = async (
  value: string,
  maxBytes: number,
): Promise<Sha256Digest> => {
  try {
    return await hashUtf8(value, maxBytes);
  } catch {
    return refuse();
  }
};

const validateLeastPrivilegeNamespace = (
  namespace: RawWalletConnectSession["namespaces"][number],
): WalletConnectNamespaceProjection => {
  if (
    !namespace || !exactKeys(namespace, ["chain_id", "accounts", "methods", "events"]) ||
    namespace.chain_id !== BASE_MAINNET_CAIP2 || !Array.isArray(namespace.accounts) ||
    namespace.accounts.length !== 1 || !BASE_ACCOUNT.test(namespace.accounts[0] ?? "") ||
    !Array.isArray(namespace.methods) || namespace.methods.length !== 1 ||
    namespace.methods[0] !== "eth_signTransaction" || !Array.isArray(namespace.events) ||
    namespace.events.length !== 2 || new Set(namespace.events).size !== 2 ||
    !namespace.events.includes("accountsChanged") || !namespace.events.includes("chainChanged")
  ) {
    return refuse();
  }
  return Object.freeze({
    chain_id: BASE_MAINNET_CAIP2,
    accounts: Object.freeze([namespace.accounts[0]!] as const),
    methods: Object.freeze(["eth_signTransaction"] as const),
    events: Object.freeze(["accountsChanged", "chainChanged"] as const),
  });
};

const validateSessionProjection = (
  session: WalletConnectSessionProjection,
  now: Date,
): WalletConnectNamespaceProjection => {
  if (
    !session || !exactKeys(session, [
      "schema_version", "session_id", "peer_public_key_hash", "namespaces", "expires_at",
    ]) || session.schema_version !== "cashloom.walletconnect-session/2" ||
    !ID.test(session.session_id) || !HASH.test(session.peer_public_key_hash) ||
    !Array.isArray(session.namespaces) || session.namespaces.length !== 1
  ) {
    return refuse();
  }
  assertLive(session.expires_at, now);
  return validateLeastPrivilegeNamespace(session.namespaces[0]!);
};

const validateRequestProjection = (
  request: WalletConnectRequestProjection,
  now: Date,
): void => {
  if (
    !request || !exactKeys(request, [
      "schema_version", "session_id", "request_id", "chain_id", "account_id", "method",
      "params_hash", "authorization", "request_hash", "expires_at",
    ]) || request.schema_version !== "cashloom.walletconnect-request/2" ||
    !ID.test(request.session_id) || !ID.test(request.request_id) ||
    request.chain_id !== BASE_MAINNET_CAIP2 || !BASE_ACCOUNT.test(request.account_id) ||
    request.method !== "eth_signTransaction" || !HASH.test(request.params_hash) ||
    !HASH.test(request.request_hash) || !exactKeys(request.authorization, [
      "authorization_id", "intent_hash", "request_hash", "expires_at",
    ]) || !ID.test(request.authorization.authorization_id) ||
    !HASH.test(request.authorization.intent_hash) ||
    request.authorization.request_hash !== request.request_hash ||
    request.authorization.expires_at !== request.expires_at
  ) {
    refuse();
  }
  assertLive(request.expires_at, now);
};

const requirePreparedRequest = async (request: EvmSignRequestWire): Promise<Sha256Digest> => {
  try {
    return await hashEvmSignRequest(request);
  } catch {
    return refuse();
  }
};

const uncheckedTransactionParams = (
  request: EvmSignRequestWire,
): CanonicalJson => [{
  type: "0x2",
  chainId: "0x2105",
  from: addressOf(request.signer_account_id),
  ...(request.to_account_id === null ? {} : { to: addressOf(request.to_account_id) }),
  nonce: quantity(request.nonce),
  value: quantity(request.value_atomic),
  data: request.data,
  gas: quantity(request.gas_limit),
  maxFeePerGas: quantity(request.fee.max_fee_per_gas_atomic),
  maxPriorityFeePerGas: quantity(request.fee.max_priority_fee_per_gas_atomic),
  accessList: [],
}];

/** Exact JSON-RPC params sent to the wallet after full request validation. */
export const walletConnectTransactionParams = async (
  request: EvmSignRequestWire,
): Promise<CanonicalJson> => {
  await requirePreparedRequest(request);
  return uncheckedTransactionParams(request);
};

/** Domain-separated semantic digest mirrored exactly by the server verifier. */
export const hashWalletConnectTransactionParams = async (
  request: EvmSignRequestWire,
): Promise<Sha256Digest> => {
  await requirePreparedRequest(request);
  return hashCanonical({
    schema_version: "cashloom.walletconnect-eth-sign-transaction-params/1",
    method: "eth_signTransaction",
    chain_id: request.chain_id,
    account_id: request.signer_account_id,
    transaction: {
      type: "eip1559",
      from_account_id: request.signer_account_id,
      to_account_id: request.to_account_id,
      nonce: request.nonce,
      value_atomic: request.value_atomic,
      data: request.data,
      gas_limit: request.gas_limit,
      max_fee_per_gas_atomic: request.fee.max_fee_per_gas_atomic,
      max_priority_fee_per_gas_atomic: request.fee.max_priority_fee_per_gas_atomic,
    },
  });
};

export const projectWalletConnectSession = async (
  input: RawWalletConnectSession,
  now = new Date(),
): Promise<WalletConnectSessionProjection> => {
  if (
    !input || !exactKeys(input, ["topic", "peer_public_key", "namespaces", "expires_at"]) ||
    typeof input.topic !== "string" || input.topic.length < 16 || input.topic.length > 512 ||
    typeof input.peer_public_key !== "string" || input.peer_public_key.length < 16 ||
    input.peer_public_key.length > 4_096 || !Array.isArray(input.namespaces) ||
    input.namespaces.length !== 1
  ) {
    return refuse();
  }
  assertLive(input.expires_at, now);
  const namespace = validateLeastPrivilegeNamespace(input.namespaces[0]!);
  return Object.freeze({
    schema_version: "cashloom.walletconnect-session/2",
    session_id: await sessionIdForTopic(input.topic),
    peer_public_key_hash: await hashPublicText(input.peer_public_key, 4_096),
    namespaces: Object.freeze([namespace] as const),
    expires_at: input.expires_at,
  });
};

export const projectWalletConnectRequest = async (
  session: WalletConnectSessionProjection,
  approved: WalletConnectRequestProjection,
  prepared: EvmSignRequestWire,
  live: RawWalletConnectRequest,
  now = new Date(),
): Promise<WalletConnectRequestProjection> => {
  const namespace = validateSessionProjection(session, now);
  validateRequestProjection(approved, now);
  if (
    !live || !exactKeys(live, ["topic", "request_id", "chain_id", "account_id", "method", "params"]) ||
    live.method !== "eth_signTransaction"
  ) {
    return refuse();
  }
  const preparedHash = await requirePreparedRequest(prepared);
  const paramsHash = await hashWalletConnectTransactionParams(prepared);
  const derivedSessionId = await sessionIdForTopic(live.topic);
  let paramsMatch = false;
  try {
    paramsMatch = canonicalize(live.params) ===
      canonicalize(await walletConnectTransactionParams(prepared));
  } catch {
    return refuse();
  }
  if (
    approved.session_id !== session.session_id || derivedSessionId !== session.session_id ||
    approved.request_id !== live.request_id || approved.chain_id !== live.chain_id ||
    approved.account_id !== live.account_id || approved.method !== live.method ||
    namespace.accounts[0] !== approved.account_id || prepared.chain_id !== approved.chain_id ||
    prepared.signer_account_id !== approved.account_id ||
    approved.request_hash !== preparedHash || approved.params_hash !== paramsHash ||
    approved.authorization.authorization_id !== prepared.authorization_id ||
    approved.authorization.intent_hash !== prepared.intent_hash ||
    approved.authorization.request_hash !== preparedHash ||
    approved.authorization.expires_at !== prepared.expires_at ||
    approved.expires_at !== prepared.expires_at ||
    Date.parse(approved.expires_at) > Date.parse(session.expires_at) || !paramsMatch
  ) {
    return refuse();
  }
  return Object.freeze({
    schema_version: "cashloom.walletconnect-request/2",
    session_id: session.session_id,
    request_id: approved.request_id,
    chain_id: BASE_MAINNET_CAIP2,
    account_id: approved.account_id,
    method: "eth_signTransaction",
    params_hash: paramsHash,
    authorization: Object.freeze({ ...approved.authorization }),
    request_hash: preparedHash,
    expires_at: approved.expires_at,
  });
};

/** Strip the topic while producing the exact signed evidence server contract. */
export const projectWalletConnectSignedEvidence = async (
  session: WalletConnectSessionProjection,
  request: WalletConnectRequestProjection,
  result: RawWalletConnectSignedResult,
  now = new Date(),
): Promise<WalletConnectSignedEvidence> => {
  const namespace = validateSessionProjection(session, now);
  validateRequestProjection(request, now);
  if (
    !result || !exactKeys(result, [
      "topic", "request_id", "serialized_transaction", "transaction_hash",
    ]) || session.session_id !== request.session_id ||
    namespace.accounts[0] !== request.account_id ||
    await sessionIdForTopic(result.topic) !== session.session_id ||
    result.request_id !== request.request_id ||
    Date.parse(request.expires_at) > Date.parse(session.expires_at) ||
    !SERIALIZED_TRANSACTION.test(result.serialized_transaction) ||
    result.serialized_transaction.length > 131_074 ||
    !TRANSACTION_HASH.test(result.transaction_hash)
  ) {
    return refuse();
  }
  return Object.freeze({
    schema_version: "cashloom.walletconnect-evidence/1",
    outcome: "SIGNED",
    session_id: session.session_id,
    request_id: request.request_id,
    session_binding_hash: await hashCanonical(session as unknown as CanonicalJson),
    peer_public_key_hash: session.peer_public_key_hash,
    authorization_id: request.authorization.authorization_id,
    request_hash: request.request_hash,
    params_hash: request.params_hash,
    chain_id: BASE_MAINNET_CAIP2,
    account_id: request.account_id,
    method: "eth_signTransaction",
    expires_at: request.expires_at,
    serialized_transaction: result.serialized_transaction,
    transaction_hash: result.transaction_hash,
  });
};
