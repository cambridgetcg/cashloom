import mongoose from "mongoose";
import AccountModel, {
  AccountStatusEnum,
  RailEnum,
} from "../models/account.model";
import TransactionModel, {
  PaymentMethodEnum,
  TransactionSourceEnum,
  TransactionStatusEnum,
  TransactionTypeEnum,
} from "../models/transaction.model";
import { getConnector } from "../connectors";
import { getRequisition } from "../connectors/gocardless.connector";
import { ConnectorContext, NormalizedTransaction } from "../connectors/types";
import { dedupeKey, splitNewRows } from "../utils/dedupe";
import { minorToMajor, minorToMajorIsSafe } from "../utils/minor-units";
import { convertToCents, convertToDollarUnit } from "../utils/format-currency";
import { assertRequisitionOwnership } from "./connect.service";
import { BadRequestException, NotFoundException } from "../utils/app-error";

// The sync pipeline: pull one account's balance + transactions through its
// read-only connector and land them in the local models without ever doubling
// a row or mixing currencies. Connectors observe; this service records.

const DAY_MS = 24 * 60 * 60 * 1000;

// Re-fetch a few days behind the newest known transaction so rows that booked
// late (bank feeds settle out of order) are still picked up. Overlap is safe:
// the dedupe pre-filter + the {userId, accountId, externalId} unique index
// make a re-fetched row a skip, never a double.
const OVERLAP_WINDOW_MS = 3 * DAY_MS;

// First-ever sync of an account: pull the trailing 90 days.
const INITIAL_LOOKBACK_MS = 90 * DAY_MS;

// The sanest PaymentMethodEnum per rail: Stripe balance transactions are
// card-acquired money, GoCardless rows are bank-account movements. Anything
// unmapped (future connectors, test fakes) lands on OTHER.
const PAYMENT_METHOD_BY_CONNECTOR: Record<
  string,
  keyof typeof PaymentMethodEnum
> = {
  stripe: PaymentMethodEnum.CARD,
  gocardless: PaymentMethodEnum.BANK_TRANSFER,
};

// Defensive scrub for error text that leaves the service. Connectors already
// never embed key material in messages, but a sync-all error is shown to the
// client verbatim, so anything shaped like a Stripe secret/restricted key is
// redacted as a second line of defence.
const SECRET_PATTERN = /(sk|rk)_[a-z]+_\w+/gi;

const safeErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error && error.message ? error.message : "Sync failed";
  return message.replace(SECRET_PATTERN, "[redacted]");
};

export interface SyncAccountResult {
  accountId: string;
  imported: number;
  skipped: number;
  balanceMinor: string;
  balanceAsOf: Date | null;
  warnings?: string[];
}

export interface SyncAllResultEntry {
  accountId: string;
  displayName: string;
  ok: boolean;
  imported?: number;
  skipped?: number;
  // Money-correctness warnings from the per-account sync ("balance not
  // written...", precision skips). They MUST ride along: a sweep that withheld
  // a balance is not the same as a clean sweep, and the operator has to see why.
  warnings?: string[];
  error?: string;
}

// Shape thrown by insertMany({ordered:false}) on duplicate keys. Mongoose 8
// rethrows the driver's MongoBulkWriteError and attaches insertedDocs (the
// docs that DID land). writeErrors may be one object or an array.
interface BulkWriteErrorLike {
  code?: number;
  writeErrors?: { code?: number } | Array<{ code?: number }>;
  insertedDocs?: unknown[];
}

const asDuplicateBulkError = (error: unknown): BulkWriteErrorLike | null => {
  const e = error as BulkWriteErrorLike;
  const writeErrors = Array.isArray(e?.writeErrors)
    ? e.writeErrors
    : e?.writeErrors
    ? [e.writeErrors]
    : [];
  const allDuplicates =
    writeErrors.length > 0 && writeErrors.every((w) => w?.code === 11000);
  if (allDuplicates || e?.code === 11000) return e;
  return null;
};

