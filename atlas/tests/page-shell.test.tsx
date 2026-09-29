import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { metadataForPath, PAGE_METADATA } from "../src/page-metadata";
import { PageLoadFailure } from "../src/components/PageErrorBoundary";
import { PHILOSOPHY } from "../src/atlas.manifest";

describe("public page identity and recovery", () => {
  it("gives each service destination its own description and stable canonical URL", () => {
    expect(Object.keys(PAGE_METADATA)).toHaveLength(8);
    expect(new Set(Object.values(PAGE_METADATA).map(page => page.description)).size).toBe(8);
    for (const path of Object.keys(PAGE_METADATA)) {
      const page = metadataForPath(path);
      expect(page.title).toContain("CashLoom");
      expect(page.canonical).toBe(`https://cashloom.io${path}`);
      expect(page.robots).toBe("index,follow");
    }
  });
  it("normalizes the legacy alias and trailing slash without indexing unknown addresses", () => {
    expect(metadataForPath("/blockchain/")).toEqual(metadataForPath("/onchain"));
    expect(metadataForPath("/plan/")).toEqual(metadataForPath("/plan"));
    for (const path of ["/not-a-page", "/constructor", "/__proto__"]) {
      expect(metadataForPath(path).canonical).toBeNull();
      expect(metadataForPath(path).robots).toBe("noindex,follow");
    }
  });
  it("offers an explicit reload and overview path with an unsaved-plan warning", () => {
    const html = renderToStaticMarkup(<PageLoadFailure />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reload page");
    expect(html).toContain('href="/">Back to overview');
    expect(html).toContain("reloading can lose those changes");
  });
  it("describes the private pilot and implemented routes without universal-access claims", () => {
    const text = PHILOSOPHY.creed.join(" ");
    expect(text).toContain("private repository");
    expect(text).toContain("external services");
    expect(text).toContain("bank payments and external-wallet execution are not enabled");
    expect(text).not.toMatch(/every open rail|no server|no telemetry|anyone may/i);
  });
});
