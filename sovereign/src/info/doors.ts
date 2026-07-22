/**
 * MONEYWORLD doors II — fees, assets, convert, guide. Same covenant as
 * router.ts: mounted above the vault gate, secretless, every fact cited, every
 * refusal teaches. Dependencies are injectable so tests never touch a network.
 */

import type { Hono } from "hono";
import { makeFact, MONEYFACT_MEDIA_TYPE } from "./money-fact.ts";
import { getFxRate } from "./fx.ts";
import { readFees } from "./fees.ts";
import { ASSETS, resolveAsset, searchAssets } from "./assets.ts";
import { applyRate } from "../utils/minor-units";

// Mirrors router.ts's refusal shape (kept private there; six lines beat a hot-file export).
const problem = (status: number, title: string, detail: string, next?: string[]) => ({
  type: "about:blank",
  title,
  status,
  detail,
  ...(next ? { next_actions: next } : {}),
});

const INTEGER_STRING = /^-?\d+$/;

export interface InfoDoorDeps {
  fxRate: typeof getFxRate;
  fees: typeof readFees;
}

export function mountInfoDoors(app: Hono, overrides: Partial<InfoDoorDeps> = {}) {
  const deps: InfoDoorDeps = { fxRate: getFxRate, fees: readFees, ...overrides };

  // ── fees: what does moving money cost right now ─────────────────────────
  app.get("/v1/fees", async (c) => {
    const chain = c.req.query("chain");
    const r = await deps.fees(chain);
    if (r.unknown) {
      return c.json(
        problem(404, "unknown chain", `no fee source registered for '${r.unknown}'`, ["GET /v1/chains"]),
        404,
      );
    }
    if (r.facts.length === 0) {
      return c.json(
        problem(502, "sources unreachable", "no fee source answered in time", ["retry shortly"]),
        502,
      );
    }
    // Partial truth is served AS partial — failed sources are named, not hidden.
    return c.json({
      count: r.facts.length,
      facts: r.facts,
      ...(r.failed.length ? { failed: r.failed, note: "the listed sources did not answer; their absence is disclosed, not papered over" } : {}),
    });
  });

  // ── assets: the disambiguation door ("USDC" is many assets) ─────────────
  app.get("/v1/assets", (c) => {
    const q = c.req.query("q");
    if (q !== undefined) {
      const hits = searchAssets(q);
      return c.json({ query: q, count: hits.length, assets: hits });
    }
    return c.json({
      count: ASSETS.length,
      assets: ASSETS,
      identity: "canonical ids: CAIP-19 for chain assets, iso4217: for fiat — fiat is a peer",
      note: "an asset is a table row; the id is the truth, the symbol is a nickname",
    });
  });

  app.get("/v1/assets/:id", (c) => {
    const row = resolveAsset(c.req.param("id"));
    if (!row) {
      return c.json(
        problem(404, "unknown asset", `nothing answers to '${c.req.param("id")}'`, [
          "GET /v1/assets?q={name} to search",
          "GET /v1/assets for the full registry",
        ]),
        404,
      );
    }
    return c.json(row);
  });

  // ── convert: exact arithmetic that shows its work ───────────────────────
  // Fiat↔fiat today (the ECB leg exists); crypto conversion waits for an
  // honest price source — refusing loudly beats converting on a rumor.
  app.get("/v1/convert", async (c) => {
    const amountMinor = c.req.query("amount_minor");
    const fromQ = c.req.query("from");
    const toQ = c.req.query("to");
    const rounding = c.req.query("rounding") ?? "half_even";
    if (!amountMinor || !fromQ || !toQ) {
      return c.json(
        problem(400, "missing parameter", "convert needs amount_minor, from, and to", [
          "GET /v1/convert?amount_minor=10000&from=GBP&to=USD",
        ]),
        400,
      );
    }
    if (!INTEGER_STRING.test(amountMinor)) {
      return c.json(
        problem(422, "invalid amount", `'${amountMinor}' is not an integer minor-unit string — "100.50" GBP is amount_minor=10050`, [
          "GET /v1/assets/{id} for an asset's decimals",
        ]),
        422,
      );
    }
    if (rounding !== "half_even") {
      return c.json(
        problem(422, "unsupported rounding", `'${rounding}' is not offered; supported: half_even (banker's rounding)`),
        422,
      );
    }
    const from = resolveAsset(fromQ);
    const to = resolveAsset(toQ);
    if (!from || !to) {
      return c.json(
        problem(422, "unknown asset", `'${!from ? fromQ : toQ}' is not in the registry`, ["GET /v1/assets"]),
        422,
      );
    }
    const fiat = (id: string) => id.startsWith("iso4217:");
    if (!fiat(from.id) || !fiat(to.id)) {
      return c.json(
        problem(
          422,
          "conversion not yet served",
          "only fiat↔fiat conversion is offered today; crypto pricing has no honest source here yet, and converting on a rumor is worse than refusing",
          ["GET /v1/rates/fiat for what exists", "GET /v1/assets for the registry"],
        ),
        422,
      );
    }
    let r;
    try {
      r = await deps.fxRate(from.symbol, to.symbol);
    } catch {
      return c.json(problem(502, "source unreachable", "the ECB reference-rate feed did not answer", ["retry shortly"]), 502);
    }
    if ("error" in r) {
      return c.json(
        problem(422, "unknown currency", `'${from.symbol}' or '${to.symbol}' is not in the ECB reference set`, ["GET /v1/rates/fiat"]),
        422,
      );
    }
    const resultMinor = applyRate(amountMinor, from.decimals, r.valueScaled, r.decimals, to.decimals);
    const fact = makeFact({
      subject: from.id,
      predicate: "conversion",
      value: resultMinor,
      unit: to.id,
      decimals: to.decimals,
      plane: "public",
      method: "derived",
      proof_state: "tested",
      redistribution: "public-domain",
      sources: [
        { name: "European Central Bank — euro foreign-exchange reference rates", url: r.sourceUrl, fetched_at: new Date().toISOString() },
      ],
      observed_at: new Date().toISOString(),
      stale_after_s: 3600,
      recompute: {
        how: `amount_minor × rate × 10^(${to.decimals}−${from.decimals}−${r.decimals}), BigInt, final digit half-even; rate: ${r.recompute.how}`,
      },
    });
    c.header("Content-Type", MONEYFACT_MEDIA_TYPE);
    return c.body(
      JSON.stringify(
        {
          "@type": "Conversion",
          input: { amount_minor: amountMinor, asset: from.id, decimals: from.decimals },
          result: fact,
          rate: { value_scaled: r.valueScaled, decimals: r.decimals, method: r.method, recompute: r.recompute },
          rounding: "half_even",
          note: "reference-rate arithmetic, not a tradeable quote — the recompute recipe reproduces every digit",
        },
        null,
        2,
      ),
    );
  });

  // ── guide: the hospitality door — what a stranger receives, in writing ──
  app.get("/v1/guide", (c) =>
    c.json({
      "@type": "Guide",
      what: "MONEYWORLD — a public, cited, non-custodial window on the money world",
      the_stranger_receives: {
        everything_current: "all doors, full freshness, no registration, no key, no CAPTCHA",
        provenance: "every fact carries sources, method, proof_state, redistribution — no naked numbers",
        refusals_that_teach: "errors are RFC-9457 problems with next_actions; a dead end names the way forward",
      },
      doors: {
        chains: "/v1/chains",
        chain_balance: "/v1/chain/{caip2}/{address}",
        fx_rate: "/v1/fx/{base}/{quote}",
        fx_matrix: "/v1/rates/fiat?base={ccy}",
        fees: "/v1/fees?chain={caip2}",
        assets: "/v1/assets?q={name}",
        convert: "/v1/convert?amount_minor={int}&from={asset}&to={asset}",
      },
      promises_not_to: [
        "no tracking, fingerprinting, or dossiers — the anonymous floor is a right",
        "no sale of caller data; nothing is collected to sell",
        "no delayed-data upsell — freshness is never a paid feature",
        "no fake urgency, no retry pressure, no dark patterns in refusals",
        "no naked numbers — a fact that cannot cite itself is not served",
      ],
      not_covered: [
        "crypto spot prices (no honest source wired yet — refusing beats rumoring)",
        "commodities benchmarks (licensing unresolved; tokenized proxies would mislead)",
        "equities and derivatives (structurally out — display licensing is a minefield)",
        "history beyond the current observation (snapshots are planned, not present)",
      ],
      rights: {
        baseline: "xenia.rights/0.1",
        adopted_at: "/RIGHTS.md in the repo — pinned release, vendored byte mirror, digest-tested",
        upstream: "https://github.com/cambridgetcg/xenia",
      },
      sources_ledger: [
        { name: "esplora (Bitcoin)", keyless: true, license: "public chain data" },
        { name: "zerone cosmos REST", keyless: true, license: "public chain data (kingdom's own truth chain)" },
        { name: "Base public RPC", keyless: true, license: "public chain data" },
        { name: "European Central Bank reference rates", keyless: true, license: "free reuse with acknowledgment — named on every fact" },
      ],
    }),
  );
}
