// CashLoom Fair-Money Plans
//
// Design principle: the free tier is genuinely useful, not a trial-sized
// teaser. A user with 3 connected accounts, manual transactions, and a
// monthly AI report gets real value for £0. Pro unlocks volume + advanced
// analytics — never paywalls the core "see your money" experience.
//
// Pricing is intentionally simple and fair:
//   - No annual price hike surprises
//   - No dark-pattern cancellation maze
//   - Cancel anytime, keep Free-tier access
//   - Merchant-of-record handles VAT/sales-tax + PCI (we never touch cards)
//
// When a processor (Lemon Squeezy / Polar / Paddle) is plugged in, the
// `plan` field flips FREE → PRO on webhook confirmation, not on our say-so.

export enum PlanEnum {
  FREE = "FREE",
  PRO = "PRO",
}

export interface PlanLimits {
  // Connected accounts across all rails (Stripe, Bank, Crypto, Cash, etc.)
  maxAccounts: number | null; // null = unlimited
  // AI-powered bank statement parsing (Gemini calls cost real $)
  maxMonthlyAiImports: number | null;
  // Receipt photo scanning (Gemini vision calls)
  maxMonthlyScans: number | null;
  // Bulk CSV/manual imports per month (bulk inserts)
  maxMonthlyImports: number | null;
  // Email report frequency — Free gets monthly, Pro gets weekly + monthly
  reportFrequency: "MONTHLY" | "WEEKLY_AND_MONTHLY";
  // Net-worth history retention — Free sees current snapshot, Pro gets trends
  netWorthHistoryDays: number | null; // null = full history
}

export interface PlanDefinition {
  id: PlanEnum;
  name: string;
  tagline: string;
  priceMonthly: number; // in GBP (£)
  priceYearly: number;
  limits: PlanLimits;
  highlights: string[];
}

export const PLANS: Record<PlanEnum, PlanDefinition> = {
  [PlanEnum.FREE]: {
    id: PlanEnum.FREE,
    name: "Free",
    tagline: "Everything you need to track your money, fairly.",
    priceMonthly: 0,
    priceYearly: 0,
    limits: {
      maxAccounts: 3,
      maxMonthlyAiImports: 10,
      maxMonthlyScans: 10,
      maxMonthlyImports: 50,
      reportFrequency: "MONTHLY",
      netWorthHistoryDays: 30,
    },
    highlights: [
      "Unlimited manual transactions",
      "Up to 3 connected accounts",
      "10 AI statement imports / month",
      "10 receipt scans / month",
      "Monthly AI insights report",
      "Current net-worth snapshot",
    ],
  },
  [PlanEnum.PRO]: {
    id: PlanEnum.PRO,
    name: "Pro",
    tagline: "For power users who want the full picture, every week.",
    priceMonthly: 4.99,
    priceYearly: 49,
    limits: {
      maxAccounts: null,
      maxMonthlyAiImports: 100,
      maxMonthlyScans: 100,
      maxMonthlyImports: null,
      reportFrequency: "WEEKLY_AND_MONTHLY",
      netWorthHistoryDays: null,
    },
    highlights: [
      "Everything in Free, plus:",
      "Unlimited connected accounts",
      "100 AI statement imports / month",
      "100 receipt scans / month",
      "Weekly + monthly reports",
      "Full net-worth history & trends",
      "Period-over-period analytics",
    ],
  },
};

export const getPlanLimits = (plan: PlanEnum): PlanLimits =>
  PLANS[plan].limits;

export const getPlanDefinition = (plan: PlanEnum): PlanDefinition =>
  PLANS[plan];

export const ALL_PLANS = Object.values(PLANS);
