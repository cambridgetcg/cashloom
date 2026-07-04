/** Local non-custodial key custody — PROTOCOL.md §5.2 made real.
 *
 *  Argon2id(passphrase) → AES-256-GCM. Key material is sealed at rest in
 *  SQLite, decrypted only in memory, only while the vault is unlocked, only
 *  to sign. Plaintext keys NEVER touch disk, logs, or the network — CashLoom
 *  signs locally and broadcasts the *signed* transaction.
 *
 *  Unlock model: one passphrase, one derived master key, held in module
 *  memory. lock() drops it. There is no recovery — the passphrase IS
 *  custody. (JS cannot truly zeroize memory; exposure is kept short and
 *  nothing plaintext is ever retained on an object that outlives a call.)
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { NETWORK, WIF, p2wpkh } from "@scure/btc-signer";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db, newId } from "./db.ts";

// 64 MiB, 3 passes — interactive-unlock cost (~1s), memory-hard against GPUs.
const ARGON2 = { m: 65536, t: 3, p: 1, dkLen: 32 } as const;

const VERIFIER_PLAINTEXT = new TextEncoder().encode("cashloom-vault-v1");
const BLOB_VERSION = 1;

let masterKey: CryptoKey | null = null;
const sessions = new Set<string>();

/* ------------------------------- plumbing -------------------------------- */

const getSetting = (key: string): string | null => {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
};

const putSetting = (key: string, value: string): void => {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
};

const toHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));

const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
  const raw = argon2id(new TextEncoder().encode(passphrase), salt, ARGON2);
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};

const seal = async (key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> => {
  const nonce = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, plaintext as BufferSource)
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = BLOB_VERSION;
  out.set(nonce, 1);
  out.set(ct, 13);
  return out;
};

const unseal = async (key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> => {
  if (blob[0] !== BLOB_VERSION) {
    throw new Error(`Unknown vault blob version ${blob[0]}`);
  }
  const nonce = blob.slice(1, 13);
  const ct = blob.slice(13);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, ct as BufferSource)
  );
};

/* ------------------------------ vault state ------------------------------ */

export const isInitialized = (): boolean => getSetting("vault.salt") !== null;
export const isUnlocked = (): boolean => masterKey !== null;

/** First run: set the passphrase. Refuses if a vault already exists —
 *  re-initializing would orphan every sealed key. */
export const initialize = async (passphrase: string): Promise<void> => {
  if (isInitialized()) {
    throw new Error("Vault already initialized — unlock with the existing passphrase.");
  }
  if (passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters. It IS custody — make it strong.");
  }
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const verifier = await seal(key, VERIFIER_PLAINTEXT);
  putSetting("vault.salt", toHex(salt));
  putSetting("vault.verifier", toHex(verifier));
  masterKey = key;
};

/** Unlock: derive, verify against the sealed verifier, hold in memory.
 *  Returns a session token for the HTTP layer. */
export const unlock = async (passphrase: string): Promise<string> => {
  const saltHex = getSetting("vault.salt");
  const verifierHex = getSetting("vault.verifier");
  if (!saltHex || !verifierHex) {
    throw new Error("Vault not initialized — set a passphrase first.");
  }
  const key = await deriveKey(passphrase, fromHex(saltHex));
  try {
    const check = await unseal(key, fromHex(verifierHex));
    if (toHex(check) !== toHex(VERIFIER_PLAINTEXT)) throw new Error("mismatch");
  } catch {
    // One error for every wrong-passphrase shape — no oracle.
    throw new Error("Wrong passphrase.");
  }
  masterKey = key;
  const token = crypto.randomUUID();
  sessions.add(token);
  return token;
};

export const lock = (): void => {
  masterKey = null;
  sessions.clear();
};

export const isValidSession = (token: string | undefined): boolean =>
  token !== undefined && sessions.has(token) && masterKey !== null;

const requireKey = (): CryptoKey => {
  if (!masterKey) throw new Error("Vault is locked.");
  return masterKey;
};

/* --------------------------------- keys ---------------------------------- */

export interface VaultKeyInfo {
  id: string;
  label: string;
  kind: string;
  address: string | null;
  created_at: string;
}

export const listKeys = (): VaultKeyInfo[] =>
  db
    .query("SELECT id, label, kind, address, created_at FROM vault_keys ORDER BY created_at")
    .all() as VaultKeyInfo[];

/** Generate a fresh EVM key, sealed at rest. Returns id + address only —
 *  the private key is never returned to any caller. */
