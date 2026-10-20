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
import { NETWORK, Transaction, WIF, p2wpkh } from "@scure/btc-signer";
import type { Hex, TransactionSerializable } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as ed25519 from "@noble/ed25519";
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
// whatever shape it arrived in, so in-vault signing has exactly one format
// per kind to decode.
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

/* ------------------------------ ed25519 keys ----------------------------- */

/** Generate a fresh ed25519 key, sealed at rest — cashloom's record-signing
 *  AUTHORITY for @agenttool/wallet host records (e.g. an agent-payment
 *  authorization). Signs records, never money: an ed25519 key can't spend an
 *  evm/btc account, so this authority can attest but not move funds. Stored as
 *  kind 'secret'; the address column carries the base64url public key so it is
 *  visible in listKeys. The 32-byte seed is sealed as 64-hex; signRecord uses
 *  it inside the vault for one signature at a time. */
export const generateEd25519Key = async (label: string): Promise<VaultKeyInfo> => {
  const key = requireKey();
  const seed = ed25519.utils.randomPrivateKey();
  const pub = await ed25519.getPublicKeyAsync(seed);
  const address = Buffer.from(pub).toString("base64url");
  const blob = await seal(key, new TextEncoder().encode(Buffer.from(seed).toString("hex")));
  seed.fill(0); // best-effort zeroization
  const id = newId();
  db.query(
    "INSERT INTO vault_keys (id, label, kind, address, enc_blob) VALUES (?, ?, 'secret', ?, ?)"
  ).run(id, label, address, blob);
  return { id, label, kind: "secret", address, created_at: new Date().toISOString() };
};

/* ---------------------------- in-vault signing --------------------------- */

// Private keys never leave this module. Each primitive below decrypts one key
// for one signature, refuses a key of the wrong kind, and zeroizes the
// decrypted bytes before it returns, whatever happens. Callers get back only a
// signature or a signed transaction: @agenttool/wallet's exportable:false.

type KeyKind = "evm" | "btc" | "secret";

interface SealedKeyRow {
  kind: string;
  address: string | null;
  enc_blob: Uint8Array;
}

const withDecryptedKey = async <T>(
  keyId: string,
  kind: KeyKind,
  use: (plain: Uint8Array, row: SealedKeyRow) => Promise<T>
): Promise<T> => {
  const key = requireKey();
  const row = db
    .query("SELECT kind, address, enc_blob FROM vault_keys WHERE id = ?")
    .get(keyId) as SealedKeyRow | null;
  if (!row) throw new Error(`No vault key ${keyId}`);
  if (row.kind !== kind) {
    throw new Error(`Vault key ${keyId} is a ${row.kind} key; this signature needs a ${kind} key.`);
  }
  const plain = await unseal(key, new Uint8Array(row.enc_blob));
  try {
    return await use(plain, row);
  } finally {
    plain.fill(0);
  }
};

const hexNibble = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;

// Decode sealed 64-hex key text straight from the decrypted bytes, so no
// string copy of the key (which JS could never zeroize) is made.
const keyBytesFromHexText = (text: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  let ok = text.length === 64;
  for (let i = 0; ok && i < 32; i++) {
    const hi = hexNibble(text[2 * i]!);
    const lo = hexNibble(text[2 * i + 1]!);
    ok = hi >= 0 && lo >= 0;
    out[i] = (hi << 4) | lo;
  }
  if (ok) return out;
  out.fill(0);
  throw new Error("Vault key material is not a 32-byte hex key.");
};

/** Sign one EVM transaction with a vault key and return the serialized signed
 *  transaction. Refuses unless the key derives `expectedFrom`. viem accepts a
 *  key only as a hex string, which JS cannot zeroize; that string lives inside
 *  this call and is never returned. */
export const signEvmTransaction = async (
  keyId: string,
  expectedFrom: string,
  request: TransactionSerializable
): Promise<Hex> =>
  withDecryptedKey(keyId, "evm", async (plain) => {
    const account = privateKeyToAccount(new TextDecoder().decode(plain) as Hex);
    if (account.address.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new Error("The vault's EVM key does not match the quoted sending address.");
    }
    return account.signTransaction(request);
  });

/** Sign every input of a prepared BTC transaction that this vault key can
 *  sign, and return how many it signed. Only a real @scure/btc-signer
 *  Transaction is accepted, so a look-alike object's sign() never receives
 *  key bytes. */
export const signBtcTransaction = async (keyId: string, tx: Transaction): Promise<number> => {
  if (!(tx instanceof Transaction)) {
    throw new Error("signBtcTransaction needs a @scure/btc-signer Transaction.");
  }
  return withDecryptedKey(keyId, "btc", async (plain) => {
    const priv = keyBytesFromHexText(plain);
    try {
      return tx.sign(priv);
    } finally {
      priv.fill(0);
    }
  });
};

/** Sign one record digest with a vault-held ed25519 authority key (kind
 *  'secret') and return the 64-byte signature: @agenttool/wallet's
 *  RecordSigner.sign_digest with the seed kept inside the vault. Refuses if the
 *  decrypted seed no longer derives the public key recorded for it. */
export const signRecord = async (keyId: string, digest: Uint8Array): Promise<Uint8Array> => {
  if (!(digest instanceof Uint8Array) || digest.byteLength === 0) {
    throw new Error("signRecord needs a non-empty digest.");
  }
  return withDecryptedKey(keyId, "secret", async (plain, row) => {
    const seed = keyBytesFromHexText(plain);
    try {
      const publicKey = Buffer.from(await ed25519.getPublicKeyAsync(seed)).toString("base64url");
      if (publicKey !== row.address) {
        throw new Error(`Vault key ${keyId} does not match its recorded public key.`);
      }
      return await ed25519.signAsync(digest, seed);
    } finally {
      seed.fill(0);
    }
  });
};
