import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PreparedBitcoinTransaction,
  PreparedEvmTransaction,
  SigningBinding,
} from "./vault.ts";

// The DB path is read at import time — point it at a throwaway dir BEFORE
// the module graph loads.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-vault-test-"));

const vault = await import("./vault.ts");
const { db, newId } = await import("./db.ts");
const { WalletKernelStore } = await import("./wallet/infrastructure/sqlite/index.ts");
const kernel = new WalletKernelStore(db);

const authorize = (input: {
  keyId: string;
  publicAddress: string;
  requestHash: `sha256:${string}`;
  chainId: string;
  assetId: string;
}): SigningBinding => {
  const intentId = newId();
  const intentHash = `sha256:${"1".repeat(64)}` as const;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  kernel.putWallet({ id: "wallet.vault-test", label: "Vault test" });
  const isBitcoin = input.chainId.startsWith("bip122:");
  kernel.putAsset({
    id: input.assetId,
    kind: "NATIVE",
    symbol: isBitcoin ? "BTC" : "ETH",
    name: isBitcoin ? "Bitcoin" : "Ether",
    decimals: isBitcoin ? 8 : 18,
    chainId: input.chainId,
  });
  kernel.putAccount({
    id: `account.${intentId}`,
    walletId: "wallet.vault-test",
    label: "Signing account",
    kind: "CHAIN_ACCOUNT",
    rail: "test",
    chainId: input.chainId,
    accountRef: `${input.chainId}:${input.publicAddress}`,
    address: input.publicAddress,
    custodyMode: "local_self_custody",
  });
  kernel.createPaymentIntent({
    id: intentId,
    kind: "transfer",
    sourceAccountId: `account.${intentId}`,
    assetId: input.assetId,
    amountAtomic: "1",
    destination: { kind: "test" },
    initialState: "authorized",
    intentHash,
    createdBy: { type: "human", ref: "vault-test" },
    expiresAt,
  });
  kernel.acquireReservation({
    id: `reservation.${intentId}`,
    intentId,
    accountId: `account.${intentId}`,
    assetId: input.assetId,
    kind: isBitcoin ? "UTXO" : "NONCE",
    resourceKey: `${input.chainId}:${intentId}`,
    amountAtomic: "1",
    expiresAt,
  });
  const authorization = kernel.createSigningAuthorization({
    intentId,
    intentHash,
    keyId: input.keyId,
    requestHash: input.requestHash,
    actor: { type: "human", ref: "vault-test" },
    method: "TEST",
    grantHash: `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64)}`,
    expiresAt,
  }).authorization;
  return {
    intentId,
    intentHash,
    authorizationId: authorization.id,
    requestHash: input.requestHash,
    expiresAt,
  };
};

