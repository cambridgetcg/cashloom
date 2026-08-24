import { describe, expect, test } from "bun:test";
import {
  bytesToBase64Url,
  deserializeAssertionOptions,
  deserializeRegistrationOptions,
  serializeAssertionCredential,
  serializeRegistrationCredential,
} from "../src/integrations";

const buffer = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

const credential = (
  rawId: ArrayBuffer,
  response: AuthenticatorResponse,
  extras: Record<string, unknown> = {},
): PublicKeyCredential => ({
  id: bytesToBase64Url(rawId),
  rawId,
  type: "public-key",
  authenticatorAttachment: "platform",
  response,
  getClientExtensionResults: () => ({ secret_extension: "must-not-leak" }) as AuthenticationExtensionsClientOutputs,
  ...extras,
}) as unknown as PublicKeyCredential;

describe("browser WebAuthn boundary", () => {
  test("deserializes only exact server registration and assertion challenges", () => {
    const challenge = bytesToBase64Url(buffer(1, 2, 3, 4));
    const userId = bytesToBase64Url(buffer(5, 6, 7, 8));
    const creation = deserializeRegistrationOptions({
      challenge,
      rp: { id: "cashloom.example", name: "CashLoom" },
      user: { id: userId, name: "owner", display_name: "Local owner" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
      timeout_ms: 60_000,
      attestation: "none",
      authenticator_selection: {
        authenticator_attachment: "platform",
        resident_key: "required",
        user_verification: "required",
      },
    });
    expect(bytesToBase64Url(creation.challenge)).toBe(challenge);
    expect(creation.rp.id).toBe("cashloom.example");
    expect(bytesToBase64Url(creation.user.id)).toBe(userId);
    expect(creation.authenticatorSelection).toEqual({
      authenticatorAttachment: "platform",
      residentKey: "required",
      userVerification: "required",
    });

    const assertion = deserializeAssertionOptions({
      challenge,
      rp_id: "cashloom.example",
      user_verification: "required",
      allow_credentials: [{ type: "public-key", id: userId, transports: ["internal"] }],
    });
    expect(bytesToBase64Url(assertion.challenge)).toBe(challenge);
    expect(assertion.rpId).toBe("cashloom.example");
    expect(bytesToBase64Url(assertion.allowCredentials![0]!.id)).toBe(userId);

    expect(() => deserializeAssertionOptions({
      challenge,
      rp_id: "cashloom.example",
      injected_origin: "https://evil.invalid",
    } as never)).toThrow("passkey response");
    expect(() => deserializeRegistrationOptions({
      challenge: "not+padded=",
      rp: { id: "cashloom.example", name: "CashLoom" },
      user: { id: userId, name: "owner", display_name: "Owner" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
    })).toThrow();
  });

  test("serializes registration to the exact snake-case server wire", () => {
    const rawId = buffer(10, 11, 12);
    const client = buffer(1, 2, 3);
    const attestation = buffer(4, 5, 6);
    const response = {
      clientDataJSON: client,
      attestationObject: attestation,
      getTransports: () => ["internal"],
      secret_pin: "1234",
    } as unknown as AuthenticatorAttestationResponse;
    const wire = serializeRegistrationCredential(credential(rawId, response, {
      device_serial: "SERIAL-CANARY",
    }));
    expect(wire).toEqual({
      id: bytesToBase64Url(rawId),
      raw_id: bytesToBase64Url(rawId),
      type: "public-key",
      authenticator_attachment: "platform",
      response: {
        client_data_json: bytesToBase64Url(client),
        attestation_object: bytesToBase64Url(attestation),
        transports: ["internal"],
      },
    });
    expect(JSON.stringify(wire)).not.toContain("SERIAL-CANARY");
    expect(JSON.stringify(wire)).not.toContain("secret_pin");
    expect(JSON.stringify(wire)).not.toContain("secret_extension");
  });

  test("serializes assertion bytes once without retaining browser objects", () => {
    const rawId = buffer(20, 21, 22);
    const clientBytes = new Uint8Array([1, 2, 3]);
    const response = {
      clientDataJSON: clientBytes.buffer,
      authenticatorData: buffer(4, 5, 6),
      signature: buffer(7, 8, 9),
      userHandle: null,
      apdu: "APDU-CANARY",
    } as unknown as AuthenticatorAssertionResponse;
    const wire = serializeAssertionCredential(credential(rawId, response));
    clientBytes[0] = 99;
    expect(wire).toEqual({
      id: bytesToBase64Url(rawId),
      raw_id: bytesToBase64Url(rawId),
      type: "public-key",
      authenticator_attachment: "platform",
      response: {
        client_data_json: "AQID",
        authenticator_data: "BAUG",
        signature: "BwgJ",
        user_handle: null,
      },
    });
    expect(JSON.stringify(wire)).not.toContain("APDU-CANARY");
  });
});
