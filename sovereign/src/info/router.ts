/**
 * MONEYWORLD — the first public door. A secretless, cited window on the money
 * world. Mounted ABOVE the vault session gate (like
 * /api/zerone): it never touches the vault, so it is non-custodial by POSITION,
 * not by promise. Humans and agents hit the same door and get their own shape.
 */

import type { Hono } from "hono";
import { makeFact, factToHtml, MONEYFACT_MEDIA_TYPE, type MoneyFact } from "./money-fact.ts";
import { resolveChain, listChains } from "./chains.ts";
import {
  FX_REFERENCE_DATE_TTL_S,
  fxReferenceIsStale,
  getFxRate,
  listQuotesFrom,
  type FxFact,
} from "./fx.ts";

// Legacy human/machine legibility outside the bounded XENIA Surface resources:
// a browser gets a card; a machine or ?agent caller gets the MoneyFact.
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

  // ── FX: fiat as a peer ──────────────────────────────────────────────────
  // The SAME MoneyFact shape carries an exchange rate — proving the frame holds
  // beyond crypto. A direct ECB rate is asserted; a cross is derived + tested.
  const fxToFact = (r: FxFact): MoneyFact =>
    makeFact({
      subject: `fiat:iso4217/${r.base}`,
      predicate: "fx_rate",
      value: r.valueScaled,
      unit: `fiat:iso4217/${r.quote}`,
      decimals: r.decimals,
      plane: "public",
      method: r.method,
      proof_state: r.proof_state,
      redistribution: "attribution-required",
      sources: [
        { name: "European Central Bank — euro foreign-exchange reference rates", url: r.sourceUrl, fetched_at: r.fetchedAt },
      ],
      observed_at: r.refDate,
      stale_after_s: FX_REFERENCE_DATE_TTL_S,
      recompute: r.recompute,
    });

  // One pair, one cited MoneyFact, two shapes.
  app.get("/v1/fx/:base/:quote", async (c) => {
    const { base, quote } = c.req.param();
    let r;
    try {
      r = await getFxRate(base, quote);
    } catch {
      return c.json(problem(502, "source unreachable", "the ECB reference-rate feed did not answer", ["retry shortly"]), 502);
    }
    if ("error" in r) {
      return c.json(problem(422, "unknown currency", `'${base}' or '${quote}' is not in the ECB reference set`, ["GET /v1/rates/fiat"]), 422);
    }
    if (fxReferenceIsStale(r.refDate)) {
      return c.json(problem(503, "fx reference unavailable", `the ECB ${r.refDate || "undated"} reference observation is too old`, ["retry after the next ECB publication"]), 503);
    }
    const fact = fxToFact(r);
    if (!wantsMachine(c)) return c.html(factToHtml(fact, `${r.quote} per ${r.base}`));
    c.header("Content-Type", MONEYFACT_MEDIA_TYPE);
    return c.body(JSON.stringify(fact, null, 2));
  });

  // The rate matrix from one base — a collection of MoneyFacts (machine-only).
  app.get("/v1/rates/fiat", async (c) => {
    const base = (c.req.query("base") ?? "EUR").toUpperCase();
    let listing;
    try {
      listing = await listQuotesFrom(base);
    } catch {
      return c.json(problem(502, "source unreachable", "the ECB reference-rate feed did not answer", ["retry shortly"]), 502);
    }
    if (fxReferenceIsStale(listing.refDate)) {
      return c.json(problem(503, "fx references unavailable", `the ECB ${listing.refDate || "undated"} reference observations are too old`, ["retry after the next ECB publication"]), 503);
    }
    const facts: MoneyFact[] = [];
    for (const quote of listing.quotes) {
      const r = await getFxRate(base, quote);
      if (!("error" in r)) facts.push(fxToFact(r));
    }
    if (facts.length === 0) {
      return c.json(problem(422, "unknown base currency", `'${base}' is not in the ECB reference set`, ["GET /v1/rates/fiat?base=EUR"]), 422);
    }
    return c.json({ base, ref_date: listing.refDate, count: facts.length, facts });
  });
}
