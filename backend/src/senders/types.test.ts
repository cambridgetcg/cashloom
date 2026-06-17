import { describe, it, expect } from "vitest";
import type { PaymentSender, PaymentInstruction, PaymentReceipt } from "./types";
import { SendStatus } from "./types";

describe("PaymentSender seam shape", () => {
  it("a conforming sender has a type and an async send returning a receipt", async () => {
    const sender: PaymentSender = {
      type: "stub",
      async send(_ctx, instruction: PaymentInstruction): Promise<PaymentReceipt> {
        return { externalId: "x", feeMinor: "0", status: SendStatus.COMPLETED };
      },
    };
    const receipt = await sender.send(
      { externalAccountId: "a", credentialRef: null },
      { to: "b", amountMinor: "100", asset: "BTC" }
    );
    expect(receipt.status).toBe(SendStatus.COMPLETED);
    expect(receipt.externalId).toBe("x");
  });
});