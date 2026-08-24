import {
  assertLive,
  BrowserIntegrationError,
  exactKeys,
  hashCanonical,
  type CanonicalJson,
  type Sha256Digest,
} from "./encoding";

export const BASE_MAINNET_CAIP2 = "eip155:8453" as const;

type HardwareTransportName = "usb" | "nfc" | "ble" | "hid";

export interface EvmSignRequestWire {
  readonly schema_version: "cashloom.sign-request/1";
  readonly request_id: string;
  readonly intent_hash: Sha256Digest;
  readonly authorization_id: string;
  readonly expires_at: string;
  readonly quote_hash?: Sha256Digest;
  readonly simulation_hash?: Sha256Digest;
  readonly kind: "evm-transaction";
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly signer_account_id: string;
  readonly to_account_id: string | null;
  readonly nonce: string;
  readonly value_atomic: string;
  readonly data: `0x${string}`;
  readonly gas_limit: string;
  readonly fee: {
    readonly kind: "eip1559";
    readonly max_fee_per_gas_atomic: string;
    readonly max_priority_fee_per_gas_atomic: string;
  };
}

export interface HardwareEvmHandoff {
  readonly schema_version: "cashloom.hardware-signing-handoff/1";
  readonly handoff_id: string;
  readonly signer_id: string;
  readonly device_binding_hash: Sha256Digest;
  readonly transport: HardwareTransportName;
  readonly authorization: {
    readonly authorization_id: string;
    readonly intent_hash: Sha256Digest;
    readonly request_hash: Sha256Digest;
    readonly expires_at: string;
  };
  readonly request: EvmSignRequestWire;
  readonly request_hash: Sha256Digest;
  readonly expires_at: string;
}

