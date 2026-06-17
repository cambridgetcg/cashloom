import { describe, it, expect } from "vitest";
import { createMemorySender } from "./memory.sender";
import { SendStatus } from "./types";

describe("memory sender", () => {
  it("returns a COMPLETED receipt with a unique mem_ id and zero fee", async () => {
    const s = createMemorySender();
    const r = await s.send(
      { externalAccountId: "a", credentialRef: null },
      { to: "b", amountMinor: "100", asset: "BTC" }
    );
    expect(r.status).toBe(SendStatus.COMPLETED);
    expect(r.feeMinor).toBe("0");
    expect(r.externalId).toMatch(/^mem_/);
  });

  it("returns a different externalId per send", async () => {
    const s = createMemorySender();
    const a = await s.send({ externalAccountId: "a", credentialRef: null }, { to: "b", amountMinor: "1", asset: "BTC" });
    const b = await s.send({ externalAccountId: "a", credentialRef: null }, { to: "b", amountMinor: "1", asset: "BTC" });
    expect(a.externalId).not.toBe(b.externalId);
  });
});