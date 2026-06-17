import { describe, it, expect } from "vitest";
import { getSender, registerSender } from "./index";
import { PaymentSender, SendStatus } from "./types";

describe("sender registry", () => {
  it("returns the registered memory sender", () => {
    expect(getSender("memory").type).toBe("memory");
  });

  it("throws BadRequest for an unknown type", () => {
    expect(() => getSender("nope-not-registered")).toThrow(/Unknown payment sender/);
  });

  it("lets a test override/register a type", () => {
    const fake: PaymentSender = {
      type: "fake",
      async send() {
        return { externalId: "f", feeMinor: "0", status: SendStatus.COMPLETED };
      },
    };
    registerSender("override-me", fake);
    expect(getSender("override-me")).toBe(fake);
  });
});