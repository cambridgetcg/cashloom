import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Tests the security-critical reset path against a real DB: valid token sets a
// new password and is single-use, expired/used tokens are rejected. We only
// call resetPasswordService (never forgot), so no email is ever sent.
let mongod: MongoMemoryServer;
let resetPasswordService: (
  token: string,
  password: string
) => Promise<{ message: string }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UserModel: any;
let hashResetToken: (t: string) => string;

beforeAll(async () => {
  process.env.MONGO_URI ||= "mongodb://test";
  process.env.GEMINI_API_KEY ||= "test";
  process.env.CLOUDINARY_CLOUD_NAME ||= "test";
  process.env.CLOUDINARY_API_KEY ||= "test";
  process.env.CLOUDINARY_API_SECRET ||= "test";
  process.env.RESEND_API_KEY ||= "test";

  ({ resetPasswordService } = await import("./auth.service"));
  ({ default: UserModel } = await import("../models/user.model"));
  ({ hashResetToken } = await import("../utils/reset-token"));

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("resetPasswordService (real DB)", () => {
  it("sets a new password with a valid token, then the token is single-use", async () => {
    const user = await UserModel.create({
      name: "Reset Me",
      email: "reset@example.com",
      password: "oldpassword",
      resetPasswordToken: hashResetToken("goodtoken"),
      resetPasswordExpires: new Date(Date.now() + 60_000),
    });

    await resetPasswordService("goodtoken", "brandnewpass");

    const after = await UserModel.findById(user._id).select(
      "+password +resetPasswordToken +resetPasswordExpires"
    );
    expect(await after.comparePassword("brandnewpass")).toBe(true);
    expect(await after.comparePassword("oldpassword")).toBe(false);

    // Token cleared on use -> can't be replayed.
    expect(after.resetPasswordToken == null).toBe(true);
    expect(after.resetPasswordExpires == null).toBe(true);
    await expect(
      resetPasswordService("goodtoken", "whatever123")
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    await UserModel.create({
      name: "Expired",
      email: "expired@example.com",
      password: "oldpass",
      resetPasswordToken: hashResetToken("expiredtoken"),
      resetPasswordExpires: new Date(Date.now() - 1000),
    });
    await expect(
      resetPasswordService("expiredtoken", "newpass123")
    ).rejects.toThrow();
  });
});
