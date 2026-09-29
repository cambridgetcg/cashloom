import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorldSnapshot } from "../src/world/api.ts";
import type { WorldResponse } from "../src/world/types.ts";
import type { useWorldPreferences } from "../src/world/useWorldPreferences.ts";

function worldFixture() {
  return {
    "@type": "WorldSnapshot",
    schema: "cashloom.world/1",
    generated_at: "2026-09-09T12:00:00.000Z",
    base_currency: "USD",
    status: {
      state: "partial",
      available_sources: 1,
      total_sources: 2,
      stale_count: 1,
      unavailable: ["Energy display rights unresolved", "Research source unavailable"],
    },
    briefing: [{ id: "briefing", title: "Fixture briefing", summary: "A sourced observation, not advice." }],
    policy: [{
      id: "policy-rate",
      title: "Fixture policy rate",
      value: 4,
      unit: "%",
      status: "observed",
      source: {
        id: "ny_fed_reference_rates",
        name: "New York Fed",
        note: "Reference-rate fixture notice: usage terms apply.",
        url: "https://example.org/reference-rates",
        terms_url: "https://example.org/reference-rate-terms",
      },
    }],
    sovereigns: [{ id: "sovereign", title: "Fixture sovereign reference", value: 4.2, unit: "%" }],
    fx: [{ id: "fx-eur", title: "Fixture currency reference", symbol: "EUR", value: 0.9 }],
    crypto: [{ id: "crypto-btc", title: "Fixture crypto reference", symbol: "BTC", value: 100, unit: "USD" }],
    fees: [{ id: "fee", title: "Fixture network fee", value: 2 }],
    energy: [{ id: "energy", title: "Fixture energy rights gap", status: "withheld" }],
    calendar: [{ id: "meeting", title: "Fixture policy meeting", scheduled_at: "2026-09-16", status: "scheduled" }],
    threads: Array.from({ length: 7 }, (_, index) => ({
      id: `thread-${index}`,
      title: index === 0 ? "Fixture policy context" : `Fixture unavailable research ${index}`,
      status: index === 0 ? "derived" : "unavailable",
      observed: [`Sourced observation ${index}`],
      possible_channels: [`Possible channel ${index}`],
      limits: [`Evidence limit ${index}`],
      source_id: "research-source",
      method: "Documented context, not a causal finding",
    })),
    sources: [
      { id: "official-source", name: "Fixture official source", status: "fresh", cadence: "Daily" },
      { id: "research-source", name: "Fixture research source", status: "unavailable", cadence: "Not supplied" },
    ],
  } satisfies WorldResponse;
}

const loadSnapshot = vi.fn<(baseCurrency: string) => PersistedWorldSnapshot | undefined>();
const fetchWorld = vi.fn();
const persistSnapshot = vi.fn();
let preferences: ReturnType<typeof useWorldPreferences>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CASHLOOM_API_BASE", "");
  loadSnapshot.mockReset().mockReturnValue({ snapshot: worldFixture(), receivedAt: Date.now() });
  fetchWorld.mockReset();
  persistSnapshot.mockReset();
  preferences = {
    baseCurrency: "USD",
    watched: [],
    watchOnly: false,
    setBaseCurrency: vi.fn(),
    toggleWatched: vi.fn(),
    toggleWatchOnly: vi.fn(),
  };

  // Recreate the partial mock after resetting modules so each API-base case
  // evaluates the real module-level configuration and endpoint() implementation.
  vi.doMock("../src/world/api.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/world/api.ts")>("../src/world/api.ts");
    return {
      ...actual,
      loadPersistedWorldSnapshot: loadSnapshot,
      fetchWorld,
      persistWorldSnapshot: persistSnapshot,
    };
  });
  vi.doMock("../src/world/useWorldPreferences.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/world/useWorldPreferences.ts")>("../src/world/useWorldPreferences.ts");
    return { ...actual, useWorldPreferences: () => preferences };
  });
});

afterEach(() => {
  // SSR does not run effects: this smoke test must not contact providers or
  // read/write a real browser snapshot or preference store.
  expect(fetchWorld).not.toHaveBeenCalled();
  expect(persistSnapshot).not.toHaveBeenCalled();
  vi.doUnmock("../src/world/api.ts");
  vi.doUnmock("../src/world/useWorldPreferences.ts");
  vi.unstubAllEnvs();
});

async function renderWorld() {
  const { default: World } = await import("../src/world/World.tsx");
  return renderToStaticMarkup(<World />);
}