export const generateEvmKey = async (label: string): Promise<VaultKeyInfo> => {
  const key = requireKey();
  const priv = generatePrivateKey();
  const address = privateKeyToAccount(priv).address;
  const blob = await seal(key, new TextEncoder().encode(priv));
  const id = newId();
  db.query(
    "INSERT INTO vault_keys (id, label, kind, address, enc_blob) VALUES (?, ?, 'evm', ?, ?)"
  ).run(id, label, address, blob);
  return { id, label, kind: "evm", address, created_at: new Date().toISOString() };
};

/** Import an existing EVM private key (0x-hex). Sealed immediately; the
 *  caller-supplied string is the only plaintext copy and it dies with the
 *  request. */
export const importEvmKey = async (label: string, privHex: string): Promise<VaultKeyInfo> => {
  const key = requireKey();
  const address = privateKeyToAccount(privHex as `0x${string}`).address; // throws on invalid
  const blob = await seal(key, new TextEncoder().encode(privHex));
  const id = newId();
  db.query(
    "INSERT INTO vault_keys (id, label, kind, address, enc_blob) VALUES (?, ?, 'evm', ?, ?)"
  ).run(id, label, address, blob);
  return { id, label, kind: "evm", address, created_at: new Date().toISOString() };
};

/* -------------------------------- BTC keys ------------------------------- */

// Mainnet P2WPKH from the COMPRESSED pubkey — the only standard-relayable
// shape for a segwit v0 key-path spend (WITNESS_PUBKEYTYPE policy).
const btcAddressFor = (priv: Uint8Array): string => {
  const address = p2wpkh(secp256k1.getPublicKey(priv, true), NETWORK).address;
  if (!address) throw new Error("Could not derive a P2WPKH address from this key.");
  return address;
};

// BTC key material is sealed as canonical 64-hex (no 0x — Bitcoin convention),
// whatever shape it arrived in, so revealForSigning has exactly one format
// per kind to hand back.
const sealBtcKey = async (label: string, priv: Uint8Array): Promise<VaultKeyInfo> => {
  const key = requireKey();
  if (!secp256k1.utils.isValidSecretKey(priv)) {
    throw new Error("Not a valid secp256k1 private key (out of curve range).");
  }
  const address = btcAddressFor(priv);
  const blob = await seal(key, new TextEncoder().encode(toHex(priv)));
  priv.fill(0); // best-effort zeroization — JS can't guarantee, but we try
  const id = newId();
  db.query(
    "INSERT INTO vault_keys (id, label, kind, address, enc_blob) VALUES (?, ?, 'btc', ?, ?)"
  ).run(id, label, address, blob);
  return { id, label, kind: "btc", address, created_at: new Date().toISOString() };
};

/** Generate a fresh BTC key (P2WPKH, mainnet), sealed at rest. Returns id +
 *  address only — the private key is never returned to any caller. */
export const generateBtcKey = async (label: string): Promise<VaultKeyInfo> =>
  sealBtcKey(label, secp256k1.utils.randomSecretKey());

/** Import an existing BTC private key — mainnet WIF (compressed only; the
 *  WIF codec refuses testnet prefixes, bad checksums, and uncompressed
 *  payloads) or raw 64-hex. The caller-supplied string is the only plaintext
 *  copy and it dies with the request. */
export const importBtcKey = async (label: string, secret: string): Promise<VaultKeyInfo> => {
  const trimmed = secret.trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return sealBtcKey(label, fromHex(trimmed.toLowerCase()));
  }
  let priv: Uint8Array;
  try {
    priv = WIF(NETWORK).decode(secret.trim());
  } catch {
    // One shaped error for every malformed input — never echo the secret.
    throw new Error(
      "That is not a usable BTC key: expected a mainnet WIF (compressed) or 64 hex characters. Uncompressed and testnet WIFs are refused — their spends would not relay."
    );
  }
  return sealBtcKey(label, priv);
};

/** Decrypt a key for SIGNING ONLY. Callers must never log, store, or return
 *  the value; it lives for the duration of one signature. Format follows the
 *  key's kind: evm keys reveal as 0x-hex, btc keys as bare 64-hex. */
export const revealForSigning = async (keyId: string): Promise<string> => {
  const key = requireKey();
  const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(keyId) as
    | { enc_blob: Uint8Array }
    | null;
  if (!row) throw new Error(`No vault key ${keyId}`);
  const plain = await unseal(key, new Uint8Array(row.enc_blob));
  return new TextDecoder().decode(plain);
};
