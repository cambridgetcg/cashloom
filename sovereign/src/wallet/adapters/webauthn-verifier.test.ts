import { describe, expect, test } from "bun:test";
import { base64urlnopad } from "@scure/base";
import { P256, PublicKey, Signature } from "ox";
import { Authentication, Authenticator } from "ox/webauthn";
import {
  createWebAuthnRpOriginBinding,
  hashHexData,
  hashUtf8,
  webAuthnAssertionCeremonySchema,
  webAuthnRegistrationCeremonySchema,
} from "../integrations/index.ts";
import {
  serializedAssertionResponseSchema,
  serializedRegistrationResponseSchema,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from "./webauthn-verifier.ts";

const ORIGIN = "https://wallet.example.com";
const RP_ID = "wallet.example.com";
const ACCOUNT = "eip155:8453:0x1111111111111111111111111111111111111111";
const CHALLENGE = `0x${"ab".repeat(32)}` as const;
const ASSERTION_CHALLENGE = `0x${"cd".repeat(32)}` as const;
const AT = "2030-01-01T00:00:00.000Z";
const NOW = new Date("2029-12-31T23:59:00.000Z");

const b64u = (bytes: Uint8Array | ArrayBuffer): string =>
  base64urlnopad.encode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

const setup = () => {
  const { privateKey, publicKey } = P256.createKeyPair();
  const credentialIdBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const credentialId = b64u(credentialIdBytes);
  const authData = Authenticator.getAuthenticatorData({
    rpId: RP_ID,
    flag: 0x45,
    signCount: 0,
    credential: { id: credentialIdBytes, publicKey },
  });
  const attestation = Authenticator.getAttestationObject({ authData, fmt: "none" });
  const clientData = Authenticator.getClientDataJSON({
    challenge: CHALLENGE,
    origin: ORIGIN,
    type: "webauthn.create",
  });
  const originBinding = createWebAuthnRpOriginBinding(RP_ID, ORIGIN);
  const registrationCeremony = webAuthnRegistrationCeremonySchema.parse({
    schema_version: "cashloom.webauthn-registration/1",
    ceremony_id: "ceremony-register",
    signer_id: "signer-passkey",
    account_id: ACCOUNT,
    ...originBinding,
    challenge_hash: hashHexData(CHALLENGE),
    expires_at: AT,
    kind: "registration",
    require_user_verification: true,
    attestation_policy: "none",
  });
  const registrationResponse = serializedRegistrationResponseSchema.parse({
    id: credentialId,
    raw_id: credentialId,
    type: "public-key",
    authenticator_attachment: "platform",
    response: {
      client_data_json: b64u(new TextEncoder().encode(clientData)),
      attestation_object: b64u(Buffer.from(attestation.slice(2), "hex")),
      transports: ["internal"],
    },
  });
  return { privateKey, publicKey, credentialId, registrationCeremony, registrationResponse, originBinding };
};

describe("passkey WebAuthn verifier", () => {
  test("verifies attestation-none registration without claiming hardware assurance", () => {
    const fixture = setup();
    const result = verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: CHALLENGE,
      origin: ORIGIN,
      response: fixture.registrationResponse,
      now: NOW,
    });
    expect(result.credential.credential_id).toBe(fixture.credentialId);
    expect(result.credential.public_key).toBe(PublicKey.toHex(fixture.publicKey));
    expect(result.credential.attestation_assurance).toBe("none");
    expect(result.credential.user_verified).toBe(true);
    expect(result.evidence).not.toHaveProperty("attestation_object");
  });

  test("verifies a UV assertion and advances a supported counter", () => {
    const fixture = setup();
    const registration = verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: CHALLENGE,
      origin: ORIGIN,
      response: fixture.registrationResponse,
      now: NOW,
    });
    const payload = Authentication.getSignPayload({
      challenge: ASSERTION_CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      signCount: 1,
      userVerification: "required",
    });
    const signature = P256.sign({
      privateKey: fixture.privateKey,
      payload: payload.payload,
      hash: true,
    });
    const authorization = {
      authorization_id: "authorization-1",
      intent_hash: hashUtf8("intent"),
      request_hash: hashUtf8("request"),
      expires_at: AT,
    } as const;
    const ceremony = webAuthnAssertionCeremonySchema.parse({
      schema_version: "cashloom.webauthn-assertion/1",
      ceremony_id: "ceremony-assert",
      signer_id: "signer-passkey",
      account_id: ACCOUNT,
      credential_id: fixture.credentialId,
      ...fixture.originBinding,
      challenge_hash: hashHexData(ASSERTION_CHALLENGE),
      expires_at: AT,
      kind: "assertion",
      authorization,
      require_user_presence: true,
      require_user_verification: true,
      prior_sign_count: "0",
    });
    const response = serializedAssertionResponseSchema.parse({
      id: fixture.credentialId,
      raw_id: fixture.credentialId,
      type: "public-key",
      authenticator_attachment: "platform",
      response: {
        client_data_json: b64u(new TextEncoder().encode(payload.metadata.clientDataJSON)),
        authenticator_data: b64u(Buffer.from(payload.metadata.authenticatorData.slice(2), "hex")),
        signature: b64u(Signature.toDerBytes(signature)),
        user_handle: null,
      },
    });
    const result = verifyPasskeyAssertion({
      ceremony,
      challenge: ASSERTION_CHALLENGE,
      origin: ORIGIN,
      credential: {
        credential_id: fixture.credentialId,
        public_key: registration.credential.public_key,
        sign_count: "0",
        status: "ACTIVE",
      },
      response,
      now: NOW,
    });
    expect(result.next_sign_count).toBe("1");
    expect(result.counter_supported).toBe(true);
    expect(result.evidence.user_verified).toBe(true);
  });

  test("refuses origin, challenge, UV, credential, signature, counter and expiry substitution", () => {
    const fixture = setup();
    expect(() => verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: CHALLENGE,
      origin: "https://evil.example",
      response: fixture.registrationResponse,
      now: NOW,
    })).toThrow("passkey ceremony");
    expect(() => verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: `0x${"ef".repeat(32)}`,
      origin: ORIGIN,
      response: fixture.registrationResponse,
      now: NOW,
    })).toThrow("passkey ceremony");
    expect(() => verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: CHALLENGE,
      origin: ORIGIN,
      response: { ...fixture.registrationResponse, raw_id: b64u(new Uint8Array(32)) },
      now: NOW,
    })).toThrow("passkey ceremony");
    expect(() => verifyPasskeyRegistration({
      ceremony: fixture.registrationCeremony,
      challenge: CHALLENGE,
      origin: ORIGIN,
      response: fixture.registrationResponse,
      now: new Date(AT),
    })).toThrow("passkey ceremony");
  });

  test("permits explicit zero-counter authenticators but rejects clone rollback", () => {
    const fixture = setup();
    const payload = Authentication.getSignPayload({
      challenge: ASSERTION_CHALLENGE,
      origin: ORIGIN,
      rpId: RP_ID,
      signCount: 0,
      userVerification: "required",
    });
    const signature = P256.sign({ privateKey: fixture.privateKey, payload: payload.payload, hash: true });
    const ceremony = webAuthnAssertionCeremonySchema.parse({
      schema_version: "cashloom.webauthn-assertion/1",
      ceremony_id: "ceremony-zero",
      signer_id: "signer-passkey",
      account_id: ACCOUNT,
      credential_id: fixture.credentialId,
      ...fixture.originBinding,
      challenge_hash: hashHexData(ASSERTION_CHALLENGE),
      expires_at: AT,
      kind: "assertion",
      authorization: {
        authorization_id: "authorization-1",
        intent_hash: hashUtf8("intent"),
        request_hash: hashUtf8("request"),
        expires_at: AT,
      },
      require_user_presence: true,
      require_user_verification: true,
      prior_sign_count: "0",
    });
    const response = serializedAssertionResponseSchema.parse({
      id: fixture.credentialId,
      raw_id: fixture.credentialId,
      type: "public-key",
      response: {
        client_data_json: b64u(new TextEncoder().encode(payload.metadata.clientDataJSON)),
        authenticator_data: b64u(Buffer.from(payload.metadata.authenticatorData.slice(2), "hex")),
        signature: b64u(Signature.toDerBytes(signature)),
      },
    });
    const zero = verifyPasskeyAssertion({
      ceremony,
      challenge: ASSERTION_CHALLENGE,
      origin: ORIGIN,
      credential: { credential_id: fixture.credentialId, public_key: PublicKey.toHex(fixture.publicKey), sign_count: "0", status: "ACTIVE" },
      response,
      now: NOW,
    });
    expect(zero.counter_supported).toBe(false);
    expect(() => verifyPasskeyAssertion({
      ceremony: { ...ceremony, prior_sign_count: "2" },
      challenge: ASSERTION_CHALLENGE,
      origin: ORIGIN,
      credential: { credential_id: fixture.credentialId, public_key: PublicKey.toHex(fixture.publicKey), sign_count: "2", status: "ACTIVE" },
      response,
      now: NOW,
    })).toThrow("passkey ceremony");
  });

  test("allows only exact localhost HTTP as the loopback WebAuthn origin", async () => {
    const { canonicalWebAuthnOrigin } = await import("../integrations/model.ts");
    expect(canonicalWebAuthnOrigin("http://localhost:4747")).toBe("http://localhost:4747");
    expect(() => canonicalWebAuthnOrigin("http://127.0.0.1:4747")).toThrow();
    expect(() => canonicalWebAuthnOrigin("http://localhost.evil.example")).toThrow();
  });
});
