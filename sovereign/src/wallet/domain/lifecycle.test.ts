import { describe, expect, it } from "vitest";
import {
  PAYMENT_LIFECYCLE_INITIAL_STATES,
  TERMINAL_PAYMENT_STATES,
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  parseInitialPaymentLifecycleState,
} from "./lifecycle";

describe("payment lifecycle", () => {
  it("supports signed crypto and provider-authorized fiat paths", () => {
    expect(canTransition("prepared", "signed")).toBe(true);
    expect(canTransition("prepared", "submitted")).toBe(true);
    expect(canTransition("submitted", "ambiguous")).toBe(true);
  });

  it("permits durable pre-execution projections but not fabricated execution outcomes", () => {
    expect(PAYMENT_LIFECYCLE_INITIAL_STATES).toContain("quoted");
    expect(PAYMENT_LIFECYCLE_INITIAL_STATES).toContain("authorized");
    expect(parseInitialPaymentLifecycleState("authorized")).toBe("authorized");
    expect(() => parseInitialPaymentLifecycleState("submitted")).toThrow();
    expect(() => parseInitialPaymentLifecycleState("settled")).toThrow();
  });

  it("does not turn ambiguity into an automatic retry state", () => {
    expect(allowedTransitionsFrom("ambiguous")).not.toContain("submitted");
    expect(canTransition("ambiguous", "settled")).toBe(true);
    expect(() => assertTransition("ambiguous", "submitted")).toThrow(/invalid/);
  });

  it("allows post-settlement evidence without treating settlement as terminal", () => {
    expect(TERMINAL_PAYMENT_STATES.has("settled")).toBe(false);
    expect(canTransition("settled", "reversed")).toBe(true);
    expect(canTransition("settled", "charged_back")).toBe(true);
    expect(canTransition("settled", "reorged")).toBe(true);
    expect(TERMINAL_PAYMENT_STATES.has("refunded")).toBe(true);
  });
});
