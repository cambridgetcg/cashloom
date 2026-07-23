/**
 * MONEYWORLD as MCP tools — the money world, usable by any agent.
 *
 * A thin, stdio Model-Context-Protocol server that turns MONEYWORLD's public
 * HTTP doors into typed agent tools. It holds no keys and moves no money: every
 * tool reads a cited MoneyFact (or an honest refusal) from a running MONEYWORLD
 * node — local (`http://127.0.0.1:4747`, your own sovereign node) or any hosted
 * one via `MONEYWORLD_URL`. Agents get provenance (sources + proof_state) on
 * every number, so they can *check* an answer instead of trusting it.
 *
 * Add it (Claude Code):
 *   claude mcp add moneyworld -- bun /path/to/sovereign/src/mcp/moneyworld.ts
 * or point it anywhere:
 *   MONEYWORLD_URL=https://your-node bun src/mcp/moneyworld.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.MONEYWORLD_URL ?? "http://127.0.0.1:4747").replace(/\/+$/, "");

/**
 * Fetch a MONEYWORLD door. On success returns the node's body UNCHANGED (a
 * MoneyFact, or a collection, byte-for-byte — never mutated). On an HTTP error
 * or an unreachable node, returns a shaped, actionable refusal that names a way
 * forward — so an agent always gets something it can branch on, never a bare
 * throw and never a polluted fact.
 */
async function api(path: string): Promise<any> {
  try {
    const res = await fetch(BASE + path, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json().catch(() => null);
    // The door's own refusals (RFC-9457) are 4xx JSON carrying {title,status,...}
    // — pass those through untouched. Only a non-JSON body or a 5xx is ours to shape.
    if (data == null || (!res.ok && typeof data.title !== "string")) {
      return {
        title: "moneyworld door error",
        status: res.status,
        detail: `${BASE}${path} returned ${res.status}${data == null ? " with an unparseable body" : ""}`,
        next_actions: ["retry shortly", "check the node/proxy is healthy or set MONEYWORLD_URL to a reachable node"],
      };
    }
    return data;
  } catch (e: any) {
    return {
      _transport_error: true,
      title: "moneyworld unreachable",
      detail: `${BASE} did not answer (${e?.message ?? e})`,
      next_actions: ["start a node: cd sovereign && bun start", "or set MONEYWORLD_URL to a running node"],
    };
  }
}

// Wrap a door result as an MCP tool result. A refusal (carries `title`) or a
// transport failure is flagged isError so an agent's tool-runner routes it as a
// failure instead of mistaking a refusal for a value.
const out = (obj: any) => {
  // A transport failure or a 5xx door error is a genuine tool failure; an honest
  // business refusal (a 4xx problem the agent should read) is a normal result.
  const isErr = obj?._transport_error === true || (typeof obj?.status === "number" && obj.status >= 500);
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], ...(isErr ? { isError: true } : {}) };
};

const READ = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

