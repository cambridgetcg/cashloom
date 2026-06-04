import { describe, it, expect } from "vitest";
import { reportInsightPrompt } from "./prompt";

const base = {
  totalIncome: 5000,
  totalExpenses: 3000,
  availableBalance: 2000,
  savingsRate: 40,
  categories: { groceries: { amount: 1200, percentage: 40 } },
  periodLabel: "May 1 - 31, 2026",
};

describe("reportInsightPrompt", () => {
  it("includes the period, totals, and savings rate", () => {
    const p = reportInsightPrompt(base);
    expect(p).toContain("May 1 - 31, 2026");
    expect(p).toContain("$5000.00");
    expect(p).toContain("Savings Rate: 40%");
  });

  it("omits the comparison block when no comparison is given", () => {
    expect(reportInsightPrompt(base)).not.toContain(
      "Compared with the previous period"
    );
  });

  it("renders then/now numbers when a comparison is provided", () => {
    const p = reportInsightPrompt({
      ...base,
      comparison: {
        periodLabel: "Apr 1 – Apr 30, 2026",
        income: 4000,
        expenses: 2500,
        balance: 1500,
      },
    });
    expect(p).toContain(
      "Compared with the previous period (Apr 1 – Apr 30, 2026)"
    );
    expect(p).toContain("Income then: $4000.00 (now $5000.00)");
    expect(p).toContain("Expenses then: $2500.00 (now $3000.00)");
    expect(p).toContain("Balance then: $1500.00 (now $2000.00)");
  });
});
