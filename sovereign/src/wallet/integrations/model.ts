/**
 * Networkless primitives shared by external-wallet integration contracts.
 *
 * These values are intentionally identifiers, hashes, and canonical byte
 * encodings only. Pairing URIs, provider endpoints, OAuth codes/tokens,
 * WebAuthn challenges, APDUs, PINs, and raw webhook bodies belong in a
 * short-lived secret transport layer, never in these durable contracts.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { canonicalizeJson, sha256DigestSchema, type JsonValue, type Sha256Digest, walletOpaqueIdSchema } from "../domain/intent";

export const integrationOpaqueIdSchema = walletOpaqueIdSchema;

export const canonicalBase64UrlSchema = z.string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+$/, "expected unpadded base64url data");

export const canonicalHexDataSchema = z.string()
  .max(131_074)
  .regex(/^0x(?:[0-9a-f]{2})*$/, "expected canonical lowercase byte-aligned hex data");

export const evmAddressSchema = z.string()
  .regex(/^0x[0-9a-f]{40}$/, "expected a lowercase 20-byte EVM address");

export const bytes32Schema = z.string()
  .regex(/^0x[0-9a-f]{64}$/, "expected a lowercase 32-byte hex value");

/** Decimal unsigned integers are never parsed through Number. */
export const unsignedIntegerSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "expected a canonical unsigned decimal integer")
  .max(78);

export const hashUtf8 = (value: string): Sha256Digest =>
  sha256DigestSchema.parse(`sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`);

export const hashHexData = (value: string): Sha256Digest => {
  const hex = canonicalHexDataSchema.parse(value).slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return sha256DigestSchema.parse(`sha256:${bytesToHex(sha256(bytes))}`);
};

/** Canonical JSON hashes are local binding hashes, not protocol signatures. */
export const hashCanonicalContract = (value: JsonValue): Sha256Digest =>
  hashUtf8(canonicalizeJson(value));

/**
 * WebAuthn verifies the browser's full origin. Durable records hold only its
 * hash; callers must calculate this from a fixed deployment configuration.
 */
export const canonicalWebAuthnOrigin = (originInput: string): string => {
  let origin: URL;
  try {
    origin = new URL(originInput);
  } catch {
    throw new TypeError("WebAuthn origin must be an absolute HTTPS origin");
  }
  const secureProductionOrigin = origin.protocol === "https:";
  const localDevelopmentOrigin =
    origin.protocol === "http:" && origin.hostname === "localhost";
  if (
    (!secureProductionOrigin && !localDevelopmentOrigin) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError(
      "WebAuthn origin must be canonical HTTPS or the exact loopback http://localhost origin",
    );
  }
  return origin.origin;
};

export const webAuthnOriginHash = (origin: string): Sha256Digest =>
  hashUtf8(canonicalWebAuthnOrigin(origin));

export const webAuthnRpIdSchema = z.string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, "expected a lowercase DNS RP ID");

export const assertRpIdMatchesOrigin = (rpIdInput: string, originInput: string): void => {
  const rpId = webAuthnRpIdSchema.parse(rpIdInput);
  const hostname = new URL(canonicalWebAuthnOrigin(originInput)).hostname;
  // A parent-domain RP ID is legal only after a Public Suffix List check. The
  // loopback-first node deliberately has no ambient PSL dependency, so exact
  // host equality is the only policy we can prove locally. This also refuses
  // dangerous public suffixes such as `com`.
  if (hostname !== rpId) {
    throw new TypeError("WebAuthn RP ID must exactly equal the configured origin host");
  }
};

/** Build the only RP/origin pair a ceremony constructor may persist. */
export const createWebAuthnRpOriginBinding = (rpId: string, origin: string): Readonly<{
  rp_id: string;
  origin_hash: Sha256Digest;
}> => {
  assertRpIdMatchesOrigin(rpId, origin);
  return Object.freeze({ rp_id: webAuthnRpIdSchema.parse(rpId), origin_hash: webAuthnOriginHash(origin) });
};

export const boundedString = (max: number, expression: RegExp, message: string) =>
  z.string().min(1).max(max).regex(expression, message);
