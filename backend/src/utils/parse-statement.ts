import {
  PaymentMethodEnum,
  TransactionTypeEnum,
} from "../models/transaction.model";

export interface NormalizedRow {
  title: string;
  amount: number;
  date: string;
  description?: string;
  category: string;
  type: TransactionTypeEnum;
  paymentMethod: PaymentMethodEnum;
}

// Turn whatever the AI returned into rows we can actually save: drop anything
// missing a title/amount/date, force a positive amount (direction lives in
// `type`), coerce the date to ISO, fall back to safe enum values, and cap the
// batch at the same ceiling as bulk import. Pure + side-effect free so the
// confirm step never trips bulk validation — and so it's easy to test.
export const MAX_IMPORT_ROWS = 300;

export const normalizeParsedRows = (rows: unknown): NormalizedRow[] => {
  const list = Array.isArray(rows) ? rows : [];
  const validMethods = Object.values(PaymentMethodEnum) as string[];

  return list
    .map((row): NormalizedRow | null => {
      const r = row as Record<string, unknown>;
      if (!r || typeof r.title !== "string" || !r.title.trim()) return null;

      const amount = Number(r.amount);
      if (!(amount > 0)) return null;

      const d = new Date(r.date as string);
      if (isNaN(d.getTime())) return null;

      return {
        title: r.title.trim(),
        amount,
        date: d.toISOString(),
        description:
          typeof r.description === "string" ? r.description : undefined,
        category:
          typeof r.category === "string" && r.category.trim()
            ? r.category.trim().toLowerCase()
            : "uncategorized",
        type:
          r.type === TransactionTypeEnum.INCOME
            ? TransactionTypeEnum.INCOME
            : TransactionTypeEnum.EXPENSE,
        paymentMethod: validMethods.includes(r.paymentMethod as string)
          ? (r.paymentMethod as PaymentMethodEnum)
          : PaymentMethodEnum.BANK_TRANSFER,
      };
    })
    .filter((r): r is NormalizedRow => r !== null)
    .slice(0, MAX_IMPORT_ROWS);
};
