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
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Address, NETWORK, OutScript, RawTx, Transaction, WIF, p2wpkh } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { isAddress, isHex, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as ed25519 from "@noble/ed25519";
import { db, newId } from "./db.ts";
import { canonicalizeJson, type JsonValue } from "./wallet/domain/intent.ts";
import { WalletKernelStore } from "./wallet/infrastructure/sqlite/index.ts";

const walletKernelStore = new WalletKernelStore(db);

// 64 MiB, 3 passes — interactive-unlock cost (~1s), memory-hard against GPUs.
const ARGON2 = { m: 65536, t: 3, p: 1, dkLen: 32 } as const;

const VERIFIER_PLAINTEXT = new TextEncoder().encode("cashloom-vault-v1");
const BLOB_VERSION = 1;

let masterKey: CryptoKey | null = null;

export type VaultSessionScope =
  | "accounts:read"
  | "accounts:write"
  | "keys:manage"
  | "payments:quote"
  | "payments:confirm"
  | "agent:authorize";

interface VaultSession {
  expiresAtMs: number;
  scopes: ReadonlySet<VaultSessionScope>;
  principal: VaultSessionPrincipal;
}

export type VaultSessionPrincipal = Readonly<
  | { kind: "owner"; ref: "local-owner" }
  | { kind: "agent"; ref: string }
>;

export interface VaultSessionInfo {
  expiresAt: string;
  scopes: readonly VaultSessionScope[];
  principal: VaultSessionPrincipal;
}

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const ALL_SESSION_SCOPES: readonly VaultSessionScope[] = [
  "accounts:read",
  "accounts:write",
  "keys:manage",
  "payments:quote",
  "payments:confirm",
  "agent:authorize",
];
const sessions = new Map<string, VaultSession>();

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
export const unlock = async (
  passphrase: string,
  options: {
    ttlMs?: number;
    scopes?: readonly VaultSessionScope[];
  } = {},
): Promise<string> => {
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
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new Error("Vault session ttlMs must be a positive safe integer no greater than 24 hours.");
  }
  const scopes = options.scopes ?? ALL_SESSION_SCOPES;
  if (scopes.length === 0 || scopes.some((scope) => !ALL_SESSION_SCOPES.includes(scope))) {
    throw new Error("Vault session scopes contain an unsupported or empty scope set.");
  }
  sessions.set(token, {
    expiresAtMs: Date.now() + ttlMs,
    scopes: new Set(scopes),
    principal: { kind: "owner", ref: "local-owner" },
  });
  return token;
};

export const lock = (): void => {
  masterKey = null;
  sessions.clear();
};

export const isValidSession = (
  token: string | undefined,
  requiredScope?: VaultSessionScope,
): boolean => {
  if (token === undefined || masterKey === null) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return requiredScope === undefined || session.scopes.has(requiredScope);
};

export const getSessionInfo = (token: string | undefined): VaultSessionInfo | null => {
  if (!isValidSession(token)) return null;
  const session = sessions.get(token!);
  if (!session) return null;
  return {
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    scopes: [...session.scopes].sort(),
    principal: session.principal,
  };
};

const AGENT_SESSION_SCOPES: readonly VaultSessionScope[] = [
  "accounts:read",
  "payments:quote",
  "agent:authorize",
];

/** Mint a least-authority child token without sharing the vault passphrase.
 * Only an owner session with keys:manage can delegate, and agent sessions can
 * never receive human-confirmation, mutation, or key-management authority. */
