import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WORLD_BASE_CURRENCIES, WORLD_MEDIA_TYPE } from "../info/world-door.ts";
import { ONCHAIN_MEDIA_TYPE } from "../info/blockchain/model.ts";
import { CAPITAL_FLOWS_MEDIA_TYPE } from "../info/capital-flows/model.ts";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function body(result: ToolResult): any {
  if (!Array.isArray(result.content)) throw new Error("MCP result has no content array");
  const text = result.content.find((item: unknown): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text"
    && "text" in item && typeof item.text === "string");
  if (!text) throw new Error("MCP result has no text content");
  return JSON.parse(text.text);
}

describe("public snapshots through the MCP protocol (offline)", () => {
  let client: Client;
  let server: McpServer;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("MONEYWORLD_URL", "https://moneyworld.test/");
    fetchMock.mockReset().mockRejectedValue(new Error("Unexpected HTTP read in offline test"));
    vi.stubGlobal("fetch", fetchMock);
    const { buildServer } = await import("./moneyworld.ts");
    server = buildServer();
    client = new Client({ name: "cashloom-offline-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("discovers the composite tools with read annotations and the existing World currency contract", async () => {
    const { tools } = await client.listTools();
    for (const name of ["moneyworld_get_world", "moneyworld_get_onchain", "moneyworld_get_capital_flows"]) {
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true, idempotentHint: true, openWorldHint: true,
      });
    }
    expect(tools.find(tool => tool.name === "moneyworld_get_world")?.inputSchema.properties?.base)
      .toMatchObject({ enum: [...WORLD_BASE_CURRENCIES], default: "USD" });
    expect(tools.find(tool => tool.name === "moneyworld_get_capital_flows")?.inputSchema.properties).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // zerone.ai/llms.txt (2026-10-26): "a recorded verdict is not proof that a claim is true".
  it("describes the zerone tools as the chain's record, not as proof", async () => {
    const { tools } = await client.listTools();
    const zerone = tools.filter(tool => tool.name.startsWith("zerone_"));
    expect(zerone.length).toBeGreaterThanOrEqual(5);
    for (const tool of zerone) {
      expect(tool.description).not.toMatch(/quorum|\bproven\b|verified-truth|attested on-chain|'attested' needs/i);
    }
    expect(zerone.find(tool => tool.name === "zerone_get_facts")?.description).toContain("not proof that a claim is true");
  });

  it("uses USD by default and preserves World partial coverage and receipt timestamps", async () => {
    const snapshot = {
      schema: "cashloom.world/1", base_currency: "USD", generated_at: "2026-08-20T16:00:00Z",
      status: { state: "partial", unavailable: [{ id: "energy", retryable: false }] },
      sources: [{ observed_at: "2026-08-19", fetched_at: "2026-08-20T15:59:00Z" }],
    };
    fetchMock.mockResolvedValue(Response.json(snapshot));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await client.callTool({ name: "moneyworld_get_world", arguments: {} });
    expect(body(result)).toEqual(snapshot);
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://moneyworld.test/v1/world?base=USD", expect.objectContaining({
      method: "GET", credentials: "omit", headers: { Accept: `${WORLD_MEDIA_TYPE}, application/json;q=0.9` },
    }));
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it.each(WORLD_BASE_CURRENCIES)("passes the supported %s World lens without inventing conversions", async base => {
    fetchMock.mockResolvedValue(Response.json({ schema: "cashloom.world/1", base_currency: base }));
    const result = await client.callTool({ name: "moneyworld_get_world", arguments: { base } });
    expect(body(result).base_currency).toBe(base);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://moneyworld.test/v1/world?base=${base}`);
  });

  it("rejects an unsupported currency in MCP validation before making an HTTP request", async () => {
    const result = await client.callTool({ name: "moneyworld_get_world", arguments: { base: "USD&refresh=1" } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads Onchain once with a deadline longer than the server snapshot budget and preserves exact metrics", async () => {
    const snapshot = {
      schema: "cashloom.onchain/2", status: { state: "partial" },
      stablecoins: [{ supply: { raw: "9007199254740993123456", decimals: 6 },
        receipt: { observed_at: "2026-08-20T15:58:00Z", reference_block: { number: "23000000" } } }],
    };
    fetchMock.mockResolvedValue(Response.json(snapshot));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await client.callTool({ name: "moneyworld_get_onchain", arguments: {} });
    expect(body(result)).toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://moneyworld.test/v1/onchain", expect.objectContaining({
      method: "GET", credentials: "omit", headers: { Accept: `${ONCHAIN_MEDIA_TYPE}, application/json;q=0.9` },
    }));
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("returns refreshing Capital flows as one read without filling gaps or polling", async () => {
    const snapshot = {
      schema: "cashloom.capital-flows/1", generatedAt: "2026-08-20T16:00:00Z",
      refresh: { state: "refreshing", health: "partial", launchReadiness: "notAssessed" },
      sources: [{ retrievalState: "fallback", nextAttemptAt: "2026-08-20T17:00:00Z" }],
      series: [{ history: [{ status: "observed", value: { raw: "-12345678901234567890", decimals: 2, unitMultiplier: "1000000", currency: "EUR" },
        receipt: { retrievedAt: "2026-08-19T16:00:00Z", publicationAt: null } }, { status: "suppressed", value: null }] }],
    };
    fetchMock.mockResolvedValue(Response.json(snapshot));
    const result = await client.callTool({ name: "moneyworld_get_capital_flows", arguments: {} });
    expect(body(result)).toEqual(snapshot);
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://moneyworld.test/v1/capital-flows", expect.objectContaining({
      method: "GET", credentials: "omit", headers: { Accept: `${CAPITAL_FLOWS_MEDIA_TYPE}, application/json;q=0.9` },
    }));
  });

  it.each([422, 503])("preserves a %s API refusal and distinguishes server failure from a readable refusal", async status => {
    const refusal = { type: "about:blank", title: "Source unavailable", status, detail: "Read the source receipt.", next_actions: ["retry later"] };
    fetchMock.mockResolvedValue(Response.json(refusal, { status }));
    const result = await client.callTool({ name: "moneyworld_get_world", arguments: {} });
    expect(body(result)).toEqual(refusal);
    expect(result.isError === true).toBe(status >= 500);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("flags a successful HTTP response with unreadable JSON as a tool failure", async () => {
    fetchMock.mockResolvedValue(new Response("<html>wrong route</html>", { status: 200 }));
    const result = await client.callTool({ name: "moneyworld_get_onchain", arguments: {} });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ title: "moneyworld door error", status: 200, _transport_error: true });
  });

  it("returns an actionable public INFO recovery command after a timeout without retrying", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
    const result = await client.callTool({ name: "moneyworld_get_capital_flows", arguments: {} });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ title: "moneyworld unreachable", _transport_error: true });
    expect(body(result).next_actions[0]).toContain("CASHLOOM_BIND=127.0.0.1 bun run src/info-server.ts");
    expect(body(result).next_actions.join(" ")).not.toContain("bun start");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
