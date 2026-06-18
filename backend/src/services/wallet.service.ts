/**
 * Wallet Service — the bridge between CashLoom and the Legible Money protocol.
 *
 * Creates wallets, generates keypairs, manages balances, and (when the
 * protocol node is running) syncs on-chain state.
 *
 * The wallet is the human-facing door to the protocol. A CashLoom user
 * doesn't need to know about DIDs or Ed25519 or bech32 — they just see
 * a balance, a handle, and a way to send and receive.
 */

import * as crypto from "crypto";
import WalletModel, { WalletDocument } from "../models/wallet.model";
import { BadRequestException, NotFoundException } from "../utils/app-error";

/**
 * Generate an Ed25519 keypair for the Legible Money protocol.
 * Returns the public key as 64 hex chars and the private key as 128 hex chars.
 * (Cosmos SDK uses Ed25519 for account keys.)
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex").slice(-64);
  const privateKeyHex = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex").slice(-128);

  return { publicKeyHex, privateKeyHex };
}

/**
 * Derive the Legible Money DID from a public key.
 * DID format: did:lgm:{first 32 hex chars of pubkey}
 * (Matches the protocol's PublicKeyToDID in x/auth/types/types.go)
 */
export function publicKeyToDID(pubKeyHex: string): string {
  if (pubKeyHex.length < 32) {
    throw new Error("Public key must be at least 32 hex characters");
  }
  return `did:lgm:${pubKeyHex.slice(0, 32).toLowerCase()}`;
}

/**
 * Encrypt a private key for storage.
 * Uses AES-256-GCM with a key derived from the app's JWT_SECRET.
 * (Not bulletproof — in production, use a dedicated KMS or hardware HSM.
 *  But this is the right shape: the private key never touches the filesystem
 *  unencrypted, never appears in API responses, never gets logged.)
 */
export function encryptPrivateKey(privateKeyHex: string, secret: string): string {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKeyHex, "hex"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Store as: iv (12 bytes) + tag (16 bytes) + ciphertext, all as hex
  return Buffer.concat([iv, tag, encrypted]).toString("hex");
}

/**
 * Decrypt a private key from storage.
 */
export function decryptPrivateKey(encrypted: string, secret: string): string {
  const buf = Buffer.from(encrypted, "hex");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("hex");
}

/**
 * Create a wallet for a user.
 * Generates a new Ed25519 keypair, derives the DID, and stores the
 * encrypted private key. The wallet starts in "pending" status — it has
 * keys but no on-chain presence yet.
 */
export async function createWallet(
  userId: string,
  fiatCurrency: string = "USD",
  secret: string
): Promise<WalletDocument> {
  // Check if user already has a wallet
  const existing = await WalletModel.findOne({ userId: userId as any });
  if (existing) {
    throw new BadRequestException("User already has a wallet");
  }

  const { publicKeyHex, privateKeyHex } = generateKeyPair();
  const did = publicKeyToDID(publicKeyHex);
  const privateKeyEncrypted = encryptPrivateKey(privateKeyHex, secret);

  // The on-chain address will be the bech32-encoded hash of the public key.
  // For now, we use a placeholder — the real bech32 encoding happens when
  // we integrate with the Cosmos SDK. The address is set during registration.
  const address = `lgm1${publicKeyHex.slice(0, 38).toLowerCase()}`;

  const wallet = await WalletModel.create({
    userId: userId as any,
    did,
    address,
    publicKeyHex,
    privateKeyEncrypted,
    status: "pending",
    fiatBalance: 0,
    fiatCurrency,
    onChainBalance: 0,
  } as any);

  return wallet;
}

/**
 * Get a user's wallet (without sensitive fields).
 */
export async function getWallet(userId: string): Promise<WalletDocument | null> {
  return WalletModel.findOne({ userId: userId as any });
}

/**
 * Get a wallet by handle (for P2P payment resolution).
 */
export async function getWalletByHandle(handle: string): Promise<WalletDocument | null> {
  return WalletModel.findOne({ handle: handle.toLowerCase() });
}

/**
 * Set a payment handle for a wallet.
 */
export async function setHandle(userId: string, handle: string): Promise<WalletDocument | null> {
  const wallet = await WalletModel.findOne({ userId: userId as any });
  if (!wallet) {
    throw new NotFoundException("Wallet not found");
  }

  // Check if handle is already taken
  const existing = await WalletModel.findOne({
    handle: handle.toLowerCase(),
    userId: { $ne: wallet._id },
  });
  if (existing) {
    throw new BadRequestException("Handle already taken");
  }

  wallet.handle = handle.toLowerCase();
  await wallet.save();
  return wallet;
}

/**
 * Update the fiat balance (called after transaction changes).
 * This is a cache — the source of truth is the transactions collection.
 */
export async function updateFiatBalance(
  userId: string,
  balanceInCents: number,
  currency: string
): Promise<void> {
  await WalletModel.updateOne(
    { userId: userId as any },
    {
      $set: {
        fiatBalance: balanceInCents,
        fiatCurrency: currency,
        fiatBalanceUpdatedAt: new Date(),
      },
    }
  );
}

/**
 * Update the on-chain balance (called after syncing with the protocol).
 * In a real deployment, this queries the Legible Money RPC endpoint.
 */
export async function updateOnChainBalance(
  userId: string,
  balanceInUlgm: number
): Promise<void> {
  await WalletModel.updateOne(
    { userId: userId as any },
    {
      $set: {
        onChainBalance: balanceInUlgm,
        onChainBalanceUpdatedAt: new Date(),
      },
    }
  );
}

/**
 * Get both balances for display.
 */
export async function getBalances(userId: string) {
  const wallet = await getWallet(userId);
  if (!wallet) {
    return null;
  }

  return {
    fiat: {
      amount: wallet.fiatBalance,
      currency: wallet.fiatCurrency,
      updatedAt: wallet.fiatBalanceUpdatedAt,
    },
    onChain: {
      amount: wallet.onChainBalance,
      unit: "ulgm",
      updatedAt: wallet.onChainBalanceUpdatedAt,
    },
    did: wallet.did,
    address: wallet.address,
    handle: wallet.handle,
    status: wallet.status,
  };
}