import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import { netWorthQuerySchema } from "../validators/valuation.validator";
import { netWorthValuationService } from "../services/valuation.service";

// Partial data is a 200 BY DESIGN: the service folds unpriced currencies into
// unconverted[] (complete:false) and stale quotes into stale:true rather than
// failing the request — only true faults (malformed data, programming errors)
// reach the errorHandler as 500s.
export const netWorthController = asyncHandler(
  async (req: Request, res: Response) => {
    const { home } = netWorthQuerySchema.parse(req.query);
    const userId = req.user?._id;

    const netWorth = await netWorthValuationService(userId, home);

    return res.status(HTTPSTATUS.OK).json({
      message: "Net worth fetched successfully",
      netWorth,
    });
  }
);
