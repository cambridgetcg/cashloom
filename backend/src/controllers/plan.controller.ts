import { Request, Response } from "express";
import { HTTPSTATUS } from "../config/http.config";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { ALL_PLANS, getPlanDefinition, PlanEnum } from "../config/plans.config";
import TransactionModel from "../models/transaction.model";
import AccountModel from "../models/account.model";

// Public — no auth required. Returns all plans + their limits for the pricing page.
export const getPlansController = asyncHandler(
  async (_req: Request, res: Response) => {
    return res.status(HTTPSTATUS.OK).json({
      plans: ALL_PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        currency: "GBP",
        highlights: p.highlights,
      })),
    });
  }
);

// Authenticated — returns the current user's plan + this month's usage.
export const getMyPlanController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = (req as any).user?.id || (req as any).user?._id;
    const user = (req as any).user;

    const plan = (user?.plan as PlanEnum) || PlanEnum.FREE;
    const definition = getPlanDefinition(plan);
    const limits = definition.limits;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [aiImports, scans, imports, accounts] = await Promise.all([
      TransactionModel.countDocuments({
        userId,
        source: "AI_IMPORT",
        createdAt: { $gte: monthStart, $lt: monthEnd },
      }),
      TransactionModel.countDocuments({
        userId,
        receiptUrl: { $exists: true, $ne: null },
        createdAt: { $gte: monthStart, $lt: monthEnd },
      }),
      TransactionModel.countDocuments({
        userId,
        source: "CSV",
        createdAt: { $gte: monthStart, $lt: monthEnd },
      }),
      AccountModel.countDocuments({ userId, status: "ACTIVE" }),
    ]);

    return res.status(HTTPSTATUS.OK).json({
      plan,
      planName: definition.name,
      tagline: definition.tagline,
      priceMonthly: definition.priceMonthly,
      limits,
      usage: {
        aiImports: { used: aiImports, limit: limits.maxMonthlyAiImports },
        scans: { used: scans, limit: limits.maxMonthlyScans },
        imports: { used: imports, limit: limits.maxMonthlyImports },
        accounts: { used: accounts, limit: limits.maxAccounts },
      },
      // Placeholder for when a merchant-of-record webhook flips the plan.
      // The checkout URL comes from Lemon Squeezy / Polar / Paddle, not us.
      checkoutUrl: null,
    });
  }
);
