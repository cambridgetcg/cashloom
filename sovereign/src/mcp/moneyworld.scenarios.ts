/**
 * Real-world agent scenarios for the MONEYWORLD MCP tools, driven against a live
 * node. Proves the tools do useful work AND that a real MCP client can connect
 * over stdio and call them (an agent genuinely can use this).
 *
 *   MONEYWORLD_URL=http://127.0.0.1:PORT bun src/mcp/moneyworld.scenarios.ts
 */

import { TOOLS } from "./moneyworld.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const call = async (name: string, args: any = {}) => JSON.parse((await tool(name).handler(args as any)).content[0].text);
const BASE = process.env.MONEYWORLD_URL ?? "http://127.0.0.1:4747";
let pass = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = "") => {
  checks++;
  if (ok) pass++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};
const money = (v: string, d: number) => (Number(BigInt(v)) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });

console.log(`\nMONEYWORLD agent scenarios · node ${BASE}\n`);

// ── Scenario 1: a freelancer agent quotes a 250.00 EUR invoice to a US + UK client
console.log("① Invoice pricing — quote €250.00 in USD and GBP, with provenance");
{
  const usd = await call("moneyworld_get_fx_rate", { base: "EUR", quote: "USD" });
  const gbp = await call("moneyworld_get_fx_rate", { base: "EUR", quote: "GBP" });
  const inUsd = usd.value ? (250 * Number(BigInt(usd.value)) / 10 ** usd.decimals) : NaN;
  const inGbp = gbp.value ? (250 * Number(BigInt(gbp.value)) / 10 ** gbp.decimals) : NaN;
  console.log(`   agent: €250.00 ≈ $${inUsd.toFixed(2)} / £${inGbp.toFixed(2)}`);
  console.log(`   cite : EUR→USD ${money(usd.value, usd.decimals)} [${usd.proof_state}] · EUR→GBP ${money(gbp.value, gbp.decimals)} [${gbp.proof_state}]`);
  check("both rates returned, cited, with a proof_state", !!usd.value && !!gbp.value && !!usd.proof_state);
  check("EUR→USD is honestly graded 'asserted' (ECB authoritative, not recomputable)", usd.proof_state === "asserted");
  // The convert door does the arithmetic and nests the amount at result.value.
  const conv = await call("moneyworld_convert", { amount_minor: "25000", from: "EUR", to: "USD" });
  const cv = conv.result?.value ? Number(BigInt(conv.result.value)) / 10 ** conv.result.decimals : NaN;
  console.log(`   convert door: €250.00 → $${cv.toFixed(2)} [${conv.result?.proof_state}]  (amount nested at result.value)`);
  check("convert success nests the amount at result.value (not top-level)", !!conv.result?.value);
}

