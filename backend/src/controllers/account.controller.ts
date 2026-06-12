import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import {
  accountIdSchema,
  createAccountSchema,
  updateAccountSchema,
} from "../validators/account.validator";
import {
  createAccountService,
  getAccountByIdService,
  getAllAccountsService,
  updateAccountService,
} from "../services/account.service";

export const createAccountController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = createAccountSchema.parse(req.body);
    const userId = req.user?._id;

    const account = await createAccountService(body, userId);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "Account created successfully",
      account,
    });
  }
);

export const getAllAccountsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;

    const result = await getAllAccountsService(userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Accounts fetched successfully",
      ...result,
    });
  }
);

export const getAccountByIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const accountId = accountIdSchema.parse(req.params.id);

    const account = await getAccountByIdService(userId, accountId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Account fetched successfully",
      account,
    });
  }
);

export const updateAccountController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const accountId = accountIdSchema.parse(req.params.id);
    const body = updateAccountSchema.parse(req.body);

    const account = await updateAccountService(userId, accountId, body);

    return res.status(HTTPSTATUS.OK).json({
      message: "Account updated successfully",
      account,
    });
  }
);
