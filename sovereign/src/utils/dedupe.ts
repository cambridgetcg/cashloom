// A transaction "is the same" as another when it shares an owner, a calendar
// day, a title, and an amount. We key on those so re-importing an overlapping
// bank month (or a double-submit) skips rows already present instead of
// silently doubling the data — the worst trust-breaker in a money app.
// Day granularity (not exact time) because statements only carry a date.

export const transactionDayKey = (date: Date | string): string =>
  new Date(date).toISOString().slice(0, 10);

export const transactionKey = (
  title: string,
  date: Date | string,
  amount: number
): string =>
  `${title.trim().toLowerCase()}|${transactionDayKey(date)}|${Number(
    amount
  ).toFixed(2)}`;

// A connector row carries a stable id from the rail (Stripe balance-txn id,
// bank transactionId, on-chain txhash) — when present we dedupe on
// {account, externalId}, which is authoritative and exact, so re-syncing the
// same rail transaction never doubles it. Scoping by accountId means the same
// externalId on two different accounts doesn't collide.
export const externalKey = (accountId: string, externalId: string): string =>
  `ext|${accountId}|${externalId}`;

// The dedupe key for a row: the rail's authoritative {account, externalId} when
// both are present, otherwise the day|title|amount heuristic. This keeps
// manual/AI/CSV rows (which have no rail id) behaving exactly as before.
export const dedupeKey = (row: {
  title: string;
  date: Date | string;
  amount: number;
  accountId?: unknown;
  externalId?: string | null;
}): string =>
  row.externalId != null && row.externalId !== "" && row.accountId != null
    ? externalKey(String(row.accountId), String(row.externalId))
    : transactionKey(row.title, row.date, row.amount);

// Split incoming rows into the ones to insert vs a count of those skipped
// because a matching key already exists. Pure + side-effect free so it's easy
// to test without a database.
export const splitNewRows = <
  T extends {
    title: string;
    date: Date | string;
    amount: number;
    accountId?: unknown;
    externalId?: string | null;
  }
>(
  incoming: T[],
  existingKeys: Set<string>
): { toInsert: T[]; skippedCount: number } => {
  const toInsert = incoming.filter((t) => !existingKeys.has(dedupeKey(t)));
  return { toInsert, skippedCount: incoming.length - toInsert.length };
};
