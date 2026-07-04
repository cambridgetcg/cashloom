import { RequestHandler, Request } from "express";
import { PlanEnum, getPlanLimits } from "../config/plans.config";
import TransactionModel from "../models/transaction.model";
import AccountModel from "../models/account.model";
import { HTTPSTATUS } from "../config/http.config";

type QuotaType = "aiImport" | "scan" | "bulkImport" | "account";

interface QuotaCheck {
  type: QuotaType;
  limit: number | null;
  used: number;
}

// Counts usage in the current calendar month for the given user.
const countMonthlyUsage = async (userId: string) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [aiImports, scans, imports] = await Promise.all([
    // AI statement parses result in AI_IMPORT transactions
    TransactionModel.countDocuments({
      userId,
      source: "AI_IMPORT",
      createdAt: { $gte: monthStart, $lt: monthEnd },
    }),
    // Receipt scans store the receipt URL — count by source MANUAL + receiptUrl
    TransactionModel.countDocuments({
      userId,
      receiptUrl: { $exists: true, $ne: null },
      createdAt: { $gte: monthStart, $lt: monthEnd },
    }),
    // CSV / manual bulk imports
    TransactionModel.countDocuments({
      userId,
      source: "CSV",
      createdAt: { $gte: monthStart, $lt: monthEnd },
    }),
  ]);

  return { aiImports, scans, imports };
};

const countAccounts = async (userId: string) => {
  return AccountModel.countDocuments({ userId, status: "ACTIVE" });
};

// Returns the user's plan (defaults to FREE if the field isn't populated yet
// — e.g. users created before the plan field existed).
const getUserPlan = (req: Request): PlanEnum => {
  const user = (req as any).user;
  if (user?.plan && Object.values(PlanEnum).includes(user.plan)) {
    return user.plan as PlanEnum;
  }
  return PlanEnum.FREE;
};

// Generic quota checker — wraps any expensive route.
export const requireQuota = (type: QuotaType): RequestHandler => {
  return async (req, res, next) => {
    try {
      const userId = (req as any).user?.id || (req as any).user?._id;
      if (!userId) {
        // Return, or execution falls through to the quota queries and next()
        // with an undefined userId — a second response after this one under
        // automated request volume.
        res.status(HTTPSTATUS.UNAUTHORIZED).json({
          message: "Authentication required",
        });
        return;
      }

      const plan = getUserPlan(req);
      const limits = getPlanLimits(plan);

      let limit: number | null;
      let used: number;

      switch (type) {
        case "aiImport":
          limit = limits.maxMonthlyAiImports;
          used = (await countMonthlyUsage(userId)).aiImports;
          break;
        case "scan":
          limit = limits.maxMonthlyScans;
          used = (await countMonthlyUsage(userId)).scans;
          break;
        case "bulkImport":
          limit = limits.maxMonthlyImports;
          used = (await countMonthlyUsage(userId)).imports;
          break;
        case "account":
          limit = limits.maxAccounts;
          used = await countAccounts(userId);
          break;
        default:
          return next();
      }

      // null limit = unlimited (Pro)
      if (limit === null) {
        return next();
      }

      if (used >= limit) {
        // Return, or the over-limit request proceeds through next() anyway
        // and the route handler double-responds — the quota was decorative.
        res.status(HTTPSTATUS.TOO_MANY_REQUESTS).json({
          message: `You've reached your ${type} limit for this month (${limit}). Upgrade to Pro for more.`,
          quota: { type, plan, limit, used, remaining: 0 },
          upgradeUrl: "/settings/plan",
        });
        return;
      }

      // Attach usage info for the controller to include in the response
      (req as any).quotaInfo = { type, plan, limit, used, remaining: limit - used };

      return next();
    } catch (error) {
      // Never block on a quota counting error — fail open, log it.
      console.error("Quota check error:", error);
      return next();
    }
  };
};
