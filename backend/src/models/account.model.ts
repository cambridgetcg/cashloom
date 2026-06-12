import mongoose, { Schema, Document } from "mongoose";

// The rails CashLoom aggregates. An Account is one balance-bearing store on a
// rail: a Stripe balance, a bank account, a single crypto wallet/address, a
// cash float, a platform-credit balance, or a gift card. An Account holds no
// funds itself — it's the labelled container a connector syncs a balance into.
export enum RailEnum {
  STRIPE = "STRIPE",
  BANK = "BANK",
  CRYPTO = "CRYPTO",
  CASH = "CASH",
  PLATFORM_CREDIT = "PLATFORM_CREDIT",
  GIFT_CARD = "GIFT_CARD",
}

export enum AccountStatusEnum {
  ACTIVE = "ACTIVE",
  ARCHIVED = "ARCHIVED",
}

export interface AccountDocument extends Document {
  userId: mongoose.Types.ObjectId;
  rail: keyof typeof RailEnum;
  connectorType?: string;
  displayName: string;
  currency: string;
  decimals: number;
  balanceMinor: string;
  balanceAsOf?: Date;
  externalAccountId?: string;
  credentialRef?: string;
  status: keyof typeof AccountStatusEnum;
  createdAt: Date;
  updatedAt: Date;
}

const accountSchema = new Schema<AccountDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    rail: {
      type: String,
      enum: Object.values(RailEnum),
      required: true,
    },
    // Which connector populates this account: "stripe", "gocardless",
    // "alchemy", "esplora", "manual"... Free-form so a new connector doesn't
    // need a schema change.
    connectorType: {
      type: String,
    },
    displayName: {
      type: String,
      required: true,
    },
    // ISO-4217 for fiat ("GBP", "USD") or the asset symbol for crypto ("BTC",
    // "ETH", "SOL", "XMR", "USDC"). Uppercased on write.
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    // Minor-unit scale for this currency: 2 for GBP/USD, 8 for BTC, 18 for ETH,
    // 6 for USDC, 12 for XMR. Needed to interpret balanceMinor exactly.
    decimals: {
      type: Number,
      required: true,
      default: 2,
      min: 0,
      max: 30,
    },
    // Balance in integer MINOR units, stored as a decimal STRING. A JS number
    // (IEEE-754 double) cannot hold 18-decimal wei-scale amounts without
    // precision loss, so crypto balances never touch a float. "0" until a
    // connector syncs a real balance in.
    balanceMinor: {
      type: String,
      required: true,
      default: "0",
    },
    balanceAsOf: {
      type: Date,
      default: null,
    },
    // The rail's own id for this account/wallet (Stripe account id, bank account
    // id, on-chain address, xpub fingerprint). Used to dedupe + reconcile.
    externalAccountId: {
      type: String,
      default: null,
    },
    // A POINTER to where this account's connector credential lives in a secret
    // store (a Fly secret name, or "op://vault/item/field") — NEVER the secret
    // value itself. Secrets do not live in the database.
    credentialRef: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(AccountStatusEnum),
      default: AccountStatusEnum.ACTIVE,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Don't let the same external account be onboarded twice for a user. Partial so
// manually-created accounts (no externalAccountId) are exempt from uniqueness —
// you can have many cash floats, but only one Stripe account per Stripe id.
accountSchema.index(
  { userId: 1, rail: 1, externalAccountId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalAccountId: { $type: "string" } },
  }
);

const AccountModel = mongoose.model<AccountDocument>("Account", accountSchema);

export default AccountModel;