export const syncAccountService = async (
  userId: string,
  accountId: string
): Promise<SyncAccountResult> => {
  // Owner-scoped load: a guessed id must look identical to a missing one.
  const account = await AccountModel.findOne({ _id: accountId, userId });
  if (!account) throw new NotFoundException("Account not found");

  if (!account.connectorType || !account.externalAccountId) {
    throw new BadRequestException("manual accounts do not sync");
  }

  const connector = getConnector(account.connectorType, account.currency);
  const ctx: ConnectorContext = {
    credentialRef: account.credentialRef ?? null,
    externalAccountId: account.externalAccountId,
  };

  const warnings: string[] = [];

  // Newest known transaction drives the fetch window AND tells us whether the
  // account has any history (used by the first-sync currency correction).
  const latest = await TransactionModel.findOne({
    userId,
    accountId: account._id,
  })
    .sort({ date: -1 })
    .select("date");

  /* -------------------------------- balance ------------------------------- */

  const balance = await connector.fetchBalance(ctx);
  const balanceCurrency = balance.currency.trim().toUpperCase();

  // First-ever sync = no balance ever written AND no transactions: the stored
  // currency/decimals are onboarding defaults (GoCardless import guesses
  // GBP/2, manual creation defaults decimals to 2), so the rail's own report
  // is more trustworthy than the guess and can be adopted — nothing is
  // recorded yet, so nothing can mix.
  const isFirstSync = account.balanceAsOf == null && latest == null;

  if (
    balanceCurrency === account.currency &&
    balance.decimals === account.decimals
  ) {
    // Currency AND minor-unit scale agree — verbatim string copy, balanceMinor
    // never touches a float.
    account.balanceMinor = balance.balanceMinor;
    account.balanceAsOf = balance.asOf;
  } else if (isFirstSync) {
    if (balanceCurrency !== account.currency) {
      warnings.push(
        `account currency corrected from ${account.currency} to ${balanceCurrency} on first sync`
      );
      account.currency = balanceCurrency;
    }
    if (balance.decimals !== account.decimals) {
      // e.g. a Stripe JPY account created with the schema-default decimals 2:
      // the rail reports whole yen (decimals 0), and storing "500" against
      // decimals 2 would silently misread every balance and import 100x off.
      warnings.push(
        `account decimals corrected from ${account.decimals} to ${balance.decimals} on first sync`
      );
      account.decimals = balance.decimals;
    }
    account.balanceMinor = balance.balanceMinor;
    account.balanceAsOf = balance.asOf;
  } else {
    // NEVER silently mix currencies OR minor-unit scales: an established
    // account keeps its old balance and the caller is told why. Fixing the
    // account currency/decimals is a deliberate human action, not something
    // a sync infers.
    warnings.push(
      balanceCurrency !== account.currency
        ? `balance not written: connector reported ${balanceCurrency} but account currency is ${account.currency}`
        : `balance not written: connector reported a ${balance.decimals}-decimal balance but account decimals is ${account.decimals}`
    );
  }

  if (account.isModified()) await account.save();

  /* ------------------------------ transactions ----------------------------- */

  // Connector transaction amounts are integer minor units at the RAIL's own
  // scale — the same scale fetchBalance just reported. If that scale does not
  // match the account's (an established account whose decimals are wrong),
  // every conversion below would be 10x/100x off, so the whole import is
  // refused loudly — and the rail call is saved, since nothing it returned
  // could be stored.
  if (balance.decimals !== account.decimals) {
    warnings.push(
      `transactions not imported: connector amounts use ${balance.decimals} decimals but account decimals is ${account.decimals} — fix the account decimals and re-sync`
    );
    return {
      accountId: String(account._id),
      imported: 0,
      skipped: 0,
      balanceMinor: account.balanceMinor,
      balanceAsOf: account.balanceAsOf ?? null,
      warnings,
    };
  }

  const since = latest
    ? new Date(latest.date.getTime() - OVERLAP_WINDOW_MS)
    : new Date(Date.now() - INITIAL_LOOKBACK_MS);

  const fetched = await connector.fetchTransactions(ctx, since);

  let skipped = 0;

  // DROP rows whose currency differs from the account's. A foreign-currency
  // row stored under this account would corrupt every balance/analytics sum
  // (the Transaction model has no currency field — the account defines it),
  // so the row is counted as skipped rather than imported wrong.
  //
  // The model's amount is float-backed CENTS (its setter is fixed at scale 2
  // regardless of account.decimals), so TWO float legs must both be exact for
  // a row to import:
  //   1. minor → major: minorToMajorIsSafe (wei-scale magnitudes refuse), and
  //   2. major → stored cents: the setter's Math.round(major * 100) must
  //      round-trip (a 3-decimal KWD fils or a sub-cent BTC amount does not).
  // A row failing either leg is skipped loudly instead of imported rounded.
  const importable: Array<{ tx: NormalizedTransaction; major: number }> = [];
  for (const tx of fetched) {
    if (tx.currency.trim().toUpperCase() !== account.currency) {
      skipped += 1;
      continue;
    }
    if (!minorToMajorIsSafe(tx.amountMinor, account.decimals)) {
      skipped += 1;
      warnings.push(
        `transaction ${tx.externalId} skipped: amount cannot be represented exactly`
      );
      continue;
    }
    const major = minorToMajor(tx.amountMinor, account.decimals);
    if (convertToDollarUnit(convertToCents(Math.abs(major))) !== Math.abs(major)) {
      skipped += 1;
      warnings.push(
        `transaction ${tx.externalId} skipped: amount cannot be stored exactly (the transaction store keeps 2-decimal amounts)`
      );
      continue;
    }
    importable.push({ tx, major });
  }

  // THE precision boundary, the corruption class this repo has been burned
  // by: connector amounts are SIGNED integer MINOR units; the Transaction
  // model wants ABSOLUTE MAJOR units (its setter converts major → cents).
  // Both legs were proven exact above; the sign moves into type.
  const docs = importable.map(({ tx, major }) => {
    return {
      userId: account.userId,
      accountId: account._id,
      source: TransactionSourceEnum.CONNECTOR,
      externalId: tx.externalId,
      title: tx.title,
      date: tx.date,
      type: major < 0 ? TransactionTypeEnum.EXPENSE : TransactionTypeEnum.INCOME,
      amount: Math.abs(major),
      category: "uncategorized",
      paymentMethod:
        PAYMENT_METHOD_BY_CONNECTOR[account.connectorType as string] ??
        PaymentMethodEnum.OTHER,
      status: TransactionStatusEnum.COMPLETED,
      isRecurring: false,
      recurringInterval: null,
      nextRecurringDate: null,
      lastProcessed: null,
    };
  });

  // Idempotency, layer 1 (mirrors bulkTransactionService): pre-filter against
  // rows already stored for this account. Connector rows dedupe on the
  // authoritative {account, externalId} key, so we only need the docs whose
  // externalId appears in this batch.
  let imported = 0;
  if (docs.length > 0) {
    const existing = await TransactionModel.find({
      userId,
      accountId: account._id,
      externalId: { $in: docs.map((d) => d.externalId) },
    }).select("title date amount accountId externalId");

    const existingKeys = new Set(existing.map((e) => dedupeKey(e)));
    const { toInsert, skippedCount } = splitNewRows(docs, existingKeys);
    skipped += skippedCount;

    if (toInsert.length > 0) {
      // Idempotency, layer 2: the partial unique index on
      // {userId, accountId, externalId} is the backstop for anything the
      // pre-filter cannot see (intra-batch duplicates, a concurrent sync).
      // ordered:false lands every non-duplicate row; E11000 losers fold into
      // skipped instead of failing a sync that mostly succeeded.
      try {
        const inserted = await TransactionModel.insertMany(toInsert, {
          ordered: false,
        });
        imported = inserted.length;
      } catch (error) {
        const duplicateError = asDuplicateBulkError(error);
        if (!duplicateError) throw error;
        imported =
          duplicateError.insertedDocs?.length ??
          /* istanbul-style fallback if the driver omitted insertedDocs */ 0;
        skipped += toInsert.length - imported;
      }
    }
  }

  return {
    accountId: String(account._id),
    imported,
    skipped,
    balanceMinor: account.balanceMinor,
    balanceAsOf: account.balanceAsOf ?? null,
    ...(warnings.length > 0 && { warnings }),
  };
};

