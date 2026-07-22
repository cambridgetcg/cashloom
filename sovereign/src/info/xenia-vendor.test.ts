import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The vendored XENIA rights baseline is a BYTE mirror — if these bytes drift,
// the adoption claim in /RIGHTS.md is false and this build should not ship.
// Pin per RIGHTS.md: upstream release npm-xenia-v0.1.0-beta.4.
const PINNED_SHA256 = "b72a6da110c582e5683bf0fabde5017db93d2199398014c8421a82f5318da313";

describe("XENIA vendored rights baseline", () => {
  it("matches the pinned release digest byte-for-byte", () => {
    const path = new URL("../../../vendor/xenia/rights/0.1/RIGHTS.md", import.meta.url);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(digest).toBe(PINNED_SHA256);
  });
});
