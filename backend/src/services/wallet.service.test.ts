import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  publicKeyToDID,
  encryptPrivateKey,
  decryptPrivateKey,
} from "./wallet.service";

describe("Wallet — key generation", () => {
  it("generates an Ed25519 keypair with the right sizes", () => {
    const { publicKeyHex, privateKeyHex } = generateKeyPair();

    // Public key: 64 hex chars = 32 bytes (Ed25519)
    expect(publicKeyHex).toHaveLength(64);
    expect(publicKeyHex).toMatch(/^[0-9a-f]+$/);

    // Private key: should be non-empty hex
    expect(privateKeyHex.length).toBeGreaterThan(0);
    expect(privateKeyHex).toMatch(/^[0-9a-f]+$/);
  });

  it("generates unique keypairs each time", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });
});

describe("Wallet — DID derivation", () => {
  it("derives did:lgm:{first 32 hex chars} from a public key", () => {
    const pubKey = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const did = publicKeyToDID(pubKey);
    expect(did).toBe("did:lgm:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
  });

  it("matches the Legible Money protocol's PublicKeyToDID format", () => {
    const { publicKeyHex } = generateKeyPair();
    const did = publicKeyToDID(publicKeyHex);
    expect(did).toMatch(/^did:lgm:[0-9a-f]{32}$/);
    // The DID suffix is the first 32 chars of the pubkey
    expect(did.slice(8)).toBe(publicKeyHex.slice(0, 32).toLowerCase());
  });

  it("throws on a too-short public key", () => {
    expect(() => publicKeyToDID("abc")).toThrow();
  });
});

describe("Wallet — private key encryption", () => {
  it("encrypts and decrypts a private key round-trip", () => {
    const { privateKeyHex } = generateKeyPair();
    const secret = "test-secret-for-encryption";

    const encrypted = encryptPrivateKey(privateKeyHex, secret);
    const decrypted = decryptPrivateKey(encrypted, secret);

    expect(decrypted).toBe(privateKeyHex);
  });

  it("fails to decrypt with the wrong secret", () => {
    const { privateKeyHex } = generateKeyPair();
    const encrypted = encryptPrivateKey(privateKeyHex, "correct-secret");

    expect(() => decryptPrivateKey(encrypted, "wrong-secret")).toThrow();
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const { privateKeyHex } = generateKeyPair();
    const a = encryptPrivateKey(privateKeyHex, "secret");
    const b = encryptPrivateKey(privateKeyHex, "secret");
    expect(a).not.toBe(b);
  });
});