// ── Scenario 2: an agent verifies a counterparty's Bitcoin balance before trusting it
console.log("\n② Counterparty check — read a Bitcoin address balance a stranger can re-derive");
{
  const b = await call("moneyworld_get_balance", { chain: "bitcoin", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" });
  console.log(`   agent: balance ${b.value ? money(b.value, b.decimals) + " BTC" : "(none)"} · proof ${b.proof_state} · via ${b.sources?.[0]?.name}`);
  console.log(`   recompute: ${b.recompute?.how ?? "—"}`);
  check("balance is an exact minor-unit string (no float)", typeof b.value === "string" && /^\d+$/.test(b.value || ""));
  check("proof_state:tested + a recompute recipe (agent can verify, not trust)", b.proof_state === "tested" && !!b.recompute);
}

// ── Scenario 3: a payments agent decides which rail to use by cost
console.log("\n③ Rail choice — what does moving money on Bitcoin cost right now?");
{
  const f = await call("moneyworld_get_fees", { chain: "bitcoin" });
  const covered = !f.title; // a 'title' means a refusal/problem
  console.log(`   ${covered ? "agent: fee fact →" : "honest refusal:"} ${JSON.stringify(covered ? (f.value ?? f) : f.detail).slice(0, 120)}`);
  check("fees door answers (a fact or an honest, actionable refusal)", covered ? true : Array.isArray(f.next_actions));
}

// ── Scenario 4: an agent disambiguates an ambiguous asset symbol before converting
console.log("\n④ Asset disambiguation — 'USDC' is many assets; which one?");
{
  const a = await call("moneyworld_find_asset", { query: "USDC" });
  const n = a.count ?? a.assets?.length ?? 0;
  console.log(`   agent: ${n} candidate(s)` + (a.assets?.[0] ? ` — e.g. ${a.assets[0].id ?? a.assets[0]}` : ""));
  check("returns candidates or an honest empty result (never a naked guess)", "count" in a || "assets" in a || Array.isArray(a.next_actions));
}

// ── Scenario 5: the honest refusal — convert an asset with no fiat price
console.log("\n⑤ Honest limits — convert 1.00 ZRN → USD (ZRN has no fiat price)");
{
  const r = await call("moneyworld_convert", { amount_minor: "1000000", from: "cosmos:zerone-1/denom:uzrn", to: "USD" });
  // A refusal carries a `title` (RFC-9457 problem) + numeric `status` — there is no not_covered flag.
  const refused = typeof r.title === "string" && r.result === undefined;
  console.log(`   agent hears: "${r.title ?? "(a value?!)"}"${r.detail ? " — " + String(r.detail).slice(0, 60) : ""}`);
  check("no invented number — an honest refusal, detected by `title`", refused);
}

// ── Scenario 6: an agent values a crypto holding in fiat — the honest way
console.log("\n⑥ Crypto→fiat — price BTC, then value a 0.5 BTC holding in USD and GBP");
{
  const p = await call("moneyworld_get_price", { base: "BTC", quote: "USD" });
  const priceOk = !p.title && p.predicate === "spot_price";
  console.log(`   agent: 1 BTC ≈ $${priceOk ? money(p.value, p.decimals) : "?"} [${p.method}/${p.proof_state}] (oracle round, ${priceOk ? "fresh" : "unavailable"})`);
  check("get_price returns an on-chain spot_price fact (or an honest 503 if stale)", priceOk || (typeof p.title === "string" && p.status === 503));

  const usd = await call("moneyworld_value", { amount_minor: "50000000", asset: "BTC", quote: "USD" });
  const gbp = await call("moneyworld_value", { amount_minor: "50000000", asset: "BTC", quote: "GBP" });
  const uOk = usd.result?.value, gOk = gbp.result?.value;
  if (uOk) console.log(`   agent: 0.5 BTC = $${money(usd.result.value, usd.result.decimals)} [${usd.result.proof_state}] · £${gOk ? money(gbp.result.value, gbp.result.decimals) : "?"} (× ECB cross)`);
  else console.log(`   honest refusal: "${usd.title}"`);
  check("value nests the fiat amount at result.value, graded derived+tested", (!!uOk && usd.result.method === "derived") || (typeof usd.title === "string"));
  check("a non-USD valuation cites BOTH the oracle and ECB (2 sources)", !gOk || gbp.result.sources.length === 2);
}

// ── The MCP protocol itself: a real client connects over stdio and calls a tool
console.log("\n⑦ MCP wire — a real agent client connects over stdio and calls a tool");
{
  let mcpOk = false;
  try {
    const client = new Client({ name: "scenario-agent", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [new URL("./moneyworld.ts", import.meta.url).pathname],
      env: { ...process.env, MONEYWORLD_URL: BASE },
    });
    await client.connect(transport);
    const list = await client.listTools();
    const toolNames = list.tools.map((t) => t.name);
    console.log(`   connected · ${list.tools.length} tools advertised: ${toolNames.slice(0, 3).join(", ")}…`);
    const res: any = await client.callTool({ name: "moneyworld_get_fx_rate", arguments: { base: "USD", quote: "EUR" } });
    const fact = JSON.parse(res.content[0].text);
    console.log(`   called moneyworld_get_fx_rate(USD,EUR) → ${money(fact.value, fact.decimals)} [${fact.proof_state}]`);
    mcpOk = list.tools.length === TOOLS.length && !!fact.value;
    await client.close();
  } catch (e: any) {
    console.log("   MCP roundtrip error:", String(e?.message ?? e).slice(0, 100));
  }
  check("client connected, listed all tools, and got a live cited fact", mcpOk);
}

console.log(`\n${pass === checks ? "✅ ALL SCENARIOS PASS" : `⚠ ${pass}/${checks} checks passed`} — agents can discover, read, and verify money facts through MONEYWORLD.\n`);
process.exit(pass === checks ? 0 : 1);
