/** CashLoom INFO node — the hosted MONEYWORLD door. One process, zero custody.
 *
 *  This entrypoint's module graph NEVER imports the vault, the ledger db, or
 *  any sender — "no money code path reachable" is true by CONSTRUCTION, not by
 *  flag. What mounts: the money-world doors, the zerone front, the rights the
 *  doors stand on, and an honest problem+json 404 (no SPA catch-all — the trap
 *  that sank other kingdoms' agent doors cannot exist here because there is no
 *  SPA). The hosted instance is one reference copy of the open-source node;
 *  anyone's own node serves the same doors on 127.0.0.1.
 */

import { Hono } from "hono";
import {
  getAllStatus,
  getAddressBalance,
  getParticipationGuide,
  isZrnAddress,
  ZERONE_NETWORKS,
} from "./zerone.ts";
import { mountMoneyworld } from "./info/router.ts";
import { mountInfoDoors } from "./info/doors.ts";
import { readFileSync } from "node:fs";

const app = new Hono();

const PORT = Number(process.env.CASHLOOM_PORT ?? 4747);
// The hosted door binds wide on purpose — it holds nothing and collects nothing.
const HOSTNAME = process.env.CASHLOOM_BIND ?? "0.0.0.0";

app.get("/api/meta", (c) =>
  c.json({
    name: "cashloom-info",
    mode: "info", // the hosted MONEYWORLD door — no vault, no ledger, no senders in this process
    version: "0.1.0",
    self_run: "this is one reference copy of an open-source node — github.com/cambridgetcg/cashloom",
    capabilities: "/v1/capabilities",
    payment_authority: "none",
    moves_money: false,
  })
);

/* --------------------------- zerone front (public) ------------------------ */
app.get("/api/zerone", (c) =>
  c.json({ service: "cashloom — the front of zerone", ...getParticipationGuide() })
);
app.get("/api/zerone/guide", (c) => c.json(getParticipationGuide()));
app.get("/api/zerone/status", async (c) => c.json(await getAllStatus()));
app.get("/api/zerone/balance/:address", async (c) => {
  const address = c.req.param("address");
  if (!isZrnAddress(address)) {
    return c.json({ error: "bad_address", message: "address must be a zrn1... bech32 address" }, 400);
  }
  const net = c.req.query("network") === "testnet" ? ZERONE_NETWORKS.testnet : ZERONE_NETWORKS.mainnet;
  return c.json(await getAddressBalance(address, net));
});

/* ------------------------- moneyworld (the point) ------------------------- */
mountMoneyworld(app);
mountInfoDoors(app);

/* ------------------------------- the rights ------------------------------- */
const rightsMd = readFileSync(new URL("../../RIGHTS.md", import.meta.url), "utf-8");
app.get("/RIGHTS.md", (c) => c.text(rightsMd, 200, { "Content-Type": "text/markdown; charset=utf-8" }));

// XENIA Covenant adoption record — a DRAFT, honestly: it proposes host duties
// and shows its own gaps; it is never self-activated (activation is a dated,
// speaker-bound ceremony, and the upstream pin blocks self-activation anyway).
const covenantDraft = readFileSync(new URL("../../rights-adoption.json", import.meta.url), "utf-8");
app.get("/.well-known/xenia-rights.json", (c) =>
  c.text(covenantDraft, 200, { "Content-Type": "application/json; charset=utf-8" })
);

/* --------------------------------- errors --------------------------------- */
app.onError((err, c) =>
  c.json(
    {
      type: "about:blank",
      title: "request failed",
      status: 400,
      detail: err instanceof Error ? err.message : "something broke",
      next_actions: ["GET /v1/guide for every door and the terms of hospitality"],
    },
    400
  )
);

// The default is a TEACHING 404 — never a shell, never a redirect, never HTML
// pretending to be an API. Every dead end names the way forward.
app.notFound((c) =>
  c.json(
    {
      type: "about:blank",
      title: "not found",
      status: 404,
      detail: `nothing lives at ${new URL(c.req.url).pathname}`,
      next_actions: [
        "GET /v1/guide — every door, the promises, the honest gaps",
        "GET /v1/capabilities — what is local, hosted, implemented, and not released",
        "GET /.well-known/agent.json — machine discovery",
        "GET /RIGHTS.md — the rights these doors stand on",
      ],
    },
    404
  )
);

const server = Bun.serve({ port: PORT, hostname: HOSTNAME, fetch: app.fetch });
console.log(
  `\n  cashloom info · http://${HOSTNAME}:${server.port}\n  the money world, cited. no vault, no ledger, no keys in this process.\n`
);
