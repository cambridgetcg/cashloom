import mongoose from "mongoose";
import UserModel from "../models/user.model";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../utils/app-error";
import {
  LoginSchemaType,
  RegisterSchemaType,
} from "../validators/auth.validator";
import ReportSettingModel, {
  ReportFrequencyEnum,
} from "../models/report-setting.model";
import { calculateNextReportDate } from "../utils/helper";
import { signJwtToken } from "../utils/jwt";
import { generateResetToken, hashResetToken } from "../utils/reset-token";
import { sendPasswordResetEmail } from "../mailers/password-reset.mailer";
import { Env } from "../config/env.config";

const RESET_TOKEN_TTL_MIN = 30;

export const registerService = async (body: RegisterSchemaType) => {
  const { email } = body;

  const session = await mongoose.startSession();

  try {
    // withTransaction's callback return isn't propagated, so capture what we
    // need in the outer scope instead of returning from inside.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let newUser: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reportSetting: any;

    await session.withTransaction(async () => {
      const existingUser = await UserModel.findOne({ email }).session(session);
      if (existingUser) throw new UnauthorizedException("User already exists");

      newUser = new UserModel({
        ...body,
      });

      await newUser.save({ session });

      reportSetting = new ReportSettingModel({
        userId: newUser._id,
        frequency: ReportFrequencyEnum.MONTHLY,
        isEnabled: true,
        nextReportDate: calculateNextReportDate(),
        lastSentDate: null,
      });
      await reportSetting.save({ session });
    });

    if (!newUser) throw new UnauthorizedException("Registration failed");

    // Issue a token now so signup logs the user straight in — no second login.
    const { token, expiresAt } = signJwtToken({ userId: newUser.id });

    return {
      user: newUser.omitPassword(),
      accessToken: token,
      expiresAt,
      reportSetting: {
        _id: reportSetting?._id,
        frequency: reportSetting?.frequency,
        isEnabled: reportSetting?.isEnabled,
      },
    };
  } catch (error) {
    throw error;
  } finally {
    await session.endSession();
  }
};

export const loginService = async (body: LoginSchemaType) => {
  const { email, password } = body;
  // Password is select:false on the schema, so opt it back in just here.
  const user = await UserModel.findOne({ email }).select("+password");
  if (!user) throw new NotFoundException("Email/password not found");

  const isPasswordValid = await user.comparePassword(password);

  if (!isPasswordValid)
    throw new UnauthorizedException("Invalid email/password");

  const { token, expiresAt } = signJwtToken({ userId: user.id });

  const reportSetting = await ReportSettingModel.findOne(
    {
      userId: user.id,
    },
    { _id: 1, frequency: 1, isEnabled: 1 }
  ).lean();

  return {
    user: user.omitPassword(),
    accessToken: token,
    expiresAt,
    reportSetting,
  };
};

export const forgotPasswordService = async (email: string) => {
  const user = await UserModel.findOne({ email: email.toLowerCase() });

  // Always respond the same way — never reveal whether an email is registered.
  if (user) {
    const { token, tokenHash } = generateResetToken();
    user.resetPasswordToken = tokenHash;
    user.resetPasswordExpires = new Date(
      Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000
    );
    await user.save();

    const resetUrl = `${Env.FRONTEND_ORIGIN}/reset-password?token=${token}`;

    try {
      await sendPasswordResetEmail({
        email: user.email,
        username: user.name,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MIN,
      });
    } catch (error) {
      // If the email can't be sent, don't leave a live token dangling.
      user.resetPasswordToken = null;
      user.resetPasswordExpires = null;
      await user.save();
      throw error;
    }
  }

  return {
    message: "If that email is registered, a reset link is on its way.",
  };
};

export const resetPasswordService = async (token: string, password: string) => {
  const tokenHash = hashResetToken(token);

  const user = await UserModel.findOne({
    resetPasswordToken: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
  });

  if (!user) {
    throw new BadRequestException("This reset link is invalid or has expired.");
  }

  // Setting password marks it modified → the pre-save hook hashes it.
  // Clearing the token makes the link single-use.
  user.password = password;
  user.resetPasswordToken = null;
  user.resetPasswordExpires = null;
  await user.save();

  return { message: "Your password has been reset. You can sign in now." };
};
