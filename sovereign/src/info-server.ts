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
import { mountPriceDoors } from "./info/price-door.ts";
import { mountZeroneTruth } from "./info/zerone-truth.ts";
import { mountWorldDoor } from "./info/world-door.ts";
import { mountCashRatesDoor } from "./info/cash-rates.ts";
import { mountFedAnnouncementsDoor } from "./info/fed-announcements.ts";
import { mountOnchainDoor } from "./info/blockchain/door.ts";
import {
  CASHLOOM_PUBLIC_ORIGIN_HEADER,
  mountXeniaSurface,
  surfaceInternalErrorResponse,
  surfaceRouteNotFoundResponse,
} from "./info/xenia-surface.ts";
import { readFileSync } from "node:fs";
import { cors } from "hono/cors";
import {
  compressPublicResponses,
  publicDeliveryHeaders,
} from "./info/http-delivery.ts";

const app = new Hono();

const PORT = Number(process.env.CASHLOOM_PORT ?? 4747);
// The hosted door binds wide on purpose — its module graph has no custody,
// ledger, or sender modules. Request metadata at external layers is disclosed
// separately by /v1/data-practices.
const HOSTNAME = process.env.CASHLOOM_BIND ?? "0.0.0.0";

// Apply the representation transform inside the delivery-receipt middleware:
// responses keep every existing Vary field and additionally disclose that
// content coding changes with Accept-Encoding.
app.use("*", publicDeliveryHeaders);
app.use("*", compressPublicResponses());

// This process exposes public, read-only facts only. Wildcard CORS is therefore
// deliberate: cashloom.io, self-hosted dashboards, spreadsheets, and agents can
// read the same application surface, while no credentialed route exists here.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    allowHeaders: [
      "Accept",
      "Cache-Control",
      "Content-Type",
      "If-Modified-Since",
      "If-None-Match",
      "Prefer",
      CASHLOOM_PUBLIC_ORIGIN_HEADER,
    ],
    exposeHeaders: [
      "Age",
      "Cache-Control",
      "ETag",
      "Last-Modified",
      "Preference-Applied",
      "Retry-After",
      "Server-Timing",
      "Timing-Allow-Origin",
      "Vary",
      "Warning",
      "X-CashLoom-Cache",
      "X-CashLoom-Snapshot-Age",
    ],
    maxAge: 86_400,
  }),
);

app.get("/api/meta", (c) =>
  c.json({
    name: "cashloom-info",
    mode: "info", // the hosted MONEYWORLD door — no vault, no ledger, no senders in this process
    version: "0.1.0",
    self_run: "this is one reference copy of an open-source node — github.com/cambridgetcg/cashloom",
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
mountXeniaSurface(app);
mountMoneyworld(app);
mountInfoDoors(app);
mountPriceDoors(app);
mountCashRatesDoor(app);
mountFedAnnouncementsDoor(app);
mountWorldDoor(app);
mountOnchainDoor(app);
mountZeroneTruth(app);

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
app.onError((_err, c) => surfaceInternalErrorResponse(c.req.raw));

// The default is a TEACHING 404 — never a shell, never a redirect, never HTML
// pretending to be an API. Every dead end names the way forward.
app.notFound((c) => surfaceRouteNotFoundResponse(c.req.raw));

const server = Bun.serve({ port: PORT, hostname: HOSTNAME, fetch: app.fetch });
console.log(
  `\n  cashloom info · http://${HOSTNAME}:${server.port}\n  the money world, cited. no vault, no ledger, no keys in this process.\n`
);
