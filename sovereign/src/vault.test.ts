import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The DB path is read at import time — point it at a throwaway dir BEFORE
// the module graph loads.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-vault-test-"));

const vault = await import("./vault.ts");

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

    const revealed = await vault.revealForSigning(key.id);
    expect(revealed).toMatch(/^0x[0-9a-f]{64}$/i);
    // Round-trip: the revealed key derives the stored address.
    const { privateKeyToAccount } = await import("viem/accounts");
    expect(privateKeyToAccount(revealed).address).toBe(key.address);
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
    await expect(vault.revealForSigning(keys[0]!.id)).rejects.toThrow(/locked/);
  });
});