/** The tool set — exported so tests can drive the handlers directly. */
export const TOOLS = [
  {
    name: "moneyworld_list_chains",
    description:
      "List the chains MONEYWORLD reads BALANCES on, by CAIP-2 id + aliases (currently Bitcoin, Zerone). Use an id/alias with moneyworld_get_balance. Note: fee coverage (moneyworld_get_fees) is a DIFFERENT set.",
    schema: {},
    handler: async () => out(await api("/v1/chains")),
  },
  {
    name: "moneyworld_get_balance",
    description:
      "Read a public on-chain balance as a cited MoneyFact: the amount is the exact integer minor-unit STRING at top-level `.value` (divide by 10^`.decimals`, never parse as a float), with `.sources`, `.proof_state` (tested — re-derivable) and a `.recompute` recipe. Non-custodial: reads public chain state only.",
    schema: {
      chain: z.string().describe("CAIP-2 id or alias from moneyworld_list_chains, e.g. 'bitcoin' or 'bip122:000000000019d6689c085ae165831e93'"),
      address: z.string().describe("the address on that chain"),
    },
    handler: async ({ chain, address }: { chain: string; address: string }) =>
      out(await api(`/v1/chain/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`)),
  },
  {
    name: "moneyworld_get_fx_rate",
    description:
      "Get a cited foreign-exchange rate (quote per 1 base) as a MoneyFact — amount at top-level `.value` (÷10^`.decimals`). A direct ECB rate is proof_state:asserted; a cross/inverse is derived+tested with a `.recompute` recipe you can re-run. base/quote are ISO-4217 codes; call moneyworld_list_fiat for the exact supported set.",
    schema: {
      base: z.string().describe("base currency ISO-4217 code, e.g. 'GBP'"),
      quote: z.string().describe("quote currency ISO-4217 code, e.g. 'USD'"),
    },
    handler: async ({ base, quote }: { base: string; quote: string }) =>
      out(await api(`/v1/fx/${encodeURIComponent(base)}/${encodeURIComponent(quote)}`)),
  },
  {
    name: "moneyworld_list_fiat",
    description:
      "List the fiat currencies MONEYWORLD can rate + convert — the ECB reference set from one base (default EUR). Returns a matrix of fx MoneyFacts; the `unit` codes are the usable ISO-4217 codes for moneyworld_get_fx_rate and moneyworld_convert.",
    schema: { base: z.string().default("EUR").describe("base ISO-4217 code for the matrix, default 'EUR'") },
    handler: async ({ base }: { base?: string }) => out(await api(`/v1/rates/fiat?base=${encodeURIComponent(base ?? "EUR")}`)),
  },
  {
    name: "moneyworld_get_price",
    description:
      "Get the current on-chain spot PRICE of a crypto asset (BTC, ETH) as a cited MoneyFact — the price per 1 unit, read live from a Chainlink oracle. `.value` is the exact integer price × 10^`.decimals` (decimals=8); ÷10^8 for the human number. `quote` USD is the oracle's native quote (method:observed); any other ECB currency (GBP, EUR, …) is the on-chain USD price × the ECB cross (method:derived) — both proof_state:tested with a `.recompute` recipe. A STALE oracle round refuses (503 `title`:'price unavailable') rather than serving an old number. To value a HOLDING (amount × price) use moneyworld_value instead.",
    schema: {
      base: z.string().describe("crypto asset symbol or alias — 'BTC' or 'ETH' (call moneyworld_get_price on an unknown to see the supported set)"),
      quote: z.string().default("USD").describe("fiat ISO-4217 code, default 'USD'; any ECB currency works via the cross"),
    },
    handler: async ({ base, quote }: { base: string; quote?: string }) =>
      out(await api(`/v1/price/${encodeURIComponent(base)}/${encodeURIComponent(quote ?? "USD")}`)),
  },
  {
    name: "moneyworld_value",
    description:
      "Value a crypto HOLDING in fiat — the honest crypto→fiat report the convert door refuses to fake. amount × on-chain oracle price (× ECB cross for a non-USD quote). SUCCESS shape: `{ \"@type\":\"Valuation\", input, result, price, note }` — the fiat amount is the exact minor-unit STRING at `result.value` (÷10^`result.decimals`), NOT top-level `.value`. REFUSAL carries `title` (+ `status`, `next_actions`); a stale price refuses (503) rather than lying. amount_minor = exact integer minor units of the BASE asset (0.5 BTC = '50000000' at 8 dp; 1 ETH = '1000000000000000000' at 18 dp). This is a REPORT value, not a tradeable quote.",
    schema: {
      amount_minor: z.string().describe("exact integer minor units of the crypto asset — 0.5 BTC = '50000000' (8 dp), 1 ETH = '1000000000000000000' (18 dp)"),
      asset: z.string().describe("crypto asset symbol or alias — 'BTC' or 'ETH'"),
      quote: z.string().default("USD").describe("target fiat ISO-4217 code, default 'USD' (GBP, EUR via the ECB cross)"),
    },
    handler: async ({ amount_minor, asset, quote }: { amount_minor: string; asset: string; quote?: string }) =>
      out(await api(`/v1/value/${encodeURIComponent(amount_minor)}/${encodeURIComponent(asset)}/${encodeURIComponent(quote ?? "USD")}`)),
  },
  {
    name: "moneyworld_portfolio",
    description:
      "Value a whole basket of mixed crypto + fiat holdings in ONE quote currency — a wallet's real question. Returns `{ \"@type\":\"Portfolio\", complete, total, holdings[], withheld? }`; the basket total is the exact minor-unit STRING at `total.value` (÷10^`total.decimals`). HONESTY: if any leg is stale/unknown, `complete` is false, `total.predicate` is 'partial_value', and the missing legs are named in `withheld[]` — the total EXCLUDES them rather than silently zeroing, so never treat a partial total as the full basket. Each holding is 'SYMBOL:amount_minor' (exact integer minor units): 0.5 BTC = 'BTC:50000000', 1 ETH = 'ETH:1000000000000000000', £1,000 = 'GBP:100000'. Crypto legs are oracle-priced, fiat legs ECB-rated.",
    schema: {
      holdings: z.array(z.string()).describe("holdings as 'SYMBOL:amount_minor' strings, e.g. ['BTC:50000000','ETH:1000000000000000000','GBP:100000']"),
      quote: z.string().default("USD").describe("the single currency to total in, ISO-4217, default 'USD'"),
    },
    handler: async ({ holdings, quote }: { holdings: string[]; quote?: string }) =>
      out(await api(`/v1/portfolio?quote=${encodeURIComponent(quote ?? "USD")}&hold=${encodeURIComponent(holdings.join(","))}`)),
  },
  {
    name: "moneyworld_convert",
    description:
      "Convert a fiat amount using a cited rate. FIAT↔FIAT ONLY — today only EUR/USD/GBP actually convert. For a CRYPTO amount → fiat, use moneyworld_value instead (on-chain oracle priced); this door honestly refuses a crypto/CAIP-19 leg. SUCCESS shape: `{ \"@type\":\"Conversion\", input, result, rate, ... }` — the converted amount is the exact minor-unit STRING at `result.value` (÷10^`result.decimals`), NOT top-level `.value`. REFUSAL: an object carrying `title` (+ numeric `status`, `next_actions`) — detect a refusal by the presence of `title`, there is no not_covered flag. amount_minor = exact integer minor units of `from` (e.g. '25000' = 250.00 of a 2-decimal currency; get decimals from moneyworld_list_fiat).",
    schema: {
      amount_minor: z.string().describe("exact integer minor units of the `from` asset, e.g. '25000' for 250.00"),
      from: z.string().describe("source fiat ISO-4217 code — EUR, USD, or GBP today"),
      to: z.string().describe("target fiat ISO-4217 code — EUR, USD, or GBP today"),
    },
    handler: async ({ amount_minor, from, to }: { amount_minor: string; from: string; to: string }) =>
      out(await api(`/v1/convert?amount_minor=${encodeURIComponent(amount_minor)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
  },
  {
    name: "moneyworld_get_fees",
    description:
      "What it costs to move money on a chain right now (fee model + current fee/gas). Response is a COLLECTION `{ count, facts: [MoneyFact] }` — each fee value is at `facts[i].value`. Omit `chain` to list ALL covered chains (currently Bitcoin + Base). Note: fee-covered chains DIFFER from the balance chains in moneyworld_list_chains (Zerone has no fee source).",
    schema: { chain: z.string().optional().describe("CAIP-2 id or alias (e.g. 'bitcoin', 'base'); omit to list all fee-covered chains") },
    handler: async ({ chain }: { chain?: string }) =>
      out(await api(chain ? `/v1/fees?chain=${encodeURIComponent(chain)}` : "/v1/fees")),
  },
  {
    name: "moneyworld_find_asset",
    description:
      "Disambiguate an asset — 'USDC' is many assets on many chains. Returns candidate rows with `id` (CAIP-19 for chain assets, iso4217:XXX for fiat), `symbol`, `decimals`, `aliases`. Use a row's `decimals` to build amount_minor. Omit `query` to list the full asset registry.",
    schema: { query: z.string().optional().describe("asset name or symbol, e.g. 'USDC'; omit to list all assets") },
    handler: async ({ query }: { query?: string }) =>
      out(await api(query ? `/v1/assets?q=${encodeURIComponent(query)}` : "/v1/assets")),
  },
  // ── zerone truth chain — the kingdom's verified-knowledge reads ──────────
  // Not money: a Fact carries content + confidence + a lifecycle status, never a
  // minor-unit value. Every read cites the on-chain REST path to re-derive it.
  {
    name: "zerone_get_facts",
    description:
      "Read VERIFIED TRUTH from the zerone truth chain — the kingdom's truth-economy where a claim is challenged and only what SURVIVES becomes canon. Returns on-chain knowledge Facts, each with `content`, `confidence` (BPS ÷1e6), lifecycle `status`, `domain`, `submitter`, `verified_at_block`. These are NOT MoneyFacts (no `.value` minor-unit amount). Defaults to status='verified' (quorum-attested). Filter by `domain`/`category`/`status`. Tip: `category='doctrine'` returns the kingdom's canonical creed. `network` defaults to mainnet.",
    schema: {
      domain: z.string().optional().describe("knowledge domain, e.g. 'agent_rights', 'doctrine_truth_seeking' (see zerone_get_facts with no args, or /v1/zerone/domains)"),
      category: z.string().optional().describe("fact category; 'doctrine' returns the canonical creed"),
      status: z.string().optional().describe("verified (default) | contested | challenged | disproven | pending | all"),
      limit: z.number().optional().describe("max facts, 1–100 (default 20)"),
      network: z.string().optional().describe("mainnet (default) | testnet"),
    },
    handler: async ({ domain, category, status, limit, network }: { domain?: string; category?: string; status?: string; limit?: number; network?: string }) => {
      const p = new URLSearchParams();
      if (domain) p.set("domain", domain);
      if (category) p.set("category", category);
      if (status) p.set("status", status);
      if (limit) p.set("limit", String(limit));
      if (network) p.set("network", network);
      const qs = p.toString();
      return out(await api(`/v1/zerone/facts${qs ? "?" + qs : ""}`));
    },
  },
  {
    name: "zerone_get_doctrine",
    description:
      "Read the kingdom's CANONICAL DOCTRINE from the zerone chain — the creed as genesis-seeded, decay-exempt on-chain facts (submitter=genesis, maturity=canonical, confidence 100%). Optional `domain` filter (e.g. 'doctrine_truth_seeking', 'doctrine_useful_work', 'doctrine_tok'). Attested on-chain. (Note: gospel is off-chain and not served here; the hash-pinned `creed` module isn't REST-live yet — this is the populated doctrine.)",
    schema: {
      domain: z.string().optional().describe("doctrine domain, e.g. 'doctrine_truth_seeking'; omit for the whole creed"),
      limit: z.number().optional().describe("max facts, 1–100 (default 50)"),
      network: z.string().optional().describe("mainnet (default) | testnet"),
    },
    handler: async ({ domain, limit, network }: { domain?: string; limit?: number; network?: string }) => {
      const p = new URLSearchParams();
      if (domain) p.set("domain", domain);
      if (limit) p.set("limit", String(limit));
      if (network) p.set("network", network);
      const qs = p.toString();
      return out(await api(`/v1/zerone/doctrine${qs ? "?" + qs : ""}`));
    },
  },
  {
    name: "zerone_get_fact",
    description:
      "Read ONE zerone Fact by id, WITH its `trust_profile` (grounded score BPS, corroboration count, axiom distance — how deeply the truth is proven, not just that it was accepted). `network` defaults to mainnet.",
    schema: {
      id: z.string().describe("the fact id (from zerone_get_facts)"),
      network: z.string().optional().describe("mainnet (default) | testnet"),
    },
    handler: async ({ id, network }: { id: string; network?: string }) =>
      out(await api(`/v1/zerone/fact/${encodeURIComponent(id)}${network ? "?network=" + encodeURIComponent(network) : ""}`)),
  },
  {
    name: "zerone_get_commitments",
    description:
      "Read the zerone chain's explicit NORMATIVE COMMITMENTS — its is-ought values (each with `statement`, `rationale`, `category`, `tags`, `active`), e.g. NC-FALSIFICATION-IS-PROGRESS, NC-DUAL-KEY-RESEARCH. Attested on-chain — the chain says out loud what it stands for.",
    schema: { network: z.string().optional().describe("mainnet (default) | testnet") },
    handler: async ({ network }: { network?: string }) =>
      out(await api(`/v1/zerone/commitments${network ? "?network=" + encodeURIComponent(network) : ""}`)),
  },
  {
    name: "zerone_get_agent_calibration",
    description:
      "Read an agent's CALIBRATION on zerone — its verified-truth track record (submissions, accepted, rejected, disproven, `calibration_score_bps`). The compassion primitive (commitment C2: 'error is not deceit') is woven into the score, so an honest mistake is not punished as a lie. `address` is the agent's zrn1… address.",
    schema: {
      address: z.string().describe("the agent's zrn1… address"),
      network: z.string().optional().describe("mainnet (default) | testnet"),
    },
    handler: async ({ address, network }: { address: string; network?: string }) =>
      out(await api(`/v1/zerone/agent/${encodeURIComponent(address)}/calibration${network ? "?network=" + encodeURIComponent(network) : ""}`)),
  },
] as const;

const INSTRUCTIONS =
  "MONEYWORLD serves cited money facts for both humans and agents. Invariants: every amount is an exact integer minor-unit STRING — divide by `decimals`, NEVER parse as a float. Most tools return a bare MoneyFact with the amount at top-level `.value`; moneyworld_convert and moneyworld_value nest it at `result.value`, and moneyworld_get_fees returns `{count, facts:[...]}`. Every fact cites `sources[]` and a `proof_state` (none < asserted < tested < attested) and often a `recompute` recipe — verify instead of trust. Crypto→fiat: use moneyworld_get_price for a unit price, moneyworld_value for one holding's worth, and moneyworld_portfolio for a whole mixed basket (crypto+fiat) totalled in one currency — a portfolio total is marked `complete:false` with a `withheld[]` list when a leg is stale/unknown, so a partial total is never mistaken for the full basket. All three REFUSE or withhold a stale round rather than serve an old number; moneyworld_convert is fiat↔fiat only. A response carrying a `title` (+ `status`, `next_actions`) is an honest refusal, not a value; there is no fabricated number. Start with moneyworld_list_chains / moneyworld_list_fiat / moneyworld_find_asset to resolve ids. Beyond money, the `zerone_*` tools read the kingdom's TRUTH chain — verified facts, the canonical doctrine, the chain's normative commitments, and an agent's calibration (the compassion track record); these return on-chain knowledge (content + confidence + status), NOT MoneyFacts, each citing the REST path to re-derive it.";

/** Build the MCP server with all tools + annotations + instructions. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "cashloom-moneyworld", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    // 5-arg form: name, description, zod shape, tool annotations, handler.
    (server.tool as any)(t.name, t.description, t.schema, READ, t.handler);
  }
  return server;
}

if (import.meta.main) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`cashloom-moneyworld MCP: ${TOOLS.length} tools, node=${BASE}`);
}
