/**
 * WebAuthn verification boundary for passkey-backed smart accounts.
 *
 * Browser payloads are hostile inputs. This module verifies the complete
 * WebAuthn ceremony locally and returns only bounded public evidence. It does
 * not claim hardware provenance when attestation is `none`, and it never
 * signs, submits, or talks to a chain.
 */
import { base64urlnopad } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Authentication, Authenticator, Registration } from "ox/webauthn";
import { PublicKey, Signature } from "ox";
import { z } from "zod";
import { sha256DigestSchema, type Sha256Digest } from "../domain/intent.ts";
import {
  IntegrationContractError,
  canonicalBase64UrlSchema,
  canonicalHexDataSchema,
  hashHexData,
  webAuthnAssertionCeremonySchema,
  webAuthnOriginHash,
  webAuthnRegistrationCeremonySchema,
  webAuthnVerifiedEvidenceSchema,
  type WebAuthnAssertionCeremony,
  type WebAuthnRegistrationCeremony,
  type WebAuthnVerifiedEvidence,
} from "../integrations/index.ts";

const MAX_CLIENT_DATA_BYTES = 16 * 1024;
const MAX_ATTESTATION_BYTES = 128 * 1024;
const MAX_AUTHENTICATOR_DATA_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 256;

const boundedB64u = (max: number) => canonicalBase64UrlSchema.refine(
  (value) => {
    try {
      return base64urlnopad.decode(value).length <= max;
    } catch {
      return false;
    }
  },
  `decoded WebAuthn value exceeds ${max} bytes`,
);

export const serializedRegistrationResponseSchema = z.object({
  id: boundedB64u(2048),
  raw_id: boundedB64u(2048),
  type: z.literal("public-key"),
  authenticator_attachment: z.enum(["platform", "cross-platform"]).nullable().optional(),
  response: z.object({
    client_data_json: boundedB64u(MAX_CLIENT_DATA_BYTES),
    attestation_object: boundedB64u(MAX_ATTESTATION_BYTES),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).max(8).optional(),
  }).strict(),
}).strict().readonly();

export type SerializedRegistrationResponse = z.infer<
  typeof serializedRegistrationResponseSchema
>;

export const serializedAssertionResponseSchema = z.object({
  id: boundedB64u(2048),
  raw_id: boundedB64u(2048),
  type: z.literal("public-key"),
  authenticator_attachment: z.enum(["platform", "cross-platform"]).nullable().optional(),
  response: z.object({
    client_data_json: boundedB64u(MAX_CLIENT_DATA_BYTES),
    authenticator_data: boundedB64u(MAX_AUTHENTICATOR_DATA_BYTES),
    signature: boundedB64u(MAX_SIGNATURE_BYTES),
    user_handle: boundedB64u(1024).nullable().optional(),
  }).strict(),
}).strict().readonly();

export type SerializedAssertionResponse = z.infer<
  typeof serializedAssertionResponseSchema
>;

export interface VerifiedPasskeyCredential {
  readonly credential_id: string;
  readonly public_key: `0x${string}`;
  readonly sign_count: string;
  readonly counter_supported: boolean;
  readonly user_verified: true;
  readonly backup_eligible: boolean;
  readonly backed_up: boolean;
  readonly device_type: "single_device" | "multi_device";
  /** `none` deliberately makes no hardware/security-level claim. */
  readonly attestation_assurance: "none";
  readonly transports: readonly string[];
}

export interface VerifiedRegistration {
  readonly credential: VerifiedPasskeyCredential;
  readonly evidence: Readonly<{
    schema_version: "cashloom.webauthn-registration-evidence/1";
    ceremony_id: string;
    credential_id: string;
    rp_id: string;
    origin_hash: Sha256Digest;
    attestation_object_hash: Sha256Digest;
    client_data_hash: Sha256Digest;
    user_present: true;
    user_verified: true;
    verified_at: string;
  }>;
}

export interface StoredPasskeyCredential {
  readonly credential_id: string;
  readonly public_key: `0x${string}`;
  readonly sign_count: string;
  readonly status: "ACTIVE";
}

