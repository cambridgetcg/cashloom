import { describe, it, expect } from "bun:test";
import { NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as ed25519 from "@noble/ed25519";
import { recoverTransactionAddress } from "viem";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The DB path is read at import time — point it at a throwaway dir BEFORE
// the module graph loads.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-vault-test-"));

const vault = await import("./vault.ts");

// A Base-shaped EIP-1559 request; it is only signed here, never broadcast.
const EVM_REQUEST = {
  chainId: 8453,
  type: "eip1559",
  to: "0x000000000000000000000000000000000000dEaD",
  value: 1n,
  gas: 21_000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  nonce: 0,
} as const;

// Throwaway BTC vector (32 bytes of 0x07), the same one imported below; NOT a secret.
const BTC_VECTOR_HEX = "07".repeat(32);

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

  it("generates an EVM key sealed at rest — plaintext never in the row", async () => {
    await vault.unlock("correct horse battery staple");
    const key = await vault.generateEvmKey("test-key");
    expect(key.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const { db } = await import("./db.ts");
    const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(key.id) as {
      enc_blob: Uint8Array;
    };
    const blobText = Buffer.from(row.enc_blob).toString("latin1");
    // A sealed blob must not contain the 0x-hex key shape anywhere.
    expect(blobText).not.toMatch(/0x[0-9a-f]{64}/i);

    // Round-trip: the vault signs in place, and the signature recovers to the
    // stored address.
    const serializedTransaction = await vault.signEvmTransaction(key.id, key.address!, EVM_REQUEST);
    expect(
      await recoverTransactionAddress({ serializedTransaction: serializedTransaction as `0x02${string}` })
    ).toBe(key.address as `0x${string}`);

    await expect(
      vault.signEvmTransaction(key.id, "0x000000000000000000000000000000000000dEaD", EVM_REQUEST)
    ).rejects.toThrow(/does not match the quoted sending address/);
  });

  it("hands no key material out: revealForSigning is gone", () => {
    expect("revealForSigning" in vault).toBe(false);
  });

  it("imports a known key and derives the right address", async () => {
    // Well-known throwaway test vector (hardhat account #0) — NOT a secret.
    const priv = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const key = await vault.importEvmKey("imported", priv);
    expect(key.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("lock drops the master key and every session", async () => {
    const token = await vault.unlock("correct horse battery staple");
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.isValidSession(token)).toBe(false);
    const keys = vault.listKeys();
    await expect(
      vault.signEvmTransaction(keys[0]!.id, keys[0]!.address!, EVM_REQUEST)
    ).rejects.toThrow(/locked/);
  });
});

describe("vault — btc keys", () => {
  it("generates a mainnet P2WPKH key, sealed at rest", async () => {
    await vault.unlock("correct horse battery staple");
    const key = await vault.generateBtcKey("btc hot");
    expect(key.kind).toBe("btc");
    expect(key.address).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);

    const { db } = await import("./db.ts");
    const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(key.id) as {
      enc_blob: Uint8Array;
    };
    const blobText = Buffer.from(row.enc_blob).toString("latin1");
    expect(blobText).not.toMatch(/[0-9a-f]{64}/); // sealed means sealed
  });

  it("signs a BTC transaction in place and zeroizes the key bytes it used", async () => {
    const key = await vault.importBtcKey("btc signer", BTC_VECTOR_HEX);
    const pay = p2wpkh(secp256k1.getPublicKey(Buffer.from(BTC_VECTOR_HEX, "hex"), true), NETWORK);

    class SpyTransaction extends Transaction {
      seen: Uint8Array | undefined;
      override sign(privateKey: Parameters<Transaction["sign"]>[0]): number {
        this.seen = privateKey as Uint8Array;
        return super.sign(privateKey);
      }
    }
    const tx = new SpyTransaction();
    tx.addInput({
      txid: new Uint8Array(32).fill(0x11),
      index: 0,
      witnessUtxo: { script: pay.script, amount: 100_000n },
    });
    tx.addOutputAddress(pay.address!, 90_000n, NETWORK);

    expect(await vault.signBtcTransaction(key.id, tx)).toBe(1);
    tx.finalize();
    expect(tx.isFinal).toBe(true);
    expect(tx.seen).toBeDefined();
    expect(tx.seen!.every((byte) => byte === 0)).toBe(true);

    const { db } = await import("./db.ts");
    const row = db.query("SELECT enc_blob FROM vault_keys WHERE id = ?").get(key.id) as {
      enc_blob: Uint8Array;
    };
    expect(Buffer.from(row.enc_blob).toString("latin1")).not.toContain(BTC_VECTOR_HEX);
  });

  it("gives key bytes to no look-alike transaction and to no other key kind", async () => {
    const btc = vault.listKeys().find((k) => k.kind === "btc")!;
    const evm = vault.listKeys().find((k) => k.kind === "evm")!;
    let received: unknown;
    const lookAlike = { sign: (priv: unknown) => (received = priv) } as unknown as Transaction;
    await expect(vault.signBtcTransaction(btc.id, lookAlike)).rejects.toThrow(/needs a @scure\/btc-signer Transaction/);
    expect(received).toBeUndefined();

    await expect(vault.signBtcTransaction(evm.id, new Transaction())).rejects.toThrow(/is a evm key; this signature needs a btc key/);
    await expect(vault.signEvmTransaction(btc.id, btc.address!, EVM_REQUEST)).rejects.toThrow(/is a btc key; this signature needs a evm key/);
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

describe("vault — ed25519 record authority", () => {
  it("signs a digest in place; the signature verifies against the stored public key", async () => {
    await vault.unlock("correct horse battery staple");
    const key = await vault.generateEd25519Key("record authority");
    const digest = new Uint8Array(32).fill(9);
    const signature = await vault.signRecord(key.id, digest);
    expect(signature).toHaveLength(64);
    expect(await ed25519.verifyAsync(signature, digest, Buffer.from(key.address!, "base64url"))).toBe(true);
  });

  it("signs records only with a record key, never with a money key", async () => {
    const evm = vault.listKeys().find((k) => k.kind === "evm")!;
    const btc = vault.listKeys().find((k) => k.kind === "btc")!;
    const digest = new Uint8Array(32).fill(1);
    await expect(vault.signRecord(evm.id, digest)).rejects.toThrow(/is a evm key; this signature needs a secret key/);
    await expect(vault.signRecord(btc.id, digest)).rejects.toThrow(/is a btc key; this signature needs a secret key/);
    await expect(vault.signRecord(evm.id, new Uint8Array(0))).rejects.toThrow(/non-empty digest/);
  });

  it("refuses a seed that no longer derives its recorded public key", async () => {
    const { db } = await import("./db.ts");
    const key = await vault.generateEd25519Key("tampered authority");
    const other = await vault.generateEd25519Key("other authority");
    db.query("UPDATE vault_keys SET address = ? WHERE id = ?").run(other.address, key.id);
    await expect(vault.signRecord(key.id, new Uint8Array(32).fill(2))).rejects.toThrow(
      /does not match its recorded public key/
    );
  });
});