describe("vault — custody discipline", () => {
  it("starts uninitialized and locked", () => {
    expect(vault.isInitialized()).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
  });

  it("refuses a weak passphrase", async () => {
    await expect(vault.initialize("short")).rejects.toThrow(/at least 8/);
  });

  it("initializes, unlocks, and mints a session", async () => {
    await vault.initialize("correct horse battery staple");
    expect(vault.isInitialized()).toBe(true);
    expect(vault.isUnlocked()).toBe(true);
    const token = await vault.unlock("correct horse battery staple");
    expect(vault.isValidSession(token)).toBe(true);
  });

  it("refuses re-initialization (would orphan sealed keys)", async () => {
    await expect(vault.initialize("another passphrase")).rejects.toThrow(/already initialized/);
  });

  it("rejects a wrong passphrase with one undifferentiated error", async () => {
    await expect(vault.unlock("wrong passphrase entirely")).rejects.toThrow(/^Wrong passphrase\.$/);
  });

  it("generates an EVM key sealed at rest and exposes only typed signing", async () => {
    await vault.unlock("correct horse battery staple");
    const key = await vault.generateEvmKey("test-key");
    expect(key.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(key.id) as {
      enc_blob: Uint8Array;
    };
    const blobText = Buffer.from(row.enc_blob).toString("latin1");
    // A sealed blob must not contain the 0x-hex key shape anywhere.
    expect(blobText).not.toMatch(/0x[0-9a-f]{64}/i);

    expect("revealForSigning" in vault).toBe(false);
    const request: PreparedEvmTransaction = {
      kind: "cashloom.evm-transaction/1",
      chainId: 8453,
      from: key.address as `0x${string}`,
      to: `0x${"2".repeat(40)}`,
      valueAtomic: "1",
      data: "0x",
      gasLimit: "21000",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "1",
      nonce: 0,
    };
    const requestHash = vault.hashPreparedEvmTransaction(request);
    const reordered: PreparedEvmTransaction = {
      nonce: request.nonce,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      maxFeePerGas: request.maxFeePerGas,
      gasLimit: request.gasLimit,
      data: request.data,
      valueAtomic: request.valueAtomic,
      to: request.to,
      from: request.from,
      chainId: request.chainId,
      kind: request.kind,
    };
    expect(vault.hashPreparedEvmTransaction(reordered)).toBe(requestHash);
    const binding = authorize({
      keyId: key.id,
      publicAddress: key.address!,
      requestHash,
      chainId: "eip155:8453",
      assetId: "eip155:8453/slip44:60",
    });
    const signed = await vault.signEvmTransaction(key.id, request, binding);
    expect(signed.from as string).toBe(key.address as string);
    expect(signed.serialized).toMatch(/^0x/);
    const replay = await vault.signEvmTransaction(key.id, request, binding);
    expect(replay).toEqual(signed);
    expect(kernel.getSigningAuthorization(binding.authorizationId)?.status).toBe("CONSUMED");
    const artifact = kernel.getSignedArtifactByAuthorization(binding.authorizationId);
    expect(artifact).toMatchObject({
      requestHash,
      payload: signed.serialized,
      externalTxId: signed.hash,
    });
  });

  it("imports a known key and derives the right address", async () => {
    // Well-known throwaway test vector (hardhat account #0) — NOT a secret.
    const priv = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const key = await vault.importEvmKey("imported", priv);
    expect(key.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("refuses request substitution without consuming the valid authorization", async () => {
    const key = await vault.generateEvmKey("request-binding");
    const request: PreparedEvmTransaction = {
      kind: "cashloom.evm-transaction/1",
      chainId: 8453,
      from: key.address as `0x${string}`,
      to: `0x${"3".repeat(40)}`,
      valueAtomic: "1",
      data: "0x",
      gasLimit: "21000",
      maxFeePerGas: "2",
      maxPriorityFeePerGas: "1",
      nonce: 4,
    };
    const requestHash = vault.hashPreparedEvmTransaction(request);
    const binding = authorize({
      keyId: key.id,
      publicAddress: key.address!,
      requestHash,
      chainId: "eip155:8453",
      assetId: "eip155:8453/slip44:60",
    });
    await expect(
      vault.signEvmTransaction(key.id, { ...request, nonce: 5 }, binding),
    ).rejects.toThrow(/different prepared request/);
    expect(kernel.getSigningAuthorization(binding.authorizationId)?.status).toBe("ACTIVE");
  });

  it("enforces session scopes and expiry", async () => {
    const scoped = await vault.unlock("correct horse battery staple", {
      scopes: ["accounts:read"],
    });
    expect(vault.isValidSession(scoped, "accounts:read")).toBe(true);
    expect(vault.isValidSession(scoped, "payments:confirm")).toBe(false);
    const expiring = await vault.unlock("correct horse battery staple", { ttlMs: 1 });
    await Bun.sleep(5);
    expect(vault.isValidSession(expiring)).toBe(false);
  });

  it("lock drops the master key and every session", async () => {
    const token = await vault.unlock("correct horse battery staple");
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.isValidSession(token)).toBe(false);
    expect(vault.listKeys().length).toBeGreaterThan(0);
  });
});

describe("vault — btc keys", () => {
  it("generates a mainnet P2WPKH key, sealed, and signs inert request data", async () => {
    await vault.unlock("correct horse battery staple");
    const key = await vault.generateBtcKey("btc hot");
    expect(key.kind).toBe("btc");
    expect(key.address).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);

    const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(key.id) as {
      enc_blob: Uint8Array;
    };
    const blobText = Buffer.from(row.enc_blob).toString("latin1");
    expect(blobText).not.toContain("07".repeat(32));
    const request: PreparedBitcoinTransaction = {
      kind: "cashloom.bitcoin-transaction/1",
      network: "bitcoin-mainnet",
      fromAddress: key.address!,
      inputs: [{ txid: "ab".repeat(32), vout: 0, amountSat: "10000", sequence: 0xfffffffd }],
      outputs: [{ address: "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty", amountSat: "9000" }],
      lockTime: 900000,
      expectedFeeSat: "1000",
    };
    const requestHash = vault.hashPreparedBitcoinTransaction(request);
    const binding = authorize({
      keyId: key.id,
      publicAddress: key.address!,
      requestHash,
      chainId: "bip122:000000000019d6689c085ae165831e93",
      assetId: "bip122:000000000019d6689c085ae165831e93/slip44:0",
    });
    const signed = await vault.signBitcoinTransaction(key.id, request, binding);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.feeSat).toBe("1000");
  });

  it("imports 64-hex (with or without 0x) to the pinned test-vector address", async () => {
    // Throwaway vector (32 bytes of 0x07) — NOT a secret; address cross-checked
    // against @scure/btc-signer + noble in btc.sender.test.ts.
    const a = await vault.importBtcKey("hexed", "07".repeat(32));
    const b = await vault.importBtcKey("hexed-0x", "0x" + "07".repeat(32));
    expect(a.address).toBe("bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5");
    expect(b.address).toBe(a.address);
  });

  it("refuses an out-of-range scalar", async () => {
    await expect(vault.importBtcKey("zero", "00".repeat(32))).rejects.toThrow(/not a valid secp256k1/i);
    await expect(vault.importBtcKey("overflow", "ff".repeat(32))).rejects.toThrow(/not a valid secp256k1/i);
  });
});
