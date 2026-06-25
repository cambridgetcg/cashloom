import { Request, Response } from "express";
import { HTTPSTATUS } from "../config/http.config";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "../validators/auth.validator";
import {
  forgotPasswordService,
  loginService,
  registerService,
  resetPasswordService,
} from "../services/auth.service";

export const registerController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = registerSchema.parse(req.body);

    const { user, accessToken, expiresAt, reportSetting } =
      await registerService(body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "User registered successfully",
      user,
      accessToken,
      expiresAt,
      reportSetting,
    });
  }
);

export const loginController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = loginSchema.parse({
      ...req.body,
    });
    const { user, accessToken, expiresAt, reportSetting } =
      await loginService(body);

    return res.status(HTTPSTATUS.OK).json({
      message: "User logged in successfully",
      user,
      accessToken,
      expiresAt,
      reportSetting,
    });
  }
);

export const forgotPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const result = await forgotPasswordService(email);
    return res.status(HTTPSTATUS.OK).json(result);
  }
);

export const resetPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    const result = await resetPasswordService(token, password);
    return res.status(HTTPSTATUS.OK).json(result);
  }
);

export const logoutController = asyncHandler(
  async (_req: Request, res: Response) => {
    // Stateless JWT — the client discards the token. This endpoint gives the
    // client a clean API surface to call on logout (and a hook to add a
    // server-side blocklist later if needed).
    return res.status(HTTPSTATUS.OK).json({
      message: "Logged out successfully",
    });
  }
);
