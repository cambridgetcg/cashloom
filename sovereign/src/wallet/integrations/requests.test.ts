import { describe, expect, test } from "bun:test";
import { hashBoundSignRequest } from "../domain/signing";
import type { JsonValue } from "../domain/intent";
import {
  createWebAuthnRpOriginBinding,
  erc4337UserOperationRequestSchema,
  fiatRedirectBindingSchema,
  fiatWebhookEvidenceSchema,
  hardwareSigningHandoffSchema,
  hashCanonicalContract,
  hashErc4337UserOperationBinding,
  hashHexData,
  hashUtf8,
  regulatedFiatPaymentAuthorizationSchema,
  walletConnectRequestBindingSchema,
  walletConnectSessionBindingSchema,
  webAuthnAssertionCeremonySchema,
  webAuthnRegistrationCeremonySchema,
  webAuthnVerifiedEvidenceSchema,
} from "./index";

const HASH = (label: string) => hashUtf8(label);
const AT = "2030-01-01T00:00:00.000Z";
const LATER = "2030-01-01T00:05:00.000Z";
const ACCOUNT = "eip155:8453:0x1111111111111111111111111111111111111111";

const evmRequest = {
  schema_version: "cashloom.sign-request/1",
  request_id: "request-1",
  intent_hash: HASH("intent"),
  authorization_id: "authorization-1",
  expires_at: LATER,
  kind: "evm-transaction",
  chain_id: "eip155:8453",
  signer_account_id: ACCOUNT,
  to_account_id: "eip155:8453:0x2222222222222222222222222222222222222222",
  nonce: "7",
  value_atomic: "1",
  data: "0x",
  gas_limit: "21000",
  fee: { kind: "eip1559", max_fee_per_gas_atomic: "2", max_priority_fee_per_gas_atomic: "1" },
} as const;

const authorization = {
  authorization_id: "authorization-1",
  intent_hash: HASH("intent"),
  request_hash: hashBoundSignRequest(evmRequest),
  expires_at: LATER,
} as const;

