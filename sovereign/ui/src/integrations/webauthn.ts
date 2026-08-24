import {
  base64UrlToBytes,
  BrowserIntegrationError,
  bytesToBase64Url,
  exactKeys,
} from "./encoding";

const MAX_CREDENTIAL_ID = 2_048;
const MAX_CLIENT_DATA = 16 * 1024;
const MAX_ATTESTATION = 128 * 1024;
const MAX_AUTHENTICATOR_DATA = 16 * 1024;
const MAX_SIGNATURE = 256;

type Transport = AuthenticatorTransport | "cable" | "smart-card";
const TRANSPORTS = new Set<string>(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const USER_VERIFICATION = new Set<string>(["discouraged", "preferred", "required"]);
const ATTACHMENTS = new Set<string>(["platform", "cross-platform"]);
const RESIDENT_KEYS = new Set<string>(["discouraged", "preferred", "required"]);
const ATTESTATION = new Set<string>(["none", "indirect", "direct", "enterprise"]);

export interface RegistrationOptionsWire {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly display_name: string };
  readonly pub_key_cred_params: readonly { readonly type: "public-key"; readonly alg: number }[];
  readonly timeout_ms?: number;
  readonly attestation?: AttestationConveyancePreference;
  readonly authenticator_selection?: {
    readonly authenticator_attachment?: AuthenticatorAttachment;
    readonly resident_key?: ResidentKeyRequirement;
    readonly user_verification?: UserVerificationRequirement;
  };
  readonly exclude_credentials?: readonly {
    readonly type: "public-key";
    readonly id: string;
    readonly transports?: readonly Transport[];
  }[];
}

export interface AssertionOptionsWire {
  readonly challenge: string;
  readonly rp_id: string;
  readonly timeout_ms?: number;
  readonly user_verification?: UserVerificationRequirement;
  readonly allow_credentials?: readonly {
    readonly type: "public-key";
    readonly id: string;
    readonly transports?: readonly Transport[];
  }[];
}

const rpId = (value: string): string => {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)
  ) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return value;
};

const boundedTimeout = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return value;
};

const credentialDescriptors = (
  values: RegistrationOptionsWire["exclude_credentials"] | AssertionOptionsWire["allow_credentials"],
): PublicKeyCredentialDescriptor[] | undefined => {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 64) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return values.map((value) => {
    if (
      !exactKeys(value, ["type", "id", ...(value.transports === undefined ? [] : ["transports"])]) ||
      value.type !== "public-key" ||
      typeof value.id !== "string" ||
      (value.transports !== undefined &&
        (!Array.isArray(value.transports) || value.transports.length > 8 ||
          value.transports.some((transport) =>
            typeof transport !== "string" || !TRANSPORTS.has(transport)
          ) ||
          new Set(value.transports).size !== value.transports.length))
    ) {
      throw new BrowserIntegrationError("webauthn_refused");
    }
    return {
      type: "public-key",
      id: base64UrlToBytes(value.id as string, MAX_CREDENTIAL_ID),
      ...(value.transports ? { transports: [...value.transports] as AuthenticatorTransport[] } : {}),
    };
  });
};

/** Convert only an exact server-generated challenge/options envelope. */
export const deserializeRegistrationOptions = (
  input: RegistrationOptionsWire,
): PublicKeyCredentialCreationOptions => {
  if (
    !exactKeys(input, [
      "challenge",
      "rp",
      "user",
      "pub_key_cred_params",
      ...("timeout_ms" in input ? ["timeout_ms"] : []),
      ...("attestation" in input ? ["attestation"] : []),
      ...("authenticator_selection" in input ? ["authenticator_selection"] : []),
      ...("exclude_credentials" in input ? ["exclude_credentials"] : []),
    ]) ||
    !exactKeys(input.rp, ["id", "name"]) ||
    !exactKeys(input.user, ["id", "name", "display_name"]) ||
    typeof input.rp.name !== "string" || input.rp.name.trim() === "" || input.rp.name.length > 128 ||
    typeof input.user.name !== "string" || input.user.name.length > 128 ||
    typeof input.user.display_name !== "string" || input.user.display_name.length > 128 ||
    !Array.isArray(input.pub_key_cred_params) || input.pub_key_cred_params.length < 1 ||
    input.pub_key_cred_params.length > 16 ||
    input.pub_key_cred_params.some((entry) =>
      !exactKeys(entry, ["type", "alg"]) || entry.type !== "public-key" || !Number.isSafeInteger(entry.alg)
    ) ||
    (input.attestation !== undefined && !ATTESTATION.has(input.attestation)) ||
    (input.authenticator_selection !== undefined &&
      (!exactKeys(input.authenticator_selection, [
        ...(input.authenticator_selection.authenticator_attachment === undefined ? [] : ["authenticator_attachment"]),
        ...(input.authenticator_selection.resident_key === undefined ? [] : ["resident_key"]),
        ...(input.authenticator_selection.user_verification === undefined ? [] : ["user_verification"]),
      ]) ||
        (input.authenticator_selection.authenticator_attachment !== undefined &&
          !ATTACHMENTS.has(input.authenticator_selection.authenticator_attachment)) ||
        (input.authenticator_selection.resident_key !== undefined &&
          !RESIDENT_KEYS.has(input.authenticator_selection.resident_key)) ||
        (input.authenticator_selection.user_verification !== undefined &&
          !USER_VERIFICATION.has(input.authenticator_selection.user_verification))))
  ) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return {
    challenge: base64UrlToBytes(input.challenge, 128),
    rp: { id: rpId(input.rp.id), name: input.rp.name },
    user: {
      id: base64UrlToBytes(input.user.id, 128),
      name: input.user.name,
      displayName: input.user.display_name,
    },
    pubKeyCredParams: input.pub_key_cred_params.map((entry) => ({ ...entry })),
    ...(boundedTimeout(input.timeout_ms) === undefined ? {} : { timeout: input.timeout_ms }),
    ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
    ...(input.authenticator_selection === undefined
      ? {}
      : {
          authenticatorSelection: {
            ...(input.authenticator_selection.authenticator_attachment === undefined
              ? {}
              : { authenticatorAttachment: input.authenticator_selection.authenticator_attachment }),
            ...(input.authenticator_selection.resident_key === undefined
              ? {}
              : { residentKey: input.authenticator_selection.resident_key }),
            ...(input.authenticator_selection.user_verification === undefined
              ? {}
              : { userVerification: input.authenticator_selection.user_verification }),
          },
        }),
    ...(input.exclude_credentials === undefined
      ? {}
      : { excludeCredentials: credentialDescriptors(input.exclude_credentials) }),
  };
};

