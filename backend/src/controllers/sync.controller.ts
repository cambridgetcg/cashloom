import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import { accountIdSchema } from "../validators/account.validator";
import {
  syncAccountService,
  syncAllAccountsService,
} from "../services/sync.service";

// POST {BASE}/account/sync/:id — pull one account's balance + transactions
// through its read-only connector.
export const syncAccountController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const accountId = accountIdSchema.parse(req.params.id);

    const result = await syncAccountService(userId, accountId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Account synced successfully",
      result,
    });
  }
);

// POST {BASE}/account/sync-all — sweep every ACTIVE connector-backed account.
// Always 200: per-account failures ride in results[].ok / results[].error so
// one broken rail never hides the accounts that synced fine.
export const syncAllAccountsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;

    const results = await syncAllAccountsService(userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Account sync completed",
      results,
    });
  }
);
