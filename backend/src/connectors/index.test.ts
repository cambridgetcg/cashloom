import { describe, it, expect } from "vitest";
import { getConnector, registerConnector } from "./index";
import { BadRequestException } from "../utils/app-error";
import type { RailConnector } from "./types";

// Registry smoke test: the wiring item (P2-8) registers the crypto observers
// alongside the existing built-ins. Resolution only — no connector method is
// called, so no env vars and no HTTP are involved.

describe("connector registry", () => {
  it("resolves 'esplora' to the Esplora connector", () => {
    const connector = getConnector("esplora", "BTC");
    expect(connector.type).toBe("esplora");
  });

  it("resolves 'alchemy' to the Alchemy connector", () => {
    const connector = getConnector("alchemy", "ETH");
    expect(connector.type).toBe("alchemy");
  });

  it("resolves 'agenttool' to the agenttool connector", () => {
    const connector = getConnector("agenttool", "GBP");
    expect(connector.type).toBe("agenttool");
  });

  it("still resolves the existing 'stripe' factory (currency-pinned)", () => {
    const connector = getConnector("stripe", "GBP");
    expect(connector.type).toBe("stripe");
  });

  it("still resolves the existing 'gocardless' singleton", () => {
    const connector = getConnector("gocardless", "GBP");
    expect(connector.type).toBe("gocardless");
  });

  it("throws BadRequestException (a data problem, not a server fault) on an unknown type", () => {
    expect(() => getConnector("dogechain", "DOGE")).toThrow(
      BadRequestException
    );
    expect(() => getConnector("dogechain", "DOGE")).toThrow(
      /Unknown connector type "dogechain"/
    );
  });

  it("registration stays additive: a test override resolves without touching built-ins", () => {
    const fake: RailConnector = {
      type: "fake-rail",
      fetchBalance: async () => {
        throw new Error("not called");
      },
      fetchTransactions: async () => [],
    };
    registerConnector("fake-rail", fake);
    expect(getConnector("fake-rail", "GBP")).toBe(fake);
    // Built-ins are unaffected by the extra registration.
    expect(getConnector("esplora", "BTC").type).toBe("esplora");
  });
});
