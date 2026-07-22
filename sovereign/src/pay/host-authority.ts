/**
 * cashloom-the-host as a @agenttool/wallet RecordSigner — backed by a vault key.
 *
 * The agent-payment gate authorizes an agent's intent against its capability;
 * when it passes, cashloom attests that authorization by SIGNING it. That
 * signature comes from a dedicated ed25519 authority key held in the same vault
 * as the money keys — so "cashloom authorized this" is a verifiable claim anyone
 * can check against the host's public key, and the key never leaves the vault.
 *
 * Crucially this authority is ed25519: it can attest, but it CANNOT spend an
 * evm/btc account. Signing an authorization is not moving money.
 */

import * as vault from "../vault.ts";
import * as ed25519 from "@noble/ed25519";
import { signatureToBase64Url, type RecordSigner } from "@agenttool/wallet";

const HOST_LABEL = "moneyworld-host-authority";

/** Ensure the vault holds cashloom's record-signing authority; create it once,
 *  reuse it thereafter. Requires an unlocked vault. */
export async function ensureHostAuthority(): Promise<{ keyId: string; publicKey: string }> {
  const found = vault.listKeys().find((k) => k.label === HOST_LABEL && k.kind === "secret");
  if (found?.address) return { keyId: found.id, publicKey: found.address };
  const info = await vault.generateEd25519Key(HOST_LABEL);
  return { keyId: info.id, publicKey: info.address as string };
}

/** A RecordSigner whose signatures come from the vault authority key. Reveals
 *  the seed for exactly one signature and zeroizes it; never returns key
 *  material to the caller. */
export async function vaultRecordSigner(keyId: string, publicKey: string): Promise<RecordSigner> {
  return {
    public_key: publicKey,
    async sign_digest(digest: Uint8Array): Promise<string> {
      const seedHex = await vault.revealForSigning(keyId); // 64-hex ed25519 seed
      const seed = new Uint8Array(Buffer.from(seedHex, "hex"));
      try {
        const sig = await ed25519.signAsync(digest, seed);
        return signatureToBase64Url(sig);
      } finally {
        seed.fill(0);
      }
    },
  };
}
