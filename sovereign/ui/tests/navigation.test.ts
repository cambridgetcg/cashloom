import { describe, expect, test } from "bun:test";
import { publicPlanUrlForOrigin, readWalletRoute, WALLET_VIEWS, walletViewFromHash, walletViewHash } from "../src/navigation";
import { isAddressKey } from "../src/wallet-key";

describe("private view navigation", () => {
  test("each view can reopen without putting account or key identifiers in a URL", () => {
    for (const view of WALLET_VIEWS) {
      expect(walletViewFromHash(walletViewHash(view.id))).toBe(view.id);
      expect(walletViewHash(view.id)).toMatch(/^#\/[a-z]+$/);
    }
    expect(readWalletRoute()).toEqual({ view: "dashboard" });
  });

  test("unknown paths and URL-supplied account context cannot select private records", () => {
    for (const value of ["", "#/pay?accountId=foreign", "#/trades/foreign", "#//external.example", "#/keys/private", "#/%70ay"]) {
      expect(walletViewFromHash(value)).toBe("dashboard");
    }
  });

  test("record-signing material and malformed addresses are never receiving keys", () => {
    const key = { id: "k", label: "public-only fixture", kind: "evm", address: `0x${"1".repeat(40)}`, created_at: "2026-09-23T00:00:00Z" };
    expect(isAddressKey(key)).toBe(true);
    expect(isAddressKey({ ...key, kind: "secret" })).toBe(false);
    expect(isAddressKey({ ...key, address: "ed25519-public-record-key" })).toBe(false);
    expect(isAddressKey({ ...key, kind: "btc", address: "bc1invalid" })).toBe(false);
  });
});

describe("optional service preview destination", () => {
  test("accepts HTTPS or loopback HTTP origins and adds only the public planner path", () => {
    expect(publicPlanUrlForOrigin("https://cashloom.io")).toBe("https://cashloom.io/plan");
    expect(publicPlanUrlForOrigin("https://preview.example:8443/")).toBe("https://preview.example:8443/plan");
    expect(publicPlanUrlForOrigin("http://127.0.0.1:5179")).toBe("http://127.0.0.1:5179/plan");
    expect(publicPlanUrlForOrigin("http://localhost:5179/")).toBe("http://localhost:5179/plan");
    expect(publicPlanUrlForOrigin("http://[::1]:5179")).toBe("http://[::1]:5179/plan");
  });

  test("missing or unsafe configuration never supplies an active planner destination", () => {
    for (const value of [undefined, null, "", 42, "/plan", "//cashloom.io", "http://cashloom.io", "http://localhost.example", "http://127.0.0.1.example", "https://user:password@example.com", "https://@example.com", "https://example.com/plan", "https://example.com/../", "https://example.com?account=private", "https://example.com?", "https://example.com#private", "https://example.com#", "https://example.com\\", "https://example.com\n", "https://example.com\u001f", "javascript:alert(1)", "file:///plan"]) {
      expect(publicPlanUrlForOrigin(value)).toBeNull();
    }
  });
});