function textContent(markup: string) {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("World first-use markup", () => {
  it("explains the read-only product and keeps first actions outside the hidden section nav", async () => {
    const html = await renderWorld();
    const hero = html.match(/<header class="world-hero">([\s\S]*?)<\/header>/)?.[1] ?? "";
    expect(textContent(hero)).toContain("Money insights");
    expect(textContent(hero)).toContain("Understand money, with source receipts.");
    expect(hero).toContain("Read-only. No account or wallet required.");
    expect(hero).toContain("Receipt button for its source, timestamps, method, and limits where supplied.");
    expect(hero).toContain('<a href="#today">Read observations</a>');
    expect(hero).toContain('<a href="#coverage">Sources &amp; coverage</a>');
    expect(hero).toContain("Currency changes FX and crypto reference values only.");
    expect(hero).toContain("Star observations, then use Watchlist to filter cards. Saved in this browser; no alerts.");
    expect(hero).toContain('aria-describedby="world-currency-help"');
    expect(hero).toContain('aria-describedby="world-watch-help"');
    expect(hero).toContain("Watchlist");
    expect(loadSnapshot).toHaveBeenCalledWith("USD");
  });

  it("keeps five World sections beside the shared destinations and marks the current page", async () => {
    const html = await renderWorld();
    const nav = html.match(/<header class="cashloom-header"[^>]*>([\s\S]*?)<\/header>/)?.[1] ?? "";
    const sectionLinks = [...nav.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)]
      .map(([, id, label]) => [id, label]);
    expect(sectionLinks).toEqual([
      ["today", "Today"],
      ["rates", "Rates"],
      ["currencies", "Currencies"],
      ["calendar", "Calendar"],
      ["coverage", "Sources"],
    ]);
    expect(nav).toContain('aria-label="CashLoom home"');
    expect(nav).toContain('aria-label="Money insight sections"');
    expect(nav).toContain('href="/onchain"');
    expect(nav).toContain('href="/capital-flows"');
    expect(nav).toContain('href="/atlas"');
    expect(nav).toContain('href="/wallet"');
    expect(nav).toContain('href="/world" aria-current="page"');
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    const footer = html.slice(html.indexOf('<footer class="world-footer">'));
    expect(footer).toContain('<a href="/atlas">How it works</a>');
    expect(html.match(/href="\/atlas"/g)).toHaveLength(2);
  });

  it("links to Capital flows near sovereign coverage without importing its route or fetching", async () => {
    const loadCapital = vi.fn(() => { throw new Error("World must not import Capital flows"); });
    vi.doMock("../src/capital-flows/CapitalFlows.tsx", loadCapital);
    const html = await renderWorld();
    expect(loadCapital).not.toHaveBeenCalled();
    const gateway = html.match(/<section class="world-capital-gateway"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(gateway).toContain('href="/capital-flows"');
    expect(gateway).toContain("not a global money-flow total");
    expect(html.indexOf('id="sovereigns"')).toBeLessThan(html.indexOf(gateway));
    expect(html.indexOf(gateway)).toBeLessThan(html.indexOf('id="currencies"'));
    vi.doUnmock("../src/capital-flows/CapitalFlows.tsx");
  });

  it("offers all eight existing currency lenses", async () => {
    const html = await renderWorld();
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>/g)].map(([, currency]) => currency);
    expect(options).toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY"]);
    expect(html).toContain('<option value="USD" selected="">USD</option>');
  });

  it("keeps every research record and its receipt in a closed disclosure after Calendar", async () => {
    const html = await renderWorld();
    const disclosures = [...html.matchAll(/<details\b([^>]*class="world-research"[^>]*)>([\s\S]*?)<\/details>/g)];
    expect(disclosures).toHaveLength(1);
    const [disclosure, attributes, content] = disclosures[0];
    expect(attributes).toContain('class="world-research"');
    expect(attributes).not.toMatch(/\bopen(?:\s|=|$)/);
    expect(content).toContain('<summary aria-describedby="world-research-help">Policy context &amp; research coverage</summary>');
    expect(html.match(/id="threads"/g)).toHaveLength(1);
    expect(disclosure).not.toContain('id="threads"');
    expect(html).toMatch(/<section[^>]*id="threads"/);
    expect(html.indexOf('id="calendar"')).toBeLessThan(html.indexOf('id="threads"'));
    expect(html.indexOf('id="threads"')).toBeLessThan(html.indexOf(disclosure));
    expect(html.indexOf(disclosure) + disclosure.length).toBeLessThan(html.indexOf('id="coverage"'));
    expect(html.slice(0, html.indexOf(disclosure))).toContain("Research coverage is incomplete.");
    expect(content).toContain("Every thread separates observation, possible channel, and limits.");
    for (const record of worldFixture().threads) {
      expect(content).toContain(record.title);
      expect(content).toContain(record.observed[0]);
      expect(content).toContain(record.possible_channels[0]);
      expect(content).toContain(record.limits[0]);
    }
    expect(content.match(/class="receipt-button"/g)).toHaveLength(7);
    expect(content.match(/world-state--unavailable/g)).toHaveLength(6);
    expect(content).toContain(">Observed</span>");
    expect(content).toContain(">Possible channel</span>");
    expect(content).toContain(">Limits</span>");
  });

  it("preserves all observation sections, partial-state warnings, rights notices and external coverage gaps", async () => {
    const html = await renderWorld();
    const disclosure = html.match(/<details\b[^>]*class="world-research"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? "";
    const outsideDisclosure = html.replace(disclosure, "");
    for (const title of [
      "Fixture briefing", "Fixture policy rate", "Fixture sovereign reference",
      "Fixture currency reference", "Fixture crypto reference", "Fixture network fee",
      "Fixture energy rights gap", "Fixture policy meeting", "Fixture official source", "Fixture research source",
    ]) {
      expect(outsideDisclosure).toContain(title);
    }
    expect(outsideDisclosure).toContain("This is a partial weave");
    expect(outsideDisclosure).toContain("Some sources are stale or unavailable. Each affected observation keeps its own state and receipt.");
    expect(outsideDisclosure).toContain("Saved snapshot · updating");
    expect(outsideDisclosure).toContain("Known gaps");
    expect(outsideDisclosure).toContain("Energy display rights unresolved");
    expect(outsideDisclosure).toContain("Research source unavailable");
    expect(outsideDisclosure).toContain("Brent and WTI benchmark values remain withheld until public display rights are cleared.");
    expect(outsideDisclosure).toContain("Reference-rate fixture notice: usage terms apply.");
    expect(outsideDisclosure).toContain('href="https://example.org/reference-rate-terms"');
    expect(outsideDisclosure).toContain("Coverage &amp; freshness");
  });

  it("retains Watching as a local card filter without filtering research or coverage", async () => {
    preferences.watchOnly = true;
    preferences.watched = ["policy:policy-rate"];
    const html = await renderWorld();
    expect(html).toContain('class="watch-filter is-active"');
    expect(html).toContain("Watching");
    expect(html).toContain('aria-label="Remove Fixture policy rate from local watchlist" aria-pressed="true"');
    expect(html).toContain("No watched currency observations");
    for (const record of worldFixture().threads) expect(html).toContain(record.title);
    expect(html).toContain("Known gaps");
    expect(html).toContain("Research source unavailable");
  });

  it("shows loading honestly while keeping first-use actions and coverage accessible", async () => {
    loadSnapshot.mockReturnValue(undefined);
    const html = await renderWorld();
    expect(html).toContain('class="world-shell" aria-busy="true"');
    expect(html).toContain("Loading USD observations");
    expect(html).toContain('aria-label="Loading today&#x27;s briefing"');
    expect(html).toContain('<a href="#today">Read observations</a>');
    expect(html).toContain('<a href="#coverage">Sources &amp; coverage</a>');
    expect(html).toContain('id="coverage"');
    expect(html).toContain("Not scored");
    expect(html).toContain("Research coverage is incomplete.");
    expect(html).not.toContain("Fixture policy rate");
    expect(html).not.toContain("This is a partial weave");
    expect(html).not.toContain("Saved snapshot");
  });

  it.each([
    ["same-origin", "", ""],
    ["configured", " https://info.example.org/ ", "https://info.example.org"],
  ])("resolves service links with the real endpoint helper in %s mode", async (_mode, configuredBase, expectedBase) => {
    vi.stubEnv("VITE_CASHLOOM_API_BASE", configuredBase);
    const html = await renderWorld();
    const footer = html.slice(html.indexOf('<footer class="world-footer">'));
    expect(footer).toContain(`href="${expectedBase}/v1/data-practices">Privacy &amp; data practices</a>`);
    expect(footer).toContain(`href="${expectedBase}/v1/orientation">Machine orientation</a>`);
    expect(footer).toContain('href="https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929">Source · repository access required</a>');
    expect(footer).toContain('href="https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929#run-the-existing-information-tools-locally">Run insights locally · repository access required</a>');
    if (expectedBase) expect(footer).not.toMatch(/href="\/v1\//);
  });
});
