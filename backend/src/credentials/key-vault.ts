// Local non-custodial key custody. A crypto private key is encrypted with a key
// derived from the user's passphrase (scrypt, memory-hard) via AES-256-GCM
// (authenticated: a wrong passphrase fails the GCM tag, never silently). The
// blob carries salt + iv + ciphertext + tag — never the passphrase, never the
// plaintext. Keys never leave the machine; this module never logs.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import { BadRequestException } from "../utils/app-error";

const KEY_LEN = 32; // 256-bit AES key
const SCRYPT_N = 16384; // ~0.2s on a laptop; memory-hard
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LEN = 16;
const IV_LEN = 12; // GCM nonce

export interface EncryptedBlob {
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64 (GCM auth tag)
  v: 1; // format version
}

const b64 = (b: Buffer): string => b.toString("base64");
const fromB64 = (s: string): Buffer => Buffer.from(s, "base64");

const deriveKey = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

export const encryptKey = (passphrase: string, plaintext: Buffer): EncryptedBlob => {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), tag: b64(tag), v: 1 };
};

export const decryptKey = (passphrase: string, blob: EncryptedBlob): Buffer => {
  if (blob.v !== 1) throw new BadRequestException("Unknown key blob version");
  const salt = fromB64(blob.salt);
  const key = deriveKey(passphrase, salt);
  const iv = fromB64(blob.iv);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(fromB64(blob.tag));
  try {
    return Buffer.concat([
      decipher.update(fromB64(blob.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    // GCM auth-tag mismatch = wrong passphrase or a tampered blob. Never say
    // which; never log the passphrase or blob.
    throw new BadRequestException(
      "Could not decrypt key — wrong passphrase or corrupted blob"
    );
  }
};