import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  canonicalizeJson,
  sha256DigestSchema,
  type JsonValue,
} from "../domain/intent.ts";
import type { Sha256Digest } from "./contracts.ts";

export const fingerprint = (value: JsonValue): Sha256Digest =>
  sha256DigestSchema.parse(
    `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalizeJson(value))))}`,
  );

export const randomAuthorizationState = (): string => crypto.randomUUID();
