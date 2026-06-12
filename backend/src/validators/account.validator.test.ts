import { describe, it, expect } from "vitest";
import { createAccountSchema, updateAccountSchema } from "./account.validator";

// credentialRef is user input that the server resolves from its OWN
// environment — an unbounded ref turns the env-pointer discipline into blind
// exfiltration of arbitrary server secrets (create a stripe account with
// credentialRef "JWT_SECRET", sync, and the value rides to api.stripe.com as
// a bearer token). The validator is the front door of the closed namespace;
// resolveCredentialRef and the Stripe connector enforce it again behind it.

const baseBody = {
  rail: "STRIPE",
  displayName: "Stripe main",
  currency: "USD",
  connectorType: "stripe",
  externalAccountId: "acct_FAKE000000000001",
};

describe("createAccountSchema.credentialRef", () => {
  it("accepts connector-credential env var names", () => {
    for (const ref of [
      "STRIPE_RESTRICTED_KEY",
      "STRIPE_RESTRICTED_KEY_2",
      "GOCARDLESS_SECRET_ID",
    ]) {
      const parsed = createAccountSchema.parse({
        ...baseBody,
        credentialRef: ref,
      });
      expect(parsed.credentialRef).toBe(ref);
    }
  });

  it("accepts an omitted credentialRef (connector default applies)", () => {
    const parsed = createAccountSchema.parse(baseBody);
    expect(parsed.credentialRef).toBeUndefined();
  });

  it("rejects refs naming non-connector server secrets", () => {
    for (const ref of [
      "JWT_SECRET",
      "DATABASE_URL",
      "RESEND_API_KEY",
      "MONGO_URI",
      "PATH",
      "stripe_lowercase",
      "STRIPE-DASHED",
      "XSTRIPE_KEY",
      "STRIPE_", // prefix alone is not a variable name
    ]) {
      expect(() =>
        createAccountSchema.parse({ ...baseBody, credentialRef: ref })
      ).toThrow();
    }
  });

  it("updateAccountSchema enforces the same namespace", () => {
    expect(() =>
      updateAccountSchema.parse({ credentialRef: "JWT_SECRET" })
    ).toThrow();
    expect(
      updateAccountSchema.parse({ credentialRef: "STRIPE_RESTRICTED_KEY" })
        .credentialRef
    ).toBe("STRIPE_RESTRICTED_KEY");
  });
});
