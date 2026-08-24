import { describe, expect, test } from "bun:test";
import { createErc4337Builder } from "./erc4337-builder.ts";
import { createErc4337Bundler } from "./erc4337-bundler.ts";
import { erc4337TestEntryPoint as entry, erc4337TestRequest as request } from "./erc4337-builder.test.ts";

const prepared = () => createErc4337Builder({ entry_points: [entry] }).prepare(request());
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const happyFetch = (hash: string) => async (_url: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("error");
  const body = JSON.parse(String(init?.body)) as { method: string };
  if (body.method === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: "0x2105" });
  if (body.method === "eth_supportedEntryPoints") return json({ jsonrpc: "2.0", id: 1, result: [entry.address] });
  if (body.method === "eth_getCode") return json({ jsonrpc: "2.0", id: 1, result: "0x6000" });
  return json({ jsonrpc: "2.0", id: 1, result: hash });
};

describe("ERC-4337 bundler transport", () => {
  test("uses one fixed HTTPS endpoint and calls a hash-matching Base v0.7 bundler response transport-only", async () => {
    const op = prepared(); const bundler = createErc4337Bundler({ endpoint: "https://bundler.example/rpc", fetch: happyFetch(op.user_operation_hash) });
    expect(await bundler.submit(op)).toEqual({ state: "accepted_transport", user_operation_hash: op.user_operation_hash, transport: "bundler" });
    await expect(bundler.submit(op)).rejects.toThrow("one attempt");
    expect(() => createErc4337Bundler({ endpoint: "http://bundler.example", fetch: happyFetch(op.user_operation_hash) })).toThrow();
  });
  test("does not trust provider hash, redirect-shaped or oversized responses", async () => {
    const op = prepared();
    const mismatch = createErc4337Bundler({ endpoint: "https://bundler.example", fetch: happyFetch("0x" + "0".repeat(64)) });
    expect(await mismatch.submit(op)).toEqual({ state: "ambiguous", code: "malformed_response", transport: "bundler" });
    const oversize = createErc4337Bundler({ endpoint: "https://bundler.example", fetch: async () => json({ jsonrpc: "2.0", id: 1, result: "0x2105" }, 200, { "content-length": "99999999" }) });
    expect(await oversize.submit(prepared())).toEqual({ state: "ambiguous", code: "malformed_response", transport: "bundler" });
    const rejected = createErc4337Bundler({ endpoint: "https://bundler.example", fetch: async () => json({ jsonrpc: "2.0", id: 1, error: { message: "secret provider detail" } }) });
    expect(await rejected.submit(prepared())).toEqual({ state: "refused", code: "bundler_rejected", transport: "bundler" });
  });
  test("sanitizes secret-bearing provider failures and deadline into ambiguous, never inclusion", async () => {
    const op = prepared();
    const secret = "https://bundler.example/?access_token=leak";
    const failing = createErc4337Bundler({ endpoint: "https://bundler.example", fetch: async () => { throw new Error(secret); } });
    const result = await failing.submit(op);
    expect(result).toEqual({ state: "ambiguous", code: "network_unavailable", transport: "bundler" });
    expect(JSON.stringify(result)).not.toContain("leak");
    const timeout = createErc4337Bundler({ endpoint: "https://bundler.example", deadline_ms: 1, fetch: async () => new Promise<Response>(() => undefined) });
    expect(await timeout.submit(prepared())).toEqual({ state: "ambiguous", code: "deadline_exceeded", transport: "bundler" });
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = createErc4337Bundler({ endpoint: "https://bundler.example", fetch: happyFetch(op.user_operation_hash) });
    expect(await cancelled.submit(prepared(), cancel.signal)).toEqual({ state: "ambiguous", code: "cancelled", transport: "bundler" });
  });
});
