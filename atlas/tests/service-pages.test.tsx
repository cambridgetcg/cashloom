import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "../src/service/Home";
import Connections from "../src/service/Connections";
import { readFileSync } from "node:fs";

afterEach(() => vi.unstubAllGlobals());

describe("service entry routes", () => {
  it("gives a useful plan and local-workspace path without claiming account access", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('href="/plan"');
    expect(html).toContain('href="/wallet"');
    expect(html).toContain("Your private workspace runs on your own computer");
    expect(html).toContain("developer pilot requires repository access");
    expect(html).toContain("My household");
    expect(html).toContain("Independent work");
    expect(html).toContain("A small group");
    expect(html).not.toContain("<input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps capability descriptions separate from live connection status", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(<Connections />);
    expect(html).toContain("does not inspect your accounts or report live connection status");
    expect(html).toContain("self-service bank-linking journey is not enabled");
    expect(html).toContain("No live bank-payment action is offered");
    expect(html).toContain("Recording activity does not change a saved balance or move money");
    expect(html).not.toContain('href="http://127.0.0.1');
    expect(html).not.toContain("<input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps public website navigation targets wired, including workspace handoff anchors", async () => {
    const { default: WalletGuide } = await import("../src/wallet/WalletGuide");
    const pages = [renderToStaticMarkup(<Home />), renderToStaticMarkup(<Connections />)];
    const workspace = renderToStaticMarkup(<WalletGuide />);
    const supported = new Set(["/", "/plan", "/wallet", "/connections", "/world", "/capital-flows", "/onchain", "/atlas", "/v1/data-practices", "/RIGHTS.md"]);
    for (const html of pages) for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
      const url = new URL(href, "https://cashloom.invalid");
      expect(supported.has(url.pathname), href).toBe(true);
      if (url.pathname === "/wallet" && url.hash) expect(workspace, href).toContain(`id="${url.hash.slice(1)}"`);
    }
  });

  it("does not require a third-party font request to use the planner", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });
});
