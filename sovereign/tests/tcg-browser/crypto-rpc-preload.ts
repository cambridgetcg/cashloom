// Only run by the isolated browser rehearsal. This replaces the external RPC
// transport, not the observer, snapshot validation, routes, or database code.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.TCG_BROWSER_ROOT;
if (!root || !existsSync(join(root, ".tcg-browser-fixture")) ||
  realpathSync(process.env.HOME ?? "/") !== realpathSync(join(root, "home")) ||
  realpathSync(process.env.CASHLOOM_DATA_DIR ?? "/") !== realpathSync(join(root, "crypto-data"))) {
  throw new Error("Crypto RPC rehearsal requires isolated synthetic data.");
}
const callsPath = join(root, "crypto-rpc-calls.json");
let calls = 0;
let rejected = 0;
const record = () => writeFileSync(callsPath, JSON.stringify({ calls, rejected }));
record();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["https://base-a.invalid/rpc", "https://base-b.invalid/rpc"].includes(url.href) || init?.method !== "POST") {
    rejected++; record(); throw new Error("Unexpected outgoing request in isolated crypto rehearsal.");
  }
  calls++; record();
  const mode = readFileSync(join(root, "crypto-rpc-mode"), "utf8").trim();
  if (mode === "unavailable") throw new Error("Synthetic provider unavailable.");
  const body = JSON.parse(String(init.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
  let result: unknown;
  const blockNumber = "0x100";
  const blockHash = `0x${"a".repeat(64)}`;
  if (body.method === "eth_chainId") result = "0x2105";
  else if (body.method === "eth_getBlockByNumber" && ["finalized", blockNumber].includes(String(body.params[0]))) {
    result = { number: blockNumber, hash: blockHash, timestamp: "0x6ab90000" };
  } else if (body.method === "eth_getBalance" && body.params[1] === blockNumber) {
    result = `0x${(mode === "conflict" ? 1500000000000000002n : 1500000000000000001n).toString(16)}`;
  } else if (body.method === "eth_call" && body.params[1] === blockNumber) {
    const call = body.params[0] as { to?: string; data?: string };
    if (call.to !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" || !/^0x70a08231[0-9a-f]{64}$/.test(call.data ?? "")) {
      rejected++; record(); throw new Error("Unexpected token read in crypto rehearsal.");
    }
    result = `0x${2500123456n.toString(16).padStart(64, "0")}`;
  } else {
    rejected++; record(); throw new Error("Unexpected RPC method in crypto rehearsal.");
  }
  return Response.json({ jsonrpc: "2.0", id: body.id, result });
}) as typeof fetch;
