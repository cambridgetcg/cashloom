export const CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD"] as const;
export const CATEGORIES = ["income", "commitments", "spending", "setAsides"] as const;
export const PURPOSES = ["personal", "household", "independent", "group"] as const;
export const MAX_ITEMS = 80;
export const MAX_IMPORT_BYTES = 65_536;
export const STORAGE_KEY = "cashloom.money-plan.v1";

export type Currency = typeof CURRENCIES[number];
export type Category = typeof CATEGORIES[number];
export type Purpose = typeof PURPOSES[number];
export type PlanItem = { id: string; category: Category; label: string; amount: string };
export type MoneyPlan = {
  version: 1;
  period: "monthly";
  currency: Currency;
  purpose: Purpose;
  items: PlanItem[];
};
export type PlanStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function emptyPlan(): MoneyPlan {
  return { version: 1, period: "monthly", currency: "GBP", purpose: "personal", items: [] };
}

/** Only a public audience choice is read from the URL, never financial entries. */
export function planForAudience(search: string): MoneyPlan {
  const audience = new URLSearchParams(search).get("for");
  const purpose: Purpose = audience === "work" ? "independent" : audience === "household" || audience === "group" ? audience : "personal";
  return { ...emptyPlan(), purpose };
}

/** Decimal strings become integer minor units before any arithmetic. */
export function parseAmount(value: string): number | null {
  if (typeof value !== "string" || !/^(?:\d{1,9}(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
}

export function decimalAmount(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function formatMoney(minor: number, currency: Currency): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

export function calculatePlan(plan: MoneyPlan) {
  const totals: Record<Category, number> = { income: 0, commitments: 0, spending: 0, setAsides: 0 };
  let invalidAmounts = 0;
  for (const item of plan.items) {
    const amount = parseAmount(item.amount);
    if (amount === null) invalidAmounts++;
    else totals[item.category] += amount;
  }
  const allocated = totals.commitments + totals.spending + totals.setAsides;
  return { totals, allocated, remainder: totals.income - allocated, invalidAmounts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Rebuild a known shape; imported properties never reach application state. */
export function validatePlan(value: unknown): MoneyPlan {
  if (!isRecord(value) || !exactKeys(value, ["version", "period", "currency", "purpose", "items"]) || value.version !== 1 || value.period !== "monthly") {
    throw new Error("Choose a CashLoom monthly plan exported by this page.");
  }
  if (!CURRENCIES.includes(value.currency as Currency)) throw new Error("Choose a supported currency: GBP, EUR, USD, CAD or AUD.");
  if (!PURPOSES.includes(value.purpose as Purpose)) throw new Error("The plan type is not supported.");
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new Error(`A plan can contain up to ${MAX_ITEMS} entries.`);
  const ids = new Set<string>();
  const items = value.items.map((item: unknown, index: number): PlanItem => {
    const prefix = `Entry ${index + 1}`;
    if (!isRecord(item) || !exactKeys(item, ["id", "category", "label", "amount"])) throw new Error(`${prefix} has an unsupported format.`);
    if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw new Error(`${prefix} needs a unique, valid identifier.`);
    ids.add(item.id);
    if (!CATEGORIES.includes(item.category as Category)) throw new Error(`${prefix} has an unsupported category.`);
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 80 || /[\u0000-\u001f\u007f]/.test(item.label)) throw new Error(`${prefix} needs a name of 1–80 characters, without control characters.`);
    if (typeof item.amount !== "string" || parseAmount(item.amount) === null) throw new Error(`${prefix} needs an amount from 0 to 999,999,999.99, with at most two decimal places.`);
    return { id: item.id, category: item.category as Category, label: item.label.trim(), amount: decimalAmount(parseAmount(item.amount)!) };
  });
  return { version: 1, period: "monthly", currency: value.currency as Currency, purpose: value.purpose as Purpose, items };
}

export function planIssue(plan: MoneyPlan): string | null {
  try { validatePlan(plan); return null; }
  catch (error) { return error instanceof Error ? error.message : "Check the entries in your plan."; }
}

export function importPlan(text: string): MoneyPlan {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) throw new Error("The file is too large. Choose a plan under 64 KB.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("This file is not valid JSON. Choose a CashLoom plan export."); }
  return validatePlan(value);
}

export function exportPlan(plan: MoneyPlan): string {
  return JSON.stringify(validatePlan(plan), null, 2);
}

export type SavedPlanResult =
  | { status: "empty"; plan: null; snapshot: null }
  | { status: "loaded"; plan: MoneyPlan; snapshot: string }
  | { status: "error"; plan: null; message: string; snapshot: string | undefined };

export function readSavedPlan(storage: PlanStorage): SavedPlanResult {
  let text: string | null;
  try { text = storage.getItem(STORAGE_KEY); }
  catch { return { status: "error", plan: null, snapshot: undefined, message: "This browser blocked access to saved plans. You can still plan and export a file." }; }
  if (text === null) return { status: "empty", plan: null, snapshot: null };
  try { return { status: "loaded", plan: importPlan(text), snapshot: text }; }
  catch { return { status: "error", plan: null, snapshot: text, message: "The saved plan could not be read. It has been left untouched. Import a backup, or clear the saved plan to start again." }; }
}

export class PlanStorageConflict extends Error {
  constructor() { super("The saved plan changed elsewhere. Saving is paused; your draft is still here."); }
}

function checkSavedSnapshot(storage: PlanStorage, expectedSnapshot: string | null | undefined) {
  let current: string | null;
  try { current = storage.getItem(STORAGE_KEY); }
  catch { throw new Error("This browser could not check the saved plan. No changes were written or removed."); }
  if (expectedSnapshot === undefined || current !== expectedSnapshot) throw new PlanStorageConflict();
}

/** Compare immediately before writing; storage events additionally pause other open editors. */
export function savePlan(storage: PlanStorage, plan: MoneyPlan, expectedSnapshot: string | null | undefined): string {
  const text = exportPlan(plan);
  checkSavedSnapshot(storage, expectedSnapshot);
  try { storage.setItem(STORAGE_KEY, text); }
  catch { throw new Error("This browser could not save your changes. Export a file to keep this plan."); }
  return text;
}

export function clearSavedPlan(storage: PlanStorage, expectedSnapshot: string | null | undefined): void {
  checkSavedSnapshot(storage, expectedSnapshot);
  try { storage.removeItem(STORAGE_KEY); }
  catch { throw new Error("This browser blocked removal of the saved plan. The saved copy may still be present."); }
}