describe("external integration contracts", () => {
  test("keeps WebAuthn origin material out of durable ceremonies and requires UV", () => {
    const binding = createWebAuthnRpOriginBinding("wallet.example.com", "https://wallet.example.com");
    expect(binding.origin_hash).toBe(HASH("https://wallet.example.com"));
    expect(() => createWebAuthnRpOriginBinding("evil.example", "https://wallet.example.com")).toThrow();
    expect(() => createWebAuthnRpOriginBinding("example.com", "https://wallet.example.com")).toThrow();
    expect(() => createWebAuthnRpOriginBinding("com", "https://wallet.example.com")).toThrow();
    expect(() => createWebAuthnRpOriginBinding("wallet.example.com", "https://wallet.example.com/callback")).toThrow();
    const registration = webAuthnRegistrationCeremonySchema.parse({
      schema_version: "cashloom.webauthn-registration/1", ceremony_id: "ceremony-1", signer_id: "signer-1",
      account_id: ACCOUNT, ...binding, challenge_hash: HASH("challenge"),
      expires_at: LATER, kind: "registration", require_user_verification: true, attestation_policy: "none",
    });
    expect(JSON.stringify(registration)).not.toContain("https://");
    expect(webAuthnRegistrationCeremonySchema.safeParse({ ...registration, require_user_verification: false }).success).toBe(false);
    const assertion = webAuthnAssertionCeremonySchema.parse({
      schema_version: "cashloom.webauthn-assertion/1", ceremony_id: "ceremony-2", signer_id: "signer-1",
      account_id: ACCOUNT, credential_id: "credential_1", ...binding, challenge_hash: HASH("challenge-2"),
      expires_at: LATER, kind: "assertion", authorization, require_user_presence: true, require_user_verification: true, prior_sign_count: "4",
    });
    expect(webAuthnAssertionCeremonySchema.safeParse({ ...assertion, authorization: { ...authorization, expires_at: AT } }).success).toBe(false);
    expect(webAuthnVerifiedEvidenceSchema.safeParse({
      schema_version: "cashloom.webauthn-evidence/1", ceremony_id: "ceremony-2", credential_id: "credential_1", ...binding,
      user_present: true, user_verified: false, sign_count: "5", authenticator_data_hash: HASH("auth"), signature_hash: HASH("signature"), verified_at: AT,
    }).success).toBe(false);
  });

  test("binds a hardware handoff to an exact existing prepared request", () => {
    const handoff = {
      schema_version: "cashloom.hardware-signing-handoff/1", handoff_id: "handoff-1", signer_id: "signer-1",
      device_binding_hash: HASH("device"), transport: "usb", authorization, request: evmRequest,
      request_hash: hashBoundSignRequest(evmRequest), expires_at: LATER,
    } as const;
    expect(hardwareSigningHandoffSchema.parse(handoff).request_hash).toBe(authorization.request_hash);
    expect(hardwareSigningHandoffSchema.safeParse({ ...handoff, request: { ...evmRequest, value_atomic: "2" } }).success).toBe(false);
    expect(hardwareSigningHandoffSchema.safeParse({ ...handoff, transport: "serial" }).success).toBe(false);
  });

  test("pins WalletConnect namespaces and rejects account/chain or approval substitution", () => {
    const session = {
      schema_version: "cashloom.walletconnect-session/2", session_id: "session-1", peer_public_key_hash: HASH("peer"), expires_at: LATER,
      namespaces: [{ chain_id: "eip155:8453", accounts: [ACCOUNT], methods: ["eth_signTransaction"], events: ["accountsChanged", "chainChanged"] }],
    } as const;
    expect(walletConnectSessionBindingSchema.parse(session).namespaces).toHaveLength(1);
    expect(walletConnectSessionBindingSchema.safeParse({ ...session, namespaces: [...session.namespaces, session.namespaces[0]] }).success).toBe(false);
    const request = { schema_version: "cashloom.walletconnect-request/2", session_id: "session-1", request_id: "wc-request-1", chain_id: "eip155:8453", account_id: ACCOUNT, method: "eth_signTransaction", params_hash: HASH("params"), authorization, request_hash: authorization.request_hash, expires_at: LATER } as const;
    expect(walletConnectRequestBindingSchema.parse(request).account_id.toString()).toBe(ACCOUNT);
    expect(walletConnectRequestBindingSchema.safeParse({ ...request, account_id: "eip155:1:0x1111111111111111111111111111111111111111" }).success).toBe(false);
    expect(JSON.stringify(session)).not.toContain("wc:");
  });

  test("binds ERC-4337 v0.7 semantic and packed fields, nonce domain, EntryPoint and chain", () => {
    const userOperation = {
      sender: "0x1111111111111111111111111111111111111111", nonce: "18446744073709551617",
      init_code: "0x", factory: null, factory_data_hash: null,
      call_data: "0x1234", call_data_hash: hashHexData("0x1234"),
      account_gas_limits: `0x${"2".padStart(32, "0")}${"3".padStart(32, "0")}`,
      call_gas_limit: "3", verification_gas_limit: "2", pre_verification_gas: "4",
      gas_fees: `0x${"5".padStart(32, "0")}${"6".padStart(32, "0")}`,
      max_fee_per_gas: "6", max_priority_fee_per_gas: "5",
      paymaster_and_data: "0x", paymaster: null, paymaster_verification_gas_limit: null, paymaster_post_op_gas_limit: null, paymaster_data_hash: null,
      signature: "0x1234",
    } as const;
    const raw = {
      schema_version: "cashloom.erc4337-userop/0.7", request_id: "userop-1", intent_hash: authorization.intent_hash, authorization,
      chain_id: "eip155:8453", entry_point: "0x3333333333333333333333333333333333333333", account_id: ACCOUNT,
      nonce_key: "1", nonce_sequence: "1", user_operation: userOperation, user_operation_binding_hash: HASH("placeholder"), expires_at: LATER,
    } as const;
    const bindingHash = hashErc4337UserOperationBinding(raw);
    const request = {
      ...raw,
      authorization: { ...authorization, request_hash: bindingHash },
      user_operation_binding_hash: bindingHash,
    };
    expect(erc4337UserOperationRequestSchema.parse(request).user_operation.sender).toBe(userOperation.sender);
    expect(hashErc4337UserOperationBinding({ ...request, user_operation: { ...userOperation, signature: "0xabcd" } })).toBe(request.user_operation_binding_hash);
    expect(erc4337UserOperationRequestSchema.safeParse({ ...request, entry_point: "0x4444444444444444444444444444444444444444" }).success).toBe(false);
    expect(erc4337UserOperationRequestSchema.safeParse({ ...request, user_operation: { ...userOperation, gas_fees: `0x${"0".repeat(64)}` } }).success).toBe(false);
    expect(erc4337UserOperationRequestSchema.safeParse({ ...request, nonce_sequence: "2" }).success).toBe(false);
    expect(erc4337UserOperationRequestSchema.safeParse({ ...request, authorization }).success).toBe(false);
  });

  test("keeps OAuth redirect secrets and raw fiat webhooks outside durable evidence", () => {
    const redirect = fiatRedirectBindingSchema.parse({ schema_version: "cashloom.fiat-redirect-binding/1", flow_id: "flow-1", provider_id: "provider-1", issuer_hash: HASH("issuer"), redirect_uri_hash: HASH("redirect"), state_hash: HASH("state"), pkce_verifier_hash: HASH("pkce"), expires_at: LATER });
    expect(JSON.stringify(redirect)).not.toContain("state-value");
    const payment = regulatedFiatPaymentAuthorizationSchema.parse({ schema_version: "cashloom.regulated-fiat-payment-authorization/1", authorization_id: "fiat-auth-1", intent_hash: HASH("fiat-intent"), provider_id: "provider-1", connection_id: "connection-1", provider_account_ref_hash: HASH("account"), beneficiary_ref_hash: HASH("beneficiary"), amount: { asset: { kind: "fiat", currency: "USD" }, atomic: "100" }, provider_idempotency_key_hash: HASH("idempotency"), redirect_flow_id: "flow-1", expires_at: LATER });
    expect(payment.amount.atomic.toString()).toBe("100");
    expect(regulatedFiatPaymentAuthorizationSchema.safeParse({ ...payment, amount: { asset: { kind: "crypto", asset_id: "eip155:8453/slip44:60", decimals: 18 }, atomic: "1" } }).success).toBe(false);
    const webhook = { schema_version: "cashloom.fiat-webhook-evidence/1", provider_id: "provider-1", delivery_id: "delivery-1", event_type: "payment.settled", provider_payment_ref: "payment-1", payload_hash: HASH("raw-body"), signature_key_id: "kid-1", signature_hash: HASH("signature"), occurred_at: AT, received_at: LATER, state: "settled" } as const;
    expect(fiatWebhookEvidenceSchema.parse(webhook).delivery_id).toBe("delivery-1");
    expect(fiatWebhookEvidenceSchema.safeParse({ ...webhook, received_at: "2029-12-31T23:59:59.000Z" }).success).toBe(false);
    expect(hashCanonicalContract(webhook as unknown as JsonValue)).toMatch(/^sha256:/);
  });
});