export const deserializeAssertionOptions = (
  input: AssertionOptionsWire,
): PublicKeyCredentialRequestOptions => {
  if (!exactKeys(input, [
    "challenge",
    "rp_id",
    ...("timeout_ms" in input ? ["timeout_ms"] : []),
    ...("user_verification" in input ? ["user_verification"] : []),
    ...("allow_credentials" in input ? ["allow_credentials"] : []),
  ]) || (input.user_verification !== undefined && !USER_VERIFICATION.has(input.user_verification))) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return {
    challenge: base64UrlToBytes(input.challenge, 128),
    rpId: rpId(input.rp_id),
    ...(boundedTimeout(input.timeout_ms) === undefined ? {} : { timeout: input.timeout_ms }),
    ...(input.user_verification === undefined ? {} : { userVerification: input.user_verification }),
    ...(input.allow_credentials === undefined
      ? {}
      : { allowCredentials: credentialDescriptors(input.allow_credentials) }),
  };
};

export interface SerializedRegistrationResponse {
  readonly id: string;
  readonly raw_id: string;
  readonly type: "public-key";
  readonly authenticator_attachment?: AuthenticatorAttachment | null;
  readonly response: {
    readonly client_data_json: string;
    readonly attestation_object: string;
    readonly transports?: readonly Transport[];
  };
}

export interface SerializedAssertionResponse {
  readonly id: string;
  readonly raw_id: string;
  readonly type: "public-key";
  readonly authenticator_attachment?: AuthenticatorAttachment | null;
  readonly response: {
    readonly client_data_json: string;
    readonly authenticator_data: string;
    readonly signature: string;
    readonly user_handle?: string | null;
  };
}

const credentialCore = (credential: PublicKeyCredential): Readonly<{
  id: string;
  raw_id: string;
  type: "public-key";
  authenticator_attachment?: AuthenticatorAttachment | null;
}> => {
  const rawId = bytesToBase64Url(credential.rawId);
  const attachment = credential.authenticatorAttachment;
  if (
    credential.type !== "public-key" ||
    typeof credential.id !== "string" ||
    credential.id !== rawId ||
    credential.id.length > MAX_CREDENTIAL_ID ||
    (attachment !== undefined && attachment !== null &&
      attachment !== "platform" && attachment !== "cross-platform")
  ) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return {
    id: credential.id,
    raw_id: rawId,
    type: "public-key" as const,
    ...(attachment === undefined
      ? {}
      : { authenticator_attachment: attachment }),
  };
};

const responseBytes = (value: ArrayBuffer, maxBytes: number): string => {
  const encoded = bytesToBase64Url(value);
  base64UrlToBytes(encoded, maxBytes);
  return encoded;
};

export const serializeRegistrationCredential = (
  credential: PublicKeyCredential,
): SerializedRegistrationResponse => {
  const response = credential.response as AuthenticatorAttestationResponse;
  if (!(response.clientDataJSON instanceof ArrayBuffer) || !(response.attestationObject instanceof ArrayBuffer)) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
  if (transports?.some((transport) =>
    !["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(transport)
  )) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return Object.freeze({
    ...credentialCore(credential),
    response: Object.freeze({
      client_data_json: responseBytes(response.clientDataJSON, MAX_CLIENT_DATA),
      attestation_object: responseBytes(response.attestationObject, MAX_ATTESTATION),
      ...(transports === undefined
        ? {}
        : { transports: Object.freeze([...transports]) as readonly Transport[] }),
    }),
  });
};

export const serializeAssertionCredential = (
  credential: PublicKeyCredential,
): SerializedAssertionResponse => {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (
    !(response.clientDataJSON instanceof ArrayBuffer) ||
    !(response.authenticatorData instanceof ArrayBuffer) ||
    !(response.signature instanceof ArrayBuffer) ||
    (response.userHandle !== null && !(response.userHandle instanceof ArrayBuffer))
  ) {
    throw new BrowserIntegrationError("webauthn_refused");
  }
  return Object.freeze({
    ...credentialCore(credential),
    response: Object.freeze({
      client_data_json: responseBytes(response.clientDataJSON, MAX_CLIENT_DATA),
      authenticator_data: responseBytes(response.authenticatorData, MAX_AUTHENTICATOR_DATA),
      signature: responseBytes(response.signature, MAX_SIGNATURE),
      user_handle: response.userHandle === null
        ? null
        : responseBytes(response.userHandle, 1_024),
    }),
  });
};
