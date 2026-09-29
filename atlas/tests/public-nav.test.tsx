import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicNav } from "../src/components/PublicNav";
import AtlasNav from "../src/components/Nav";
import Onchain from "../src/onchain/Onchain";
import { CapitalFlowsView } from "../src/capital-flows/CapitalFlows";

const destinations = ["/", "/plan", "/wallet", "/connections", "/world", "/atlas", "/capital-flows", "/onchain"];

describe("public destinations", () => {
  it.each([
    ["onchain", <Onchain />],
    ["capital-flows", <CapitalFlowsView onRefresh={() => {}} />],
    ["atlas", <AtlasNav />],
    ["wallet", <PublicNav current="wallet" />],
    ["home", <PublicNav current="home" />],
    ["plan", <PublicNav current="plan" />],
    ["world", <PublicNav current="world" />],
    ["connections", <PublicNav current="connections" />],
  ] as const)("keeps all destinations reachable from %s with one current page", (page, view) => {
    // Server rendering cannot contact providers or read a browser's saved state.
    const html = renderToStaticMarkup(view);
    const nav = html.match(/<nav class="public-nav" aria-label="CashLoom">([\s\S]*?)<\/nav>/)?.[1];
    expect(nav).toBeDefined();
    expect([...nav!.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual(destinations);
    expect(nav).toContain(`href="${page === "home" ? "/" : `/${page}`}" aria-current="page"`);
    expect(nav!.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toContain("Your workspace");
    expect(nav).toContain("Money insights");
    expect(nav).toContain("Network insights");
    expect(nav).not.toContain("target=");
  });

  it("keeps secondary insight navigation visible on its own pages", () => {
    for (const current of ["capital-flows", "onchain"] as const) {
      const html = renderToStaticMarkup(<PublicNav current={current} />);
      expect(html).toContain('<details open="">');
      expect(html).toContain('<summary class="is-current">More insights');
    }
    expect(renderToStaticMarkup(<PublicNav current="home" />)).not.toContain("<details open");
  });
});
