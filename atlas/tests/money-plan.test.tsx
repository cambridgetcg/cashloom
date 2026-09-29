import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MoneyPlan from "../src/plan/MoneyPlan";
import {
  MAX_IMPORT_BYTES, MAX_ITEMS, STORAGE_KEY, PlanStorageConflict, calculatePlan, clearSavedPlan, emptyPlan, exportPlan,
  importPlan, parseAmount, planForAudience, readSavedPlan, savePlan, validatePlan,
  type MoneyPlan as PlanData, type PlanStorage,
} from "../src/plan/model";

function example(): PlanData {
  return { ...emptyPlan(), items: [
    { id: "pay", category: "income", label: "Take-home pay", amount: "2400.30" },
    { id: "rent", category: "commitments", label: "Rent", amount: "1100.10" },
    { id: "food", category: "spending", label: "Food", amount: "400.20" },
    { id: "future", category: "setAsides", label: "Future costs", amount: "250.00" },
  ] };
}

function storage(seed?: string) {
  const entries = new Map<string, string>(seed === undefined ? [] : [[STORAGE_KEY, seed]]);
  const store: PlanStorage = {
    getItem: vi.fn((key) => entries.get(key) ?? null),
    setItem: vi.fn((key, value) => { entries.set(key, value); }),
    removeItem: vi.fn((key) => { entries.delete(key); }),
  };
  return { store, entries };
}

