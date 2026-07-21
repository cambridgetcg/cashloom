/**
 * MONEYWORLD — the first public door. A secretless, cited, Xenia-negotiated
 * window on the money world. Mounted ABOVE the vault session gate (like
 * /api/zerone): it never touches the vault, so it is non-custodial by POSITION,
 * not by promise. Humans and agents hit the same door and get their own shape.
 */

import type { Hono } from "hono";
import { makeFact, factToHtml, MONEYFACT_MEDIA_TYPE } from "./money-fact.ts";
import { resolveChain, listChains } from "./chains.ts";

// Xenia legibility: a human browser (Accept: text/html) gets the card; a
// machine (application/json, a MoneyFact media type, or ?agent) gets the fact.
function wantsMachine(c: { req: { header(k: string): string | undefined; query(k: string): string | undefined } }): boolean {
  if (c.req.query("agent") !== undefined) return true;
  const a = c.req.header("Accept") ?? "";
  if (a.includes("text/html")) return false; // an explicit browser
  return true; // JSON, the moneyfact type, */*, or no Accept → serve the machine shape
}

// RFC-9457-shaped refusal that always carries a way forward (Xenia: every
// recoverable refusal names next_actions; nothing is a bare status code).
const problem = (status: number, title: string, detail: string, next?: string[]) => ({
  type: "about:blank",
  title,
  status,
  detail,
  ...(next ? { next_actions: next } : {}),
});

export function mountMoneyworld(app: Hono) {
  // Machine discovery — findable and nameable by machines alone.
  app.get("/.well-known/agent.json", (c) =>
    c.json({
      name: "cashloom · moneyworld",
      what: "a public, cited, non-custodial window on the money world — for humans and agents alike",
      rights_baseline: "xenia.rights/0.1 · https://github.com/cambridgetcg/xenia",
      doors: {
        chains: "/v1/chains",
        chain_balance: "/v1/chain/{caip2}/{address}",
      },
      formats: { moneyfact: MONEYFACT_MEDIA_TYPE },
      terms: {
        read_without_registration: true,
        collects: "nothing",
        custody: "none — reads public chain state only, never holds or moves money",
        pricing:
          "current-value reads are free; safety signals are free forever; a failed answer is never charged",
        provenance: "every fact cites its sources and its proof_state — no naked numbers",
      },
    }),
  );

  // The CAIP-2 registry — proof that chain-agnosticism is a table lookup.
  app.get("/v1/chains", (c) =>
    c.json({
      chains: listChains(),
      note: "a chain is a table row — Ethereum would be one more entry, not a special case",
      identity: "CAIP-2 chain ids + CAIP-19 asset ids; fiat is a peer, no chain privileged",
    }),
  );

  // The keystone door: one balance, one cited MoneyFact, two shapes.
  app.get("/v1/chain/:caip2/:address", async (c) => {
    const { caip2, address } = c.req.param();
    const chain = resolveChain(caip2);
    if (!chain) {
      return c.json(problem(404, "unknown chain", `no source registered for '${caip2}'`, ["GET /v1/chains"]), 404);
    }
    if (!chain.validate(address)) {
      return c.json(
        problem(422, "invalid address", `'${address}' is not a valid ${chain.label} address`),
        422,
      );
    }

    let r;
    try {
      r = await chain.read(address);
    } catch {
      // A source outage is not the guest's fault — refuse cleanly, name the retry.
      return c.json(
        problem(502, "source unreachable", `${chain.label} did not answer in time`, [
          "retry shortly",
          "GET /v1/chains for source status",
        ]),
        502,
      );
    }

    const fact = makeFact({
      subject: `${chain.caip2}:${address}`, // CAIP-10
      predicate: "balance",
      value: r.valueMinor,
      unit: r.unit,
      decimals: r.decimals,
      plane: "public",
      method: r.method,
      proof_state: r.proof_state,
      redistribution: r.redistribution,
      sources: r.sources,
      observed_at: new Date().toISOString(),
      stale_after_s: r.stale_after_s,
      ...(r.recompute ? { recompute: r.recompute } : {}),
    });

    if (!wantsMachine(c)) return c.html(factToHtml(fact, r.symbol));
    c.header("Content-Type", MONEYFACT_MEDIA_TYPE);
    return c.body(JSON.stringify(fact, null, 2));
  });
}
