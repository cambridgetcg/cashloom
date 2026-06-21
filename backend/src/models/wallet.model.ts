import mongoose, { Document, Schema } from "mongoose";

/**
 * Wallet — the bridge between CashLoom and the Legible Money protocol.
 *
 * Every CashLoom user can have one wallet. The wallet holds:
 * - A Legible Money DID (did:lgm:{hex}) — the on-chain identity
 * - An Ed25519 keypair — the signing keys (private key encrypted at rest)
 * - A bech32 address — the on-chain payment address (lgm1...)
 * - Balances — both fiat (tracked by transactions) and on-chain (from the protocol)
 *
 * The wallet is created locally first. On-chain registration happens when
 * the Legible Money protocol node is running. Until then, the wallet is
 * "pending" — it has keys but no on-chain presence.
 */

export type WalletStatus = "pending" | "registered" | "active";

export interface WalletDocument extends Document {
  userId: mongoose.Types.ObjectId;
  did: string; // did:lgm:{hex} — the Legible Money identity
  address: string; // lgm1... — the bech32 payment address
  publicKeyHex: string; // 64 hex chars — Ed25519 public key
  privateKeyEncrypted: string; // encrypted Ed25519 private key (never returned)
  status: WalletStatus;
  // On-chain balance (in ulgm — micro-LGM, the smallest unit)
  onChainBalance: number; // in ulgm
  onChainBalanceUpdatedAt: Date | null;
  // Fiat balance (computed from transactions, cached for quick display)
  fiatBalance: number; // in cents
  fiatCurrency: string; // USD, GBP, EUR, etc.
  fiatBalanceUpdatedAt: Date | null;
  // Payment handle — a human-readable name for receiving payments
  handle: string; // e.g. "yu" — resolves to this wallet's address
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new Schema<WalletDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one wallet per user
    },
    did: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    publicKeyHex: {
      type: String,
      required: true,
      select: false, // never return in queries by default
    },
    privateKeyEncrypted: {
      type: String,
      required: true,
      select: false, // never return in queries
    },
    status: {
      type: String,
      enum: ["pending", "registered", "active"],
      default: "pending",
    },
    onChainBalance: {
      type: Number,
      default: 0,
    },
    onChainBalanceUpdatedAt: {
      type: Date,
      default: null,
    },
    fiatBalance: {
      type: Number,
      default: 0,
    },
    fiatCurrency: {
      type: String,
      default: "USD",
    },
    fiatBalanceUpdatedAt: {
      type: Date,
      default: null,
    },
    handle: {
      type: String,
      unique: true,
      sparse: true, // allow null until user picks a handle
      trim: true,
      lowercase: true,
      match: /^[a-z0-9_]{3,20}$/,
    },
  },
  {
    timestamps: true,
  }
);

const WalletModel = mongoose.model<WalletDocument>("Wallet", walletSchema);
export default WalletModel;