describe("monthly money arithmetic", () => {
  it("adds and subtracts exact minor units across all four categories", () => {
    expect(calculatePlan(example())).toEqual({
      totals: { income: 240030, commitments: 110010, spending: 40020, setAsides: 25000 },
      allocated: 175030, remainder: 65000, invalidAmounts: 0,
    });
    const plan = example();
    plan.items = [
      { id: "a", category: "income", label: "A", amount: "0.30" },
      { id: "b", category: "spending", label: "B", amount: "0.10" },
      { id: "c", category: "spending", label: "C", amount: "0.20" },
    ];
    expect(calculatePlan(plan).remainder).toBe(0);
    plan.items[0].amount = "0.29";
    expect(calculatePlan(plan).remainder).toBe(-1);
  });

  it.each([["0", 0], ["1.2", 120], [".05", 5], ["25.", 2500], ["999999999.99", 99999999999]])("parses %s as integer minor units", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(["", " ", " 1", "1 ", "-1", "NaN", "Infinity", "1e4", "+1", "1,000", "£10", "0.001", "1000000000", "1.2.3", "."]) ("rejects unsafe or ambiguous amount %s", (input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it("marks unfinished amounts while keeping valid subtotals", () => {
    const plan = example();
    plan.items[1].amount = "";
    expect(calculatePlan(plan).invalidAmounts).toBe(1);
    expect(calculatePlan(plan).totals.commitments).toBe(0);
    expect(calculatePlan(plan).totals.income).toBe(240030);
  });

  it("stays within exact safe integers at the largest supported plan", () => {
    const plan = emptyPlan();
    plan.items = Array.from({ length: MAX_ITEMS }, (_, index) => ({ id: `item-${index}`, category: "income", label: "Income", amount: "999999999.99" }));
    expect(calculatePlan(validatePlan(plan)).totals.income).toBe(7999999999920);
    expect(Number.isSafeInteger(calculatePlan(plan).remainder)).toBe(true);
  });
});

describe("portable plans", () => {
  it("round trips entries, category, purpose and currency with a versioned monthly format", () => {
    const plan = { ...example(), currency: "EUR" as const, purpose: "group" as const };
    expect(importPlan(exportPlan(plan))).toEqual(plan);
    expect(importPlan(exportPlan(emptyPlan()))).toEqual(emptyPlan());
  });

  it("normalizes decimal input without changing the calculation", () => {
    const plan = example();
    plan.items[0] = { ...plan.items[0], label: " Pay ", amount: "003.2" };
    const imported = importPlan(exportPlan(plan));
    expect(imported.items[0].amount).toBe("3.20");
    expect(imported.items[0].label).toBe("Pay");
    expect(calculatePlan(imported)).toEqual(calculatePlan(plan));
  });

  it.each([
    ["unsupported version", (plan: any) => { plan.version = 2; }],
    ["weekly amounts", (plan: any) => { plan.period = "weekly"; }],
    ["currency", (plan: any) => { plan.currency = "BTC"; }],
    ["purpose", (plan: any) => { plan.purpose = "unknown"; }],
    ["unknown fields", (plan: any) => { plan.endpoint = "https://example.test"; }],
    ["missing name", (plan: any) => { plan.items[0].label = " "; }],
    ["long name", (plan: any) => { plan.items[0].label = "x".repeat(81); }],
    ["control characters", (plan: any) => { plan.items[0].label = "bad\u0000name"; }],
    ["duplicate identifiers", (plan: any) => { plan.items[1].id = plan.items[0].id; }],
    ["unsafe identifier", (plan: any) => { plan.items[0].id = "<script>"; }],
    ["numeric amounts", (plan: any) => { plan.items[0].amount = 24.3; }],
    ["negative amounts", (plan: any) => { plan.items[0].amount = "-1"; }],
    ["large amounts", (plan: any) => { plan.items[0].amount = "9007199254740992"; }],
    ["unfinished amounts", (plan: any) => { plan.items[0].amount = ""; }],
    ["unknown category", (plan: any) => { plan.items[0].category = "other"; }],
    ["unexpected entry fields", (plan: any) => { plan.items[0].owner = "unknown"; }],
    ["too many entries", (plan: any) => { plan.items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({ ...plan.items[0], id: `id-${index}` })); }],
  ])("rejects %s before it reaches the editor", (_name, mutate) => {
    const plan = example();
    mutate(plan);
    expect(() => importPlan(JSON.stringify(plan))).toThrow();
  });

  it("rejects malformed, oversized, multibyte-oversized and prototype-bearing files", () => {
    expect(() => importPlan("{broken}")).toThrow("not valid JSON");
    expect(() => importPlan(" ".repeat(MAX_IMPORT_BYTES + 1))).toThrow("too large");
    expect(() => importPlan("é".repeat(MAX_IMPORT_BYTES / 2 + 1))).toThrow("too large");
    expect(() => importPlan('{"__proto__":{"polluted":true}}')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => importPlan("null")).toThrow();
    expect(() => importPlan("[]")).toThrow();
  });

  it("limits audience links to public presets without importing any financial query values", () => {
    expect(planForAudience("?for=work&income=9000")).toEqual({ ...emptyPlan(), purpose: "independent" });
    expect(planForAudience("?for=group").purpose).toBe("group");
    expect(planForAudience("?for=household").purpose).toBe("household");
    expect(planForAudience("?for=unknown")).toEqual(emptyPlan());
  });
});

describe("explicit browser persistence", () => {
  it("reads an empty browser without writing a plan or turning on saving", () => {
    const { store } = storage();
    expect(readSavedPlan(store)).toEqual({ status: "empty", plan: null, snapshot: null });
    expect(store.setItem).not.toHaveBeenCalled();
  });

  it("saves, reloads and removes only the planner's storage key", () => {
    const { store, entries } = storage();
    entries.set("another-feature", "keep");
    const snapshot = savePlan(store, example(), null);
    expect(readSavedPlan(store)).toEqual({ status: "loaded", plan: example(), snapshot });
    clearSavedPlan(store, snapshot);
    expect(readSavedPlan(store).status).toBe("empty");
    expect(entries.get("another-feature")).toBe("keep");
  });

  it("keeps the last complete saved plan when new edits are unfinished", () => {
    const { store, entries } = storage(exportPlan(example()));
    const unfinished = example();
    unfinished.items[0].amount = "";
    expect(() => savePlan(store, unfinished, exportPlan(example()))).toThrow();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(importPlan(entries.get(STORAGE_KEY)!)).toEqual(example());
  });

  it("leaves an unreadable stored plan untouched for recovery", () => {
    const { store, entries } = storage("malformed saved state");
    expect(readSavedPlan(store).status).toBe("error");
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(entries.get(STORAGE_KEY)).toBe("malformed saved state");
  });

  it("reports blocked reads, quota failures and blocked removal honestly", () => {
    const blocked: PlanStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readSavedPlan(blocked)).toMatchObject({ status: "error", plan: null });
    expect(() => savePlan(blocked, example(), null)).toThrow("could not check");
    expect(() => clearSavedPlan(blocked, null)).toThrow("could not check");
    const writeBlocked = { ...blocked, getItem: () => null };
    expect(() => savePlan(writeBlocked, example(), null)).toThrow("could not save");
    expect(() => clearSavedPlan(writeBlocked, null)).toThrow("may still be present");
  });

  it("refuses to overwrite a copy another tab has changed", () => {
    const { store, entries } = storage(exportPlan(example()));
    const observed = readSavedPlan(store).snapshot;
    const other = example();
    other.items[0].amount = "4500.00";
    entries.set(STORAGE_KEY, exportPlan(other));
    expect(() => savePlan(store, example(), observed)).toThrow(PlanStorageConflict);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(importPlan(entries.get(STORAGE_KEY)!)).toEqual(other);
  });

  it("does not recreate a saved copy removed in another tab", () => {
    const { store, entries } = storage(exportPlan(example()));
    const observed = readSavedPlan(store).snapshot;
    entries.delete(STORAGE_KEY);
    expect(() => savePlan(store, example(), observed)).toThrow(PlanStorageConflict);
    expect(entries.has(STORAGE_KEY)).toBe(false);
  });

  it("leaves another tab's changed saved copy intact when clearing", () => {
    const { store, entries } = storage();
    const observed = readSavedPlan(store).snapshot;
    entries.set(STORAGE_KEY, exportPlan(example()));
    expect(() => clearSavedPlan(store, observed)).toThrow(PlanStorageConflict);
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(entries.has(STORAGE_KEY)).toBe(true);
  });

  it("requires a known storage snapshot and permits an explicitly reviewed replacement", () => {
    const { store, entries } = storage(exportPlan(example()));
    expect(() => savePlan(store, emptyPlan(), undefined)).toThrow(PlanStorageConflict);
    const reviewed = readSavedPlan(store).snapshot;
    const saved = savePlan(store, emptyPlan(), reviewed);
    expect(saved).toBe(exportPlan(emptyPlan()));
    expect(entries.get(STORAGE_KEY)).toBe(saved);
  });
});

describe("money plan page", () => {
  it("starts without fake entries, with saving off and all monthly categories available", () => {
    expect(emptyPlan()).toMatchObject({ currency: "GBP", purpose: "personal", items: [] });
    const html = renderToStaticMarkup(<MoneyPlan />);
    expect(html).toContain("No account needed");
    expect(html).toContain("Enter monthly amounts only");
    expect(html).toContain("Add income");
    expect(html).toContain("Add a commitment");
    expect(html).toContain("Add spending");
    expect(html).toContain("Add a set-aside");
    expect(html).toContain('href="/plan" aria-current="page"');
    expect(html).toContain('type="checkbox" aria-describedby="plan-save-help"');
    expect(html).not.toContain('id="plan-name-');
    expect(html).toContain("does not move money, connect accounts or calculate tax");
    expect(html).toContain("This planner sends no entries to a server");
  });
});
