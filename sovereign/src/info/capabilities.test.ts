import { describe, expect, it } from "vitest";
import {
  CASHLOOM_CAPABILITIES,
  CASHLOOM_CAPABILITY_FINGERPRINT,
  fingerprintCapabilities,
} from "./capabilities.ts";

describe("public CashLoom capability contract", () => {
  it("makes the hosted surface incapable of becoming payment or identity authority", () => {
    expect(CASHLOOM_CAPABILITIES.hosted_surface).toMatchObject({
      mode: "information_only",
      moves_money: false,
      holds_funds: false,
      holds_keys: false,
      stores_payment_records: false,
      requires_cashloom_account: false,
      identity_authority: "none",
    });
    expect(
      CASHLOOM_CAPABILITIES.doors.every((door) => !door.requires_account),
    ).toBe(true);
  });

  it("keeps every payment claim narrower than settlement", () => {
    const request = CASHLOOM_CAPABILITIES.payment_truth.find(
      ({ id }) => id === "request",
    );
    const acceptance = CASHLOOM_CAPABILITIES.payment_truth.find(
      ({ id }) => id === "acceptance",
    );
    const commitment = CASHLOOM_CAPABILITIES.payment_truth.find(
      ({ id }) => id === "commitment",
    );
    expect(request?.does_not_prove).toContain("paid");
    expect(acceptance?.does_not_prove).toContain("funds moved");
    expect(commitment?.does_not_prove).toContain("settlement");
    expect(
      CASHLOOM_CAPABILITIES.payment_truth.find(
        ({ id }) => id === "submission_receipt",
      )?.status,
    ).toContain("workflow_not_released");
  });

  it("does not advertise unreleased packages or provider rails as available", () => {
    expect(
      CASHLOOM_CAPABILITIES.distribution.find(
        ({ id }) => id === "desktop_app",
      )?.status,
    ).toContain("not_released");
    const stripe = CASHLOOM_CAPABILITIES.rails.find(
      ({ id }) => id === "stripe_connect",
    );
    expect(
      stripe && "live_transport" in stripe ? stripe.live_transport : undefined,
    ).toBe("not_released");
    expect(CASHLOOM_CAPABILITIES.market_boundary.escrow).toBe(
      "not_provided_by_cashloom",
    );
  });

  it("is a static JSON-safe document", () => {
    expect(JSON.parse(JSON.stringify(CASHLOOM_CAPABILITIES))).toEqual(
      CASHLOOM_CAPABILITIES,
    );
  });

  it("changes its deployment fingerprint when contract content changes", () => {
    expect(CASHLOOM_CAPABILITY_FINGERPRINT).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/,
    );
    expect(
      fingerprintCapabilities({ ...CASHLOOM_CAPABILITIES, name: "Changed" }),
    ).not.toBe(CASHLOOM_CAPABILITY_FINGERPRINT);
  });
});
