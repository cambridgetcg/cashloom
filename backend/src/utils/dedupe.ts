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

// Split incoming rows into the ones to insert vs a count of those skipped
// because a matching key already exists. Pure + side-effect free so it's easy
// to test without a database.
export const splitNewRows = <
  T extends { title: string; date: Date | string; amount: number }
>(
  incoming: T[],
  existingKeys: Set<string>
): { toInsert: T[]; skippedCount: number } => {
  const toInsert = incoming.filter(
    (t) => !existingKeys.has(transactionKey(t.title, t.date, t.amount))
  );
  return { toInsert, skippedCount: incoming.length - toInsert.length };
};
