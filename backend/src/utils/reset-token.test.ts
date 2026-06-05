import { describe, it, expect } from "vitest";
import { hashResetToken, generateResetToken } from "./reset-token";

describe("reset token", () => {
  it("hashes deterministically to 64 hex chars", () => {
    expect(hashResetToken("abc")).toBe(hashResetToken("abc"));
    expect(hashResetToken("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes different tokens differently", () => {
    expect(hashResetToken("abc")).not.toBe(hashResetToken("abd"));
  });

  it("generates a token whose hash matches hashResetToken(token)", () => {
    const { token, tokenHash } = generateResetToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/); // 32 random bytes, hex
    expect(tokenHash).toBe(hashResetToken(token));
  });

  it("generates a different token each time", () => {
    expect(generateResetToken().token).not.toBe(generateResetToken().token);
  });
});
