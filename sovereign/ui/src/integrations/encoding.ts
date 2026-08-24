const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type Sha256Digest = `sha256:${string}`;

export class BrowserIntegrationError extends Error {
  constructor(
    readonly code:
      | "integration_invalid"
      | "integration_expired"
      | "integration_cancelled"
      | "webauthn_refused"
      | "hardware_refused"
      | "walletconnect_refused",
  ) {
    const messages = {
      integration_invalid: "The browser integration request is invalid.",
      integration_expired: "The browser integration request has expired.",
      integration_cancelled: "The browser integration was cancelled.",
      webauthn_refused: "The passkey response did not match its ceremony.",
      hardware_refused: "The hardware signer did not match its approved handoff.",
      walletconnect_refused: "The WalletConnect session did not match its approved request.",
    } as const;
    super(messages[code]);
    this.name = "BrowserIntegrationError";
  }
}

const binary = (bytes: Uint8Array): string => {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return value;
};

export const bytesToBase64Url = (input: BufferSource): string => {
  const source = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (source.length === 0) throw new BrowserIntegrationError("integration_invalid");
  return btoa(binary(source)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

export const base64UrlToBytes = (value: string, maxBytes: number): Uint8Array => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !BASE64URL.test(value) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  ) {
    throw new BrowserIntegrationError("integration_invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new BrowserIntegrationError("integration_invalid");
  }
  if (decoded.length === 0 || decoded.length > maxBytes) {
    throw new BrowserIntegrationError("integration_invalid");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) {
    throw new BrowserIntegrationError("integration_invalid");
  }
  return bytes;
};

export const utf8 = (value: string, maxBytes: number): Uint8Array => {
  if (typeof value !== "string") throw new BrowserIntegrationError("integration_invalid");
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new BrowserIntegrationError("integration_invalid");
  }
  return bytes;
};

export const sha256 = async (bytes: Uint8Array): Promise<Sha256Digest> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const value = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!SHA256.test(value)) throw new BrowserIntegrationError("integration_invalid");
  return value as Sha256Digest;
};

export const hashUtf8 = async (value: string, maxBytes = 16_384): Promise<Sha256Digest> =>
  sha256(utf8(value, maxBytes));

export type CanonicalJson =
  | null
  | boolean
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export const canonicalize = (value: CanonicalJson): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize((value as Record<string, CanonicalJson>)[key]!)}`
    ).join(",")}}`;
  }
  throw new BrowserIntegrationError("integration_invalid");
};

export const hashCanonical = async (value: CanonicalJson): Promise<Sha256Digest> =>
  hashUtf8(canonicalize(value), 256 * 1024);

export const canonicalTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  new Date(value).toISOString() === value;

export const assertLive = (expiresAt: string, now: Date): void => {
  if (
    !canonicalTimestamp(expiresAt) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() >= Date.parse(expiresAt)
  ) {
    throw new BrowserIntegrationError("integration_expired");
  }
};

export const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