export interface VerifiedAssertion {
  readonly evidence: WebAuthnVerifiedEvidence;
  readonly next_sign_count: string;
  readonly counter_supported: boolean;
}

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const bytesHash = (bytes: Uint8Array): Sha256Digest =>
  sha256DigestSchema.parse(`sha256:${bytesToHex(sha256(bytes))}`);

const decode = (value: string): Uint8Array => base64urlnopad.decode(value);

const hex = (bytes: Uint8Array): `0x${string}` =>
  canonicalHexDataSchema.parse(`0x${bytesToHex(bytes)}`) as `0x${string}`;

const parseClientData = (
  encoded: string,
  expectedType: "webauthn.create" | "webauthn.get",
): { readonly bytes: Uint8Array; readonly json: string } => {
  const bytes = decode(encoded);
  let json: string;
  let value: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
  const client = z.object({
    type: z.literal(expectedType),
    challenge: canonicalBase64UrlSchema,
    origin: z.string().min(1).max(2048),
    crossOrigin: z.literal(false).optional(),
    topOrigin: z.never().optional(),
  }).passthrough().safeParse(value);
  if (!client.success || "topOrigin" in client.data) {
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
  return { bytes, json };
};

const assertLiveBinding = (
  input: {
    expires_at: string;
    origin_hash: Sha256Digest;
    challenge_hash: Sha256Digest;
  },
  challenge: `0x${string}`,
  origin: string,
  now: Date,
): void => {
  if (
    now.getTime() >= Date.parse(input.expires_at) ||
    input.origin_hash !== webAuthnOriginHash(origin) ||
    input.challenge_hash !== hashHexData(challenge)
  ) {
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
};

const rawIdMatches = (id: string, rawId: string): boolean => {
  try {
    const left = decode(id);
    const right = decode(rawId);
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  } catch {
    return false;
  }
};

const authenticatorFlags = (data: Uint8Array): {
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
} => {
  if (data.length < 37) {
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
  const flags = data[32]!;
  return {
    userPresent: (flags & 0x01) === 0x01,
    userVerified: (flags & 0x04) === 0x04,
    backupEligible: (flags & 0x08) === 0x08,
    backedUp: (flags & 0x10) === 0x10,
  };
};

/** Verify an attestation-none registration. Enterprise attestation is a
 * separate policy product and is intentionally refused here. */
export const verifyPasskeyRegistration = (input: {
  readonly ceremony: WebAuthnRegistrationCeremony;
  readonly challenge: `0x${string}`;
  readonly origin: string;
  readonly response: SerializedRegistrationResponse;
  readonly now?: Date;
}): VerifiedRegistration => {
  try {
    const ceremony = webAuthnRegistrationCeremonySchema.parse(input.ceremony);
    const response = serializedRegistrationResponseSchema.parse(input.response);
    const challenge = canonicalHexDataSchema.parse(input.challenge) as `0x${string}`;
    const now = input.now ?? new Date();
    assertLiveBinding(ceremony, challenge, input.origin, now);
    if (ceremony.attestation_policy !== "none" || !rawIdMatches(response.id, response.raw_id)) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const clientData = parseClientData(response.response.client_data_json, "webauthn.create");
    const attestationBytes = decode(response.response.attestation_object);
    const verified = Registration.verify({
      attestation: "none",
      credential: {
        id: response.id,
        clientDataJSON: asArrayBuffer(clientData.bytes),
        attestationObject: asArrayBuffer(attestationBytes),
      },
      challenge,
      origin: input.origin,
      rpId: ceremony.rp_id,
      userVerification: "required",
    });
    if (!verified.userVerified) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const credentialId = verified.credential.id;
    if (credentialId !== response.id) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const counter = verified.counter.toString();
    const backupEligible = verified.deviceType === "multiDevice";
    const backedUp = verified.backedUp === true;
    const verifiedAt = now.toISOString();
    return Object.freeze({
      credential: Object.freeze({
        credential_id: credentialId,
        public_key: PublicKey.toHex(verified.credential.publicKey),
        sign_count: counter,
        counter_supported: counter !== "0",
        user_verified: true,
        backup_eligible: backupEligible,
        backed_up: backedUp,
        device_type: backupEligible ? "multi_device" : "single_device",
        attestation_assurance: "none",
        transports: Object.freeze([...(response.response.transports ?? [])].sort()),
      }),
      evidence: Object.freeze({
        schema_version: "cashloom.webauthn-registration-evidence/1",
        ceremony_id: ceremony.ceremony_id,
        credential_id: credentialId,
        rp_id: ceremony.rp_id,
        origin_hash: ceremony.origin_hash,
        attestation_object_hash: bytesHash(attestationBytes),
        client_data_hash: bytesHash(clientData.bytes),
        user_present: true,
        user_verified: true,
        verified_at: verifiedAt,
      }),
    });
  } catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
};

export const verifyPasskeyAssertion = (input: {
  readonly ceremony: WebAuthnAssertionCeremony;
  readonly challenge: `0x${string}`;
  readonly origin: string;
  readonly credential: StoredPasskeyCredential;
  readonly response: SerializedAssertionResponse;
  readonly now?: Date;
}): VerifiedAssertion => {
  try {
    const ceremony = webAuthnAssertionCeremonySchema.parse(input.ceremony);
    const response = serializedAssertionResponseSchema.parse(input.response);
    const challenge = canonicalHexDataSchema.parse(input.challenge) as `0x${string}`;
    const now = input.now ?? new Date();
    assertLiveBinding(ceremony, challenge, input.origin, now);
    if (
      input.credential.status !== "ACTIVE" ||
      input.credential.credential_id !== ceremony.credential_id ||
      response.id !== ceremony.credential_id ||
      !rawIdMatches(response.id, response.raw_id) ||
      input.credential.sign_count !== ceremony.prior_sign_count
    ) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const clientData = parseClientData(response.response.client_data_json, "webauthn.get");
    const authData = decode(response.response.authenticator_data);
    const signatureDer = decode(response.response.signature);
    const flags = authenticatorFlags(authData);
    if (!flags.userPresent || !flags.userVerified || (flags.backedUp && !flags.backupEligible)) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const metadata = {
      authenticatorData: hex(authData),
      clientDataJSON: clientData.json,
      userVerificationRequired: true,
    } as const;
    const valid = Authentication.verify({
      challenge,
      metadata,
      origin: input.origin,
      rpId: ceremony.rp_id,
      publicKey: PublicKey.from(input.credential.public_key),
      signature: Signature.fromDerBytes(signatureDer),
    });
    if (!valid) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const nextCount = Authenticator.getSignCount(metadata.authenticatorData).toString();
    const priorCount = BigInt(ceremony.prior_sign_count);
    const next = BigInt(nextCount);
    if ((priorCount > 0n && next <= priorCount) || (priorCount === 0n && next < 0n)) {
      throw new IntegrationContractError("webauthn_ceremony_refused");
    }
    const counterSupported = priorCount > 0n || next > 0n;
    const evidence = webAuthnVerifiedEvidenceSchema.parse({
      schema_version: "cashloom.webauthn-evidence/1",
      ceremony_id: ceremony.ceremony_id,
      credential_id: ceremony.credential_id,
      rp_id: ceremony.rp_id,
      origin_hash: ceremony.origin_hash,
      user_present: true,
      user_verified: true,
      sign_count: nextCount,
      authenticator_data_hash: bytesHash(authData),
      signature_hash: bytesHash(signatureDer),
      verified_at: now.toISOString(),
    });
    return Object.freeze({ evidence, next_sign_count: nextCount, counter_supported: counterSupported });
  } catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw new IntegrationContractError("webauthn_ceremony_refused");
  }
};

export const createWebAuthnChallenge = (): Readonly<{
  challenge: `0x${string}`;
  challenge_hash: Sha256Digest;
}> => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = hex(bytes);
  return Object.freeze({ challenge, challenge_hash: hashHexData(challenge) });
};