export const syncAllAccountsService = async (
  userId: string
): Promise<SyncAllResultEntry[]> => {
  // Every ACTIVE account a connector can serve. "manual" is a deliberate
  // non-syncing connectorType, so it is excluded rather than reported as an
  // error on every sweep.
  const accounts = await AccountModel.find({
    userId,
    status: AccountStatusEnum.ACTIVE,
    connectorType: { $exists: true, $nin: [null, "", "manual"] },
  }).sort({ createdAt: 1 });

  const results: SyncAllResultEntry[] = [];

  // Strictly SEQUENTIAL: GoCardless allows ~4 calls per account per day and
  // parallel hammering just burns quota faster. One account failing (revoked
  // key, exhausted quota) must not abort the rest of the sweep.
  for (const account of accounts) {
    try {
      const result = await syncAccountService(userId, String(account._id));
      results.push({
        accountId: result.accountId,
        displayName: account.displayName,
        ok: true,
        imported: result.imported,
        skipped: result.skipped,
        // Warnings ride along so a refused balance write / precision skip is
        // distinguishable from a clean sync in the sweep results.
        ...(result.warnings && { warnings: result.warnings }),
      });
    } catch (error) {
      results.push({
        accountId: String(account._id),
        displayName: account.displayName,
        ok: false,
        error: safeErrorMessage(error),
      });
    }
  }

  return results;
};