export const createDelegatedAgentSession = (
  ownerToken: string,
  options: {
    delegateKeyId: string;
    scopes: readonly VaultSessionScope[];
    ttlMs?: number;
  },
): { token: string; session: VaultSessionInfo } => {
  const owner = sessions.get(ownerToken);
  if (
    !isValidSession(ownerToken, "keys:manage") ||
    owner?.principal.kind !== "owner"
  ) {
    throw new Error("Only an active owner key-management session can delegate agent authority.");
  }
  const delegateKeyId = options.delegateKeyId.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(delegateKeyId)) {
    throw new Error("Agent session delegateKeyId must be the signed agent's SHA-256 key id.");
  }
  const scopes = [...new Set(options.scopes)];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !AGENT_SESSION_SCOPES.includes(scope))
  ) {
    throw new Error(
      `Agent sessions may only receive: ${AGENT_SESSION_SCOPES.join(", ")}.`,
    );
  }
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new Error("Agent session ttlMs must be positive and no greater than 24 hours.");
  }
  const token = crypto.randomUUID();
  sessions.set(token, {
    expiresAtMs: Date.now() + ttlMs,
    scopes: new Set(scopes),
    principal: { kind: "agent", ref: delegateKeyId },
  });
  return { token, session: getSessionInfo(token)! };
};

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
// whatever shape it arrived in, so the signer has exactly one format per kind.
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
 *  visible in listKeys. The 32-byte seed is sealed as 64-hex and is only ever
 *  decrypted inside the typed digest-signing operation below. */
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

const unsealSigningKey = async (
  keyId: string,
  expectedKind: "evm" | "btc" | "secret",
): Promise<Uint8Array> => {
  const key = requireKey();
  const row = db.query("SELECT kind, enc_blob FROM vault_keys WHERE id = ?").get(keyId) as
    | { kind: string; enc_blob: Uint8Array }
    | null;
  if (!row) throw new Error(`No vault key ${keyId}`);
  if (row.kind !== expectedKind) {
    throw new Error(`Vault key ${keyId} is ${row.kind}, not ${expectedKind}; refusing to sign.`);
  }
  return unseal(key, new Uint8Array(row.enc_blob));
};

const publicSigningKey = (
  keyId: string,
  expectedKind: "evm" | "btc",
): string => {
  requireKey();
  const row = db.query("SELECT kind, address FROM vault_keys WHERE id = ?").get(keyId) as
    | { kind: string; address: string | null }
    | null;
  if (!row) throw new Error(`No vault key ${keyId}`);
  if (row.kind !== expectedKind) {
    throw new Error(`Vault key ${keyId} is ${row.kind}, not ${expectedKind}; refusing to sign.`);
  }
  if (!row.address) throw new Error(`Vault key ${keyId} has no public address.`);
  return row.address;
};

export interface SigningBinding {
  intentId: string;
  intentHash: `sha256:${string}`;
  authorizationId: string;
  requestHash: `sha256:${string}`;
  expiresAt: string;
}

const assertSigningBinding = (binding: SigningBinding): void => {
  if (!/^[0-9a-fA-F-]{16,}$/.test(binding.intentId)) {
    throw new Error("Signing binding has an invalid intent id.");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(binding.intentHash)) {
    throw new Error("Signing binding has an invalid intent hash.");
  }
  if (!/^[0-9a-fA-F-]{16,}$/.test(binding.authorizationId)) {
    throw new Error("Signing binding has an invalid authorization id.");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(binding.requestHash)) {
    throw new Error("Signing binding has an invalid request hash.");
  }
  const expiresAtMs = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("Signing authorization is expired.");
  }
};

