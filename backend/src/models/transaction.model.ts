import mongoose, { Schema } from "mongoose";
import { convertToCents, convertToDollarUnit } from "../utils/format-currency";

export enum TransactionStatusEnum {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export enum RecurringIntervalEnum {
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  MONTHLY = "MONTHLY",
  YEARLY = "YEARLY",
}

export enum TransactionTypeEnum {
  INCOME = "INCOME",
  EXPENSE = "EXPENSE",
}

export enum PaymentMethodEnum {
  CARD = "CARD",
  BANK_TRANSFER = "BANK_TRANSFER",
  MOBILE_PAYMENT = "MOBILE_PAYMENT",
  AUTO_DEBIT = "AUTO_DEBIT",
  CASH = "CASH",
  OTHER = "OTHER",
}

// Where a transaction came from. CONNECTOR rows carry a stable externalId from
// the rail and dedupe on it; AI_IMPORT/CSV/MANUAL rows have no rail id and fall
// back to the day|title|amount heuristic (see utils/dedupe).
export enum TransactionSourceEnum {
  CONNECTOR = "CONNECTOR",
  AI_IMPORT = "AI_IMPORT",
  CSV = "CSV",
  MANUAL = "MANUAL",
}

export interface TransactionDocument extends Document {
  userId: mongoose.Types.ObjectId;
  type: keyof typeof TransactionTypeEnum;
  title: string;
  amount: number;
  category: string;
  receiptUrl?: string;
  recurringInterval?: keyof typeof RecurringIntervalEnum;
  nextRecurringDate?: Date;
  lastProcessed?: Date;
  isRecurring: boolean;
  description?: string;
  date: Date;
  status: keyof typeof TransactionStatusEnum;
  paymentMethod: keyof typeof PaymentMethodEnum;
  // Which Account (rail/wallet/bank) this transaction belongs to. Null for the
  // legacy single-user tracker rows that predate connectors.
  accountId?: mongoose.Types.ObjectId;
  source: keyof typeof TransactionSourceEnum;
  // The rail's own id for this transaction (Stripe balance-txn id, bank
  // transactionId, on-chain txhash). Null for manual/AI/CSV rows.
  externalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const transactionSchema = new Schema<TransactionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    title: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(TransactionTypeEnum),
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      set: (value: number) => convertToCents(value),
      get: (value: number) => convertToDollarUnit(value),
    },

    description: {
      type: String,
    },
    category: {
      type: String,
      required: true,
    },
    receiptUrl: {
      type: String,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    isRecurring: {
      type: Boolean,
      default: false,
    },
    recurringInterval: {
      type: String,
      enum: Object.values(RecurringIntervalEnum),
      default: null,
    },
    nextRecurringDate: {
      type: Date,
      default: null,
    },
    lastProcessed: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(TransactionStatusEnum),
      default: TransactionStatusEnum.COMPLETED,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PaymentMethodEnum),
      default: PaymentMethodEnum.CASH,
    },
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    source: {
      type: String,
      enum: Object.values(TransactionSourceEnum),
      default: TransactionSourceEnum.MANUAL,
    },
    externalId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true },
  }
);

// A connector row is uniquely identified by its account + the rail's own id, so
// re-syncing the same rail transaction can never double it. Partial: only rows
// that actually carry an externalId are constrained — manual/AI/CSV rows
// (externalId null) are exempt and keep the day|title|amount heuristic dedupe.
transactionSchema.index(
  { userId: 1, accountId: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalId: { $type: "string" } },
  }
);

const TransactionModel = mongoose.model<TransactionDocument>(
  "Transaction",
  transactionSchema
);

export default TransactionModel;
