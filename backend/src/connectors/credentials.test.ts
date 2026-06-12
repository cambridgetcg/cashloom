import { describe, it, expect, afterEach, vi } from "vitest";
import { isAllowedCredentialRef, resolveCredentialRef } from "./credentials";
import { AppError, InternalServerException } from "../utils/app-error";
import { HTTPSTATUS } from "../config/http.config";

// Obviously-fake placeholder — never a real key shape with entropy.
// The ref must live in the CLOSED connector-credential namespace (STRIPE_* /
// GOCARDLESS_* / ALCHEMY_*) — anything else is refused before the environment
// is read.
const FAKE_SECRET = "rk_test_FAKE";
const REF = "STRIPE_CASHLOOM_TEST_KEY";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCredentialRef", () => {
  it("returns the env var value when set", () => {
    vi.stubEnv(REF, FAKE_SECRET);
    expect(resolveCredentialRef(REF)).toBe(FAKE_SECRET);
  });

  it("throws an AppError when the env var is unset", () => {
    delete process.env[REF];
    expect(() => resolveCredentialRef(REF)).toThrow(AppError);
  });

  it("throws a 500-family InternalServerException (misconfiguration, not user error)", () => {
    delete process.env[REF];
    try {
      resolveCredentialRef(REF);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      expect((e as InternalServerException).statusCode).toBe(
        HTTPSTATUS.INTERNAL_SERVER_ERROR
      );
    }
  });

  it("names the missing env VAR in the message", () => {
    delete process.env[REF];
    expect(() => resolveCredentialRef(REF)).toThrow(REF);
  });

  it("treats an empty-string env var as missing", () => {
    vi.stubEnv(REF, "");
    expect(() => resolveCredentialRef(REF)).toThrow(REF);
  });

  it("treats a whitespace-only env var as missing", () => {
    vi.stubEnv(REF, "   ");
    expect(() => resolveCredentialRef(REF)).toThrow(REF);
  });

  it("never includes a credential value in the error message", () => {
    // Set a sibling secret to prove no env values leak into the message,
    // whichever var the error talks about.
    vi.stubEnv("STRIPE_CASHLOOM_TEST_OTHER_KEY", FAKE_SECRET);
    delete process.env[REF];
    try {
      resolveCredentialRef(REF);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_SECRET);
    }
  });

  it("rejects an empty ref outright", () => {
    expect(() => resolveCredentialRef("")).toThrow(AppError);
    expect(() => resolveCredentialRef("   ")).toThrow(AppError);
  });
});

describe("the closed credentialRef namespace", () => {
  // credentialRef is user input the server resolves from its OWN environment.
  // Refs outside the connector-credential namespace must be refused WITHOUT
  // reading the environment — otherwise an authenticated user could point a
  // connector at JWT_SECRET / DATABASE_URL and exfiltrate them upstream.
  it.each([
    "JWT_SECRET",
    "DATABASE_URL",
    "MONGO_URI",
    "RESEND_API_KEY",
    "PATH",
    "stripe_lowercase",
    "STRIPE-DASHED",
    "XSTRIPE_KEY",
    "ALCHEMYX_FOO", // ALCHEMY is a PREFIX of a real var name, not a substring license
    "alchemy_api_key",
  ])("refuses to resolve %s even when the env var is set", (ref) => {
    vi.stubEnv(ref, FAKE_SECRET);
    try {
      resolveCredentialRef(ref);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalServerException);
      // Names the refused VARIABLE, never any value.
      expect((e as Error).message).toContain(ref);
      expect((e as Error).message).not.toContain(FAKE_SECRET);
    }
  });

  it("resolves refs inside the namespace", () => {
    vi.stubEnv("STRIPE_RESTRICTED_KEY_ALT", FAKE_SECRET);
    vi.stubEnv("GOCARDLESS_SECRET_ID", "gc_secret_id_FAKE");
    vi.stubEnv("ALCHEMY_API_KEY", "FAKE");
    expect(resolveCredentialRef("STRIPE_RESTRICTED_KEY_ALT")).toBe(FAKE_SECRET);
    expect(resolveCredentialRef("GOCARDLESS_SECRET_ID")).toBe(
      "gc_secret_id_FAKE"
    );
    expect(resolveCredentialRef("ALCHEMY_API_KEY")).toBe("FAKE");
  });

  it("isAllowedCredentialRef matches only the connector namespace", () => {
    expect(isAllowedCredentialRef("STRIPE_RESTRICTED_KEY")).toBe(true);
    expect(isAllowedCredentialRef("GOCARDLESS_SECRET_KEY")).toBe(true);
    expect(isAllowedCredentialRef("ALCHEMY_API_KEY")).toBe(true);
    expect(isAllowedCredentialRef("JWT_SECRET")).toBe(false);
    expect(isAllowedCredentialRef("STRIPE_")).toBe(false); // prefix alone is not a name
    expect(isAllowedCredentialRef("ALCHEMY_")).toBe(false);
    expect(isAllowedCredentialRef("ALCHEMYX_FOO")).toBe(false);
  });
});