/* --------------------------- GoCardless import ---------------------------- */

// Turn a linked GoCardless requisition into syncable BANK accounts — the last
// step of the onboarding dance (see gocardless.connector.ts). One Account per
// requisition account id not already onboarded; the partial unique index on
// {userId, rail, externalAccountId} is the backstop against double-onboarding.
export const importGoCardlessAccountsService = async (
  userId: string,
  requisitionId: string
) => {
  // Requisitions are integration-wide upstream (one GoCardless secret pair for
  // the whole deployment), so ownership lives in OUR db: only the user who
  // created the requisition may import its accounts. A leaked/guessed id must
  // look identical to a missing one — same IDOR closure as the account paths.
  await assertRequisitionOwnership(userId, requisitionId);

  const requisition = await getRequisition(requisitionId);

  if (requisition.accounts.length === 0) {
    // "LN" is GoCardless for linked; anything else means the bank auth flow
    // has not finished, so there is nothing to import yet.
    throw new BadRequestException(
      `Requisition has no linked accounts yet (status "${requisition.status}") — finish the bank authentication first`
    );
  }

  const accounts = [];
  let skipped = 0;

  for (const externalAccountId of requisition.accounts) {
    const existing = await AccountModel.findOne({
      userId,
      rail: RailEnum.BANK,
      externalAccountId,
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      const account = await AccountModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        rail: RailEnum.BANK,
        connectorType: "gocardless",
        // GoCardless account ids are opaque UUIDs; the tail is enough to tell
        // two accounts apart until Alex renames them.
        displayName: `Bank account …${externalAccountId.slice(-4)}`,
        // GBP/2 is the onboarding default — the first sync corrects the
        // currency from what the bank actually reports (see syncAccountService).
        currency: "GBP",
        decimals: 2,
        externalAccountId,
        status: AccountStatusEnum.ACTIVE,
      });
      accounts.push(account);
    } catch (error) {
      // E11000: a concurrent import won the race — the unique index did its
      // job, treat it as already onboarded.
      if ((error as { code?: number })?.code === 11000) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  return { accounts, skipped };
};