const unsignedAtomic = (value: string, label: string, allowZero = false): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned atomic-unit string.`);
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw new Error(`${label} must be greater than zero.`);
  return parsed;
};

const requestDigest = (domain: string, body: unknown): `sha256:${string}` => {
  const bytes = new TextEncoder().encode(`${domain}\n${canonicalizeJson(body as JsonValue)}`);
  return `sha256:${Buffer.from(sha256(bytes)).toString("hex")}`;
};

const assertRequestBinding = (binding: SigningBinding, requestHash: `sha256:${string}`): void => {
  assertSigningBinding(binding);
  if (binding.requestHash !== requestHash) {
    throw new Error("Signing authorization is bound to a different prepared request.");
  }
};

export interface PreparedEvmTransaction {
  kind: "cashloom.evm-transaction/1";
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  valueAtomic: string;
  data: `0x${string}`;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  nonce: number;
}

const validatePreparedEvmTransaction = (request: PreparedEvmTransaction) => {
  if (request.kind !== "cashloom.evm-transaction/1") {
    throw new Error("Unsupported EVM signing request kind.");
  }
  if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
    throw new Error("EVM signing request has an invalid chain id.");
  }
  if (!isAddress(request.from) || !isAddress(request.to)) {
    throw new Error("EVM signing request has an invalid address.");
  }
  if (!isHex(request.data) || request.data.length % 2 !== 0) {
    throw new Error("EVM signing request has invalid calldata.");
  }
  if (!Number.isSafeInteger(request.nonce) || request.nonce < 0) {
    throw new Error("EVM signing request has an invalid nonce.");
  }
  const value = unsignedAtomic(request.valueAtomic, "EVM value", true);
  const gas = unsignedAtomic(request.gasLimit, "EVM gas limit");
  const maxFeePerGas = unsignedAtomic(request.maxFeePerGas, "EVM max fee per gas");
  const maxPriorityFeePerGas = unsignedAtomic(
    request.maxPriorityFeePerGas,
    "EVM max priority fee per gas",
    true,
  );
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error("EVM priority fee exceeds the max fee per gas.");
  }
  return { value, gas, maxFeePerGas, maxPriorityFeePerGas };
};

/** A deterministic digest over every byte-affecting EVM transaction field. */
export const hashPreparedEvmTransaction = (
  request: PreparedEvmTransaction,
): `sha256:${string}` => {
  validatePreparedEvmTransaction(request);
  return requestDigest("cashloom.signing-request/evm-transaction/1", request);
};

export interface SignedEvmTransaction {
  serialized: Hex;
  hash: `0x${string}`;
  from: `0x${string}`;
}

/** Sign one fully prepared EVM transaction. Secret material never crosses the
 * vault boundary; the caller receives only the signed wire envelope and its
 * deterministic pre-broadcast hash. */
export const signEvmTransaction = async (
  keyId: string,
  request: PreparedEvmTransaction,
  binding: SigningBinding,
): Promise<SignedEvmTransaction> => {
  const values = validatePreparedEvmTransaction(request);
  const requestHash = hashPreparedEvmTransaction(request);
  assertRequestBinding(binding, requestHash);
  const publicAddress = publicSigningKey(keyId, "evm");
  if (publicAddress.toLowerCase() !== request.from.toLowerCase()) {
    throw new Error("EVM signing request is bound to a different vault address.");
  }
  const existing = walletKernelStore.getSignedArtifactByAuthorization(binding.authorizationId);
  if (existing) {
    if (
      existing.intentId !== binding.intentId ||
      existing.intentHash !== binding.intentHash ||
      existing.keyId !== keyId ||
      existing.requestHash !== requestHash
    ) {
      throw new Error("Durable signed artifact is bound to a different signing request.");
    }
    return {
      serialized: existing.payload,
      hash: existing.externalTxId as `0x${string}`,
      from: request.from,
    };
  }
  const plain = await unsealSigningKey(keyId, "evm");
  try {
    const secret = new TextDecoder().decode(plain) as `0x${string}`;
    const account = privateKeyToAccount(secret);
    if (account.address.toLowerCase() !== request.from.toLowerCase()) {
      throw new Error("EVM signing request is bound to a different vault address.");
    }
    const serialized = await account.signTransaction({
      type: "eip1559",
      chainId: request.chainId,
      to: request.to,
      value: values.value,
      data: request.data,
      gas: values.gas,
      maxFeePerGas: values.maxFeePerGas,
      maxPriorityFeePerGas: values.maxPriorityFeePerGas,
      nonce: request.nonce,
    });
    const hash = keccak256(serialized);
    walletKernelStore.persistSignedArtifact({
      authorizationId: binding.authorizationId,
      intentId: binding.intentId,
      intentHash: binding.intentHash,
      keyId,
      requestHash,
      encoding: "hex",
      payload: serialized,
      externalTxId: hash,
    });
    return { serialized, hash, from: account.address };
  } finally {
    plain.fill(0);
  }
};

export interface PreparedBitcoinTransaction {
  kind: "cashloom.bitcoin-transaction/1";
  network: "bitcoin-mainnet";
  fromAddress: string;
  inputs: readonly {
    txid: string;
    vout: number;
    amountSat: string;
    sequence: number;
  }[];
  outputs: readonly {
    address: string;
    amountSat: string;
  }[];
  lockTime: number;
  expectedFeeSat: string;
}

interface ValidatedBitcoinTransaction {
  inputs: readonly {
    txid: string;
    vout: number;
    amountSat: bigint;
    sequence: number;
  }[];
  outputs: readonly { address: string; amountSat: bigint }[];
  expectedFeeSat: bigint;
}

const validatePreparedBitcoinTransaction = (
  request: PreparedBitcoinTransaction,
): ValidatedBitcoinTransaction => {
  if (request.kind !== "cashloom.bitcoin-transaction/1" || request.network !== "bitcoin-mainnet") {
    throw new Error("Unsupported Bitcoin signing request kind or network.");
  }
  try {
    if (!Address(NETWORK).decode(request.fromAddress)) throw new Error("undecodable");
  } catch {
    throw new Error("Bitcoin signing request has an invalid sending address.");
  }
  if (!Number.isSafeInteger(request.lockTime) || request.lockTime < 0 || request.lockTime > 0xffffffff) {
    throw new Error("Bitcoin signing request has an invalid locktime.");
  }
  if (request.inputs.length === 0 || request.inputs.length > 200) {
    throw new Error("Bitcoin signing request must contain between 1 and 200 inputs.");
  }
  if (request.outputs.length === 0 || request.outputs.length > 16) {
    throw new Error("Bitcoin signing request must contain between 1 and 16 outputs.");
  }
  const seen = new Set<string>();
  const inputs = request.inputs.map((input) => {
    if (!/^[0-9a-f]{64}$/.test(input.txid)) {
      throw new Error("Bitcoin signing request has an invalid canonical txid.");
    }
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) {
      throw new Error("Bitcoin signing request has an invalid output index.");
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff) {
      throw new Error("Bitcoin signing request has an invalid sequence.");
    }
    const outpoint = `${input.txid}:${input.vout}`;
    if (seen.has(outpoint)) throw new Error("Bitcoin signing request contains a duplicate input.");
    seen.add(outpoint);
    return { ...input, amountSat: unsignedAtomic(input.amountSat, "Bitcoin input amount") };
  });
  const outputs = request.outputs.map((output) => {
    try {
      if (!Address(NETWORK).decode(output.address)) throw new Error("undecodable");
    } catch {
      throw new Error("Bitcoin signing request has an invalid mainnet output address.");
    }
    return { ...output, amountSat: unsignedAtomic(output.amountSat, "Bitcoin output amount") };
  });
  const expectedFeeSat = unsignedAtomic(request.expectedFeeSat, "Bitcoin fee", true);
  const totalIn = inputs.reduce((sum, input) => sum + input.amountSat, 0n);
  const totalOut = outputs.reduce((sum, output) => sum + output.amountSat, 0n);
  if (totalIn <= totalOut || totalIn - totalOut !== expectedFeeSat) {
    throw new Error("Bitcoin signing request inputs, outputs, and disclosed fee do not balance.");
  }
  return { inputs, outputs, expectedFeeSat };
};

/** A deterministic digest over the complete Bitcoin transaction request. */
export const hashPreparedBitcoinTransaction = (
  request: PreparedBitcoinTransaction,
): `sha256:${string}` => {
  validatePreparedBitcoinTransaction(request);
  return requestDigest("cashloom.signing-request/bitcoin-transaction/1", request);
};

export interface SignedBitcoinTransaction {
  hex: string;
  txid: string;
  feeSat: string;
}

/** Parse and cryptographically verify exact P2WPKH wire bytes against the
 * complete prepared request. This is intentionally shared by vault replay
 * and sender recovery: append-only storage alone cannot make attacker-made
 * bytes a valid signature, and a SegWit txid does not commit witness data. */
export const verifySignedBitcoinTransaction = (
  request: PreparedBitcoinTransaction,
  signedHex: string,
  expectedTxid: string,
): SignedBitcoinTransaction => {
  const values = validatePreparedBitcoinTransaction(request);
  if (!/^[0-9a-f]+$/.test(signedHex) || signedHex.length % 2 !== 0) {
    throw new Error("Stored Bitcoin signed envelope is malformed.");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedTxid)) {
    throw new Error("Stored Bitcoin signed envelope has an invalid transaction id.");
  }
  let transaction: Transaction;
  let raw: ReturnType<typeof RawTx.decode>;
  try {
    const bytes = hex.decode(signedHex);
    transaction = Transaction.fromRaw(bytes);
    raw = RawTx.decode(bytes);
  } catch {
    throw new Error("Stored Bitcoin signed envelope is not a valid transaction.");
  }
  if (!transaction.isFinal || transaction.id !== expectedTxid) {
    throw new Error("Stored Bitcoin signed envelope does not match its immutable transaction id.");
  }
  const source = Address(NETWORK).decode(request.fromAddress);
  if (!source || source.type !== "wpkh") {
    throw new Error("Bitcoin signing request is not a P2WPKH source.");
  }
  const scriptCode = OutScript.encode({ type: "pkh", hash: source.hash });
  const expectedOutputs = values.outputs.map((output) => ({
    amount: output.amountSat,
    script: OutScript.encode(Address(NETWORK).decode(output.address)!),
  }));
  const exactInputs =
    raw.version === 2 &&
    raw.lockTime === request.lockTime &&
    raw.inputs.length === values.inputs.length &&
    raw.inputs.every((input, index) => {
      const authorized = values.inputs[index]!;
      return (
        hex.encode(input.txid) === authorized.txid &&
        input.index === authorized.vout &&
        input.sequence === authorized.sequence &&
        input.finalScriptSig.length === 0
      );
    });
  const exactOutputs =
    raw.outputs.length === expectedOutputs.length &&
    raw.outputs.every((output, index) => {
      const authorized = expectedOutputs[index]!;
      return output.amount === authorized.amount && hex.encode(output.script) === hex.encode(authorized.script);
    });
  if (!exactInputs || !exactOutputs || raw.witnesses?.length !== values.inputs.length) {
    throw new Error("Stored Bitcoin signed envelope does not match the prepared inputs or outputs.");
  }
  for (let index = 0; index < values.inputs.length; index += 1) {
    const witness = raw.witnesses[index];
    if (!witness || witness.length !== 2) {
      throw new Error("Stored Bitcoin signed envelope has an invalid P2WPKH witness.");
    }
    const signatureWithType = witness[0]!;
    const publicKey = witness[1]!;
    if (
      signatureWithType.length < 2 ||
      signatureWithType.at(-1) !== 0x01 ||
      publicKey.length !== 33 ||
      (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) ||
      p2wpkh(publicKey, NETWORK).address !== request.fromAddress
    ) {
      throw new Error("Stored Bitcoin signed envelope has an invalid signer or sighash policy.");
    }
    const signature = signatureWithType.slice(0, -1);
    const digest = transaction.preimageWitnessV0(
      index,
      scriptCode,
      0x01,
      values.inputs[index]!.amountSat,
    );
    let valid = false;
    try {
      valid = secp256k1.verify(signature, digest, publicKey, {
        prehash: false,
        lowS: true,
        format: "der",
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error("Stored Bitcoin signed envelope has an invalid witness signature.");
    }
  }
  return { hex: signedHex, txid: expectedTxid, feeSat: values.expectedFeeSat.toString() };
};

/** Reconstruct, verify, sign, and finalize a Bitcoin transaction entirely
 * inside the vault. Callers can provide data, never executable objects. */
export const signBitcoinTransaction = async (
  keyId: string,
  request: PreparedBitcoinTransaction,
  binding: SigningBinding,
): Promise<SignedBitcoinTransaction> => {
  const values = validatePreparedBitcoinTransaction(request);
  const requestHash = hashPreparedBitcoinTransaction(request);
  assertRequestBinding(binding, requestHash);
  if (publicSigningKey(keyId, "btc") !== request.fromAddress) {
    throw new Error("Bitcoin signing request is bound to a different vault address.");
  }
  const existing = walletKernelStore.getSignedArtifactByAuthorization(binding.authorizationId);
  if (existing) {
    if (
      existing.intentId !== binding.intentId ||
      existing.intentHash !== binding.intentHash ||
      existing.keyId !== keyId ||
      existing.requestHash !== requestHash
    ) {
      throw new Error("Durable signed artifact is bound to a different signing request.");
    }
    return verifySignedBitcoinTransaction(
      request,
      existing.payload.slice(2),
      existing.externalTxId,
    );
  }
  const plain = await unsealSigningKey(keyId, "btc");
  let secret: Uint8Array | null = null;
  try {
    secret = fromHex(new TextDecoder().decode(plain));
    const fromAddress = btcAddressFor(secret);
    if (fromAddress !== request.fromAddress) {
      throw new Error("Bitcoin signing request is bound to a different vault address.");
    }
    const decoded = Address(NETWORK).decode(fromAddress);
    if (!decoded) throw new Error("Could not decode the vault Bitcoin address.");
    const selfScript = OutScript.encode(decoded);
    const transaction = new Transaction({ lockTime: request.lockTime });
    for (const input of values.inputs) {
      transaction.addInput({
        txid: hex.decode(input.txid),
        index: input.vout,
        witnessUtxo: { script: selfScript, amount: input.amountSat },
        sequence: input.sequence,
      });
    }
    for (const output of values.outputs) {
      transaction.addOutputAddress(output.address, output.amountSat, NETWORK);
    }
    transaction.sign(secret);
    transaction.finalize();
    if (transaction.fee !== values.expectedFeeSat) {
      throw new Error("Signed Bitcoin fee differs from the authorized request.");
    }
    const signedHex = transaction.hex;
    const txid = transaction.id;
    const verified = verifySignedBitcoinTransaction(request, signedHex, txid);
    walletKernelStore.persistSignedArtifact({
      authorizationId: binding.authorizationId,
      intentId: binding.intentId,
      intentHash: binding.intentHash,
      keyId,
      requestHash,
      encoding: "hex",
      payload: `0x${signedHex}`,
      externalTxId: txid,
    });
    return verified;
  } finally {
    secret?.fill(0);
    plain.fill(0);
  }
};

/** Sign a host record digest with the dedicated ed25519 authority key. */
export const signEd25519Digest = async (
  keyId: string,
  digest: Uint8Array,
): Promise<Uint8Array> => {
  if (digest.length !== 32) throw new Error("Host authority signs 32-byte digests only.");
  const plain = await unsealSigningKey(keyId, "secret");
  let seed: Uint8Array | null = null;
  try {
    seed = fromHex(new TextDecoder().decode(plain));
    return await ed25519.signAsync(digest, seed);
  } finally {
    seed?.fill(0);
    plain.fill(0);
  }
};