export interface HardwareEvmTransport {
  readonly kind: HardwareTransportName;
  confirmAndSignExactEvm(
    request: Readonly<{
      readonly handoff_id: string;
      readonly signer_id: string;
      readonly device_binding_hash: Sha256Digest;
      readonly request_hash: Sha256Digest;
      readonly request: EvmSignRequestWire;
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    readonly account_id: string;
    readonly device_binding_hash: Sha256Digest;
    readonly request_hash: Sha256Digest;
    readonly serialized_transaction: `0x${string}`;
    readonly transaction_hash: `0x${string}`;
    readonly user_confirmed: true;
  }>>;
}

/** Exact public evidence accepted by the networkless server verifier. */
export interface HardwareEvmProviderEvidence {
  readonly schema_version: "cashloom.hardware-evm-evidence/1";
  readonly handoff_id: string;
  readonly signer_id: string;
  readonly device_binding_hash: Sha256Digest;
  readonly transport: HardwareTransportName;
  readonly authorization_id: string;
  readonly request_id: string;
  readonly request_hash: Sha256Digest;
  readonly chain_id: typeof BASE_MAINNET_CAIP2;
  readonly account_id: string;
  readonly serialized_transaction: `0x${string}`;
  readonly transaction_hash: `0x${string}`;
}

export type HardwareEvmEvidence = HardwareEvmProviderEvidence;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const ACCOUNT = /^eip155:(0|[1-9][0-9]*):0x[0-9a-f]{40}$/;

const requestKeys = (request: EvmSignRequestWire): string[] => [
  "schema_version", "request_id", "intent_hash", "authorization_id", "expires_at",
  ...(request.quote_hash === undefined ? [] : ["quote_hash"]),
  ...(request.simulation_hash === undefined ? [] : ["simulation_hash"]),
  "kind", "chain_id", "signer_account_id", "to_account_id", "nonce", "value_atomic",
  "data", "gas_limit", "fee",
];

const validateRequest = (request: EvmSignRequestWire): void => {
  const feeValid = request?.fee?.kind === "eip1559" &&
    exactKeys(request.fee, ["kind", "max_fee_per_gas_atomic", "max_priority_fee_per_gas_atomic"]) &&
    UINT.test(request.fee.max_fee_per_gas_atomic) &&
    UINT.test(request.fee.max_priority_fee_per_gas_atomic) &&
    BigInt(request.fee.max_priority_fee_per_gas_atomic) <= BigInt(request.fee.max_fee_per_gas_atomic);
  const chain = request?.chain_id;
  if (
    !request || !exactKeys(request, requestKeys(request)) ||
    request.schema_version !== "cashloom.sign-request/1" || request.kind !== "evm-transaction" ||
    !ID.test(request.request_id) || !HASH.test(request.intent_hash) ||
    !ID.test(request.authorization_id) || chain !== BASE_MAINNET_CAIP2 ||
    !ACCOUNT.test(request.signer_account_id) ||
    !request.signer_account_id.startsWith(`${chain}:`) ||
    (request.to_account_id !== null &&
      (!ACCOUNT.test(request.to_account_id) || !request.to_account_id.startsWith(`${chain}:`))) ||
    !UINT.test(request.nonce) || !UINT.test(request.value_atomic) || !UINT.test(request.gas_limit) ||
    !HEX.test(request.data) || request.data.length > 131_074 || !feeValid ||
    (request.quote_hash !== undefined && !HASH.test(request.quote_hash)) ||
    (request.simulation_hash !== undefined && !HASH.test(request.simulation_hash))
  ) {
    throw new BrowserIntegrationError("hardware_refused");
  }
};

const requestJson = (request: EvmSignRequestWire): CanonicalJson => ({
  schema_version: request.schema_version,
  request_id: request.request_id,
  intent_hash: request.intent_hash,
  authorization_id: request.authorization_id,
  expires_at: request.expires_at,
  ...(request.quote_hash === undefined ? {} : { quote_hash: request.quote_hash }),
  ...(request.simulation_hash === undefined ? {} : { simulation_hash: request.simulation_hash }),
  kind: request.kind,
  chain_id: request.chain_id,
  signer_account_id: request.signer_account_id,
  to_account_id: request.to_account_id,
  nonce: request.nonce,
  value_atomic: request.value_atomic,
  data: request.data,
  gas_limit: request.gas_limit,
  fee: { ...request.fee },
});

/** Browser equivalent of the Wallet Kernel's full bound-request digest. */
export const hashEvmSignRequest = (request: EvmSignRequestWire): Promise<Sha256Digest> => {
  validateRequest(request);
  return hashCanonical(requestJson(request));
};

const validateHandoff = async (handoff: HardwareEvmHandoff, now: Date): Promise<void> => {
  if (
    !handoff || !exactKeys(handoff, [
      "schema_version", "handoff_id", "signer_id", "device_binding_hash", "transport",
      "authorization", "request", "request_hash", "expires_at",
    ]) ||
    handoff.schema_version !== "cashloom.hardware-signing-handoff/1" ||
    !ID.test(handoff.handoff_id) || !ID.test(handoff.signer_id) ||
    !HASH.test(handoff.device_binding_hash) || !HASH.test(handoff.request_hash) ||
    !["usb", "nfc", "ble", "hid"].includes(handoff.transport) ||
    !exactKeys(handoff.authorization, ["authorization_id", "intent_hash", "request_hash", "expires_at"])
  ) {
    throw new BrowserIntegrationError("hardware_refused");
  }
  validateRequest(handoff.request);
  assertLive(handoff.expires_at, now);
  if (
    handoff.authorization.authorization_id !== handoff.request.authorization_id ||
    handoff.authorization.intent_hash !== handoff.request.intent_hash ||
    handoff.authorization.request_hash !== handoff.request_hash ||
    handoff.authorization.expires_at !== handoff.expires_at ||
    handoff.request.expires_at !== handoff.expires_at ||
    await hashEvmSignRequest(handoff.request) !== handoff.request_hash
  ) {
    throw new BrowserIntegrationError("hardware_refused");
  }
};

export const executeHardwareEvmHandoff = async (
  handoff: HardwareEvmHandoff,
  transport: HardwareEvmTransport,
  options: { readonly signal?: AbortSignal; readonly now?: Date } = {},
): Promise<HardwareEvmEvidence> => {
  if (options.signal?.aborted) throw new BrowserIntegrationError("integration_cancelled");
  const startedAt = options.now ?? new Date();
  await validateHandoff(handoff, startedAt);
  if (!transport || transport.kind !== handoff.transport || typeof transport.confirmAndSignExactEvm !== "function") {
    throw new BrowserIntegrationError("hardware_refused");
  }
  let result: Awaited<ReturnType<HardwareEvmTransport["confirmAndSignExactEvm"]>>;
  try {
    result = await transport.confirmAndSignExactEvm(Object.freeze({
      handoff_id: handoff.handoff_id,
      signer_id: handoff.signer_id,
      device_binding_hash: handoff.device_binding_hash,
      request_hash: handoff.request_hash,
      request: handoff.request,
    }), options.signal);
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new BrowserIntegrationError("integration_cancelled");
    }
    throw new BrowserIntegrationError("hardware_refused");
  }
  if (options.signal?.aborted) {
    throw new BrowserIntegrationError("integration_cancelled");
  }
  if (
    !result || result.user_confirmed !== true ||
    result.account_id !== handoff.request.signer_account_id ||
    result.device_binding_hash !== handoff.device_binding_hash || result.request_hash !== handoff.request_hash ||
    !/^0x[0-9a-f]{64}$/.test(result.transaction_hash) ||
    !/^0x(?:[0-9a-f]{2})+$/.test(result.serialized_transaction) ||
    result.serialized_transaction.length > 131_074
  ) {
    throw new BrowserIntegrationError("hardware_refused");
  }
  assertLive(handoff.expires_at, options.now ?? new Date());
  return Object.freeze({
    schema_version: "cashloom.hardware-evm-evidence/1",
    handoff_id: handoff.handoff_id,
    signer_id: handoff.signer_id,
    device_binding_hash: result.device_binding_hash,
    transport: handoff.transport,
    authorization_id: handoff.request.authorization_id,
    request_id: handoff.request.request_id,
    request_hash: result.request_hash,
    chain_id: BASE_MAINNET_CAIP2,
    account_id: result.account_id,
    serialized_transaction: result.serialized_transaction,
    transaction_hash: result.transaction_hash,
  });
};
