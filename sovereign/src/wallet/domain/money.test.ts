import { describe, expect, it } from "vitest";
import { fiatAssetRef } from "./identities";
import {
  addMoney,
  compareMoney,
  money,
  nonNegativeMoney,
  positiveMoney,
  subtractMoney,
} from "./money";

describe("exact Wallet Kernel money", () => {
  const usd = fiatAssetRef("USD");
  const eur = fiatAssetRef("EUR");

  it("only accepts canonical atomic-unit strings", () => {
    expect(money(usd, "0").atomic).toBe("0");
    expect(money(usd, "-1").atomic).toBe("-1");
    for (const invalid of ["00", "01", "-0", "+1", "1.0", "1e3", " 1", 1]) {
      expect(() => money(usd, invalid), String(invalid)).toThrow();
    }
    expect(nonNegativeMoney(usd, "0").atomic).toBe("0");
    expect(() => nonNegativeMoney(usd, "-1")).toThrow();
    expect(positiveMoney(usd, "1").atomic).toBe("1");
    expect(() => positiveMoney(usd, "0")).toThrow();
  });

  it("does exact arithmetic beyond Number.MAX_SAFE_INTEGER", () => {
    const enormous = money(usd, "999999999999999999999999999999999999");
    expect(addMoney(enormous, money(usd, "1")).atomic).toBe(
      "1000000000000000000000000000000000000",
    );
    expect(subtractMoney(enormous, money(usd, "1000000000000000000000000000000000000")).atomic).toBe(
      "-1",
    );
    expect(compareMoney(enormous, money(usd, "1"))).toBe(1);
  });

  it("refuses arithmetic across asset identities", () => {
    expect(() => addMoney(money(usd, "1"), money(eur, "1"))).toThrow(/asset mismatch/);
  });
});

