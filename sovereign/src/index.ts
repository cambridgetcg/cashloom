/** CashLoom sovereign node — one process, one file, your machine.
 *
 *  Binds 127.0.0.1 by default: this is YOUR node, not a server. The UI is
 *  served from the same process (ui/dist) — no CORS, no second origin, no
 *  cloud. Everything money-shaped goes through the vault session.
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { db, DB_PATH, newId } from "./db.ts";
import * as vault from "./vault.ts";
import {
  quotePayment,
  confirmPayment,
  getWalletKernelIntent,
  listPayments,
  listWalletKernelPositions,
  reconcileBasePayment,
  resumePaymentBroadcast,
} from "./pay.ts";
import { syncAccount } from "./sync.ts";
import {
  getAllStatus,
  getAddressBalance,
  getParticipationGuide,
  isZrnAddress,
  ZERONE_NETWORKS,
} from "./zerone.ts";
import { mountMoneyworld } from "./info/router.ts";
import { authorizeAgentPayment_wired } from "./pay/agent-pay.ts";
import type { AgentTrustBinding } from "./pay/agent-pay.ts";
import { mountInfoDoors } from "./info/doors.ts";
import { mountPriceDoors } from "./info/price-door.ts";
import { mountZeroneTruth } from "./info/zerone-truth.ts";
import { mountWorldDoor } from "./info/world-door.ts";
import { mountCashRatesDoor } from "./info/cash-rates.ts";
import { mountFedAnnouncementsDoor } from "./info/fed-announcements.ts";
import { mountOnchainDoor } from "./info/blockchain/door.ts";
import {
  mountXeniaSurface,
  surfaceRouteNotFoundResponse,
} from "./info/xenia-surface.ts";
import { readFileSync } from "node:fs";
import {
  compressPublicResponses,
  publicDeliveryHeaders,
} from "./info/http-delivery.ts";
import {
  caip10AccountIdSchema,
  caip19AssetIdSchema,
  chainIdSchema,
} from "./wallet/domain/identities.ts";

export const app = new Hono();

const PORT = Number(process.env.CASHLOOM_PORT ?? 4747);
// Local-first: never exposed unless the owner explicitly rebinds.
const HOSTNAME = process.env.CASHLOOM_BIND ?? "127.0.0.1";

const normalizedHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[|\]$/g, "");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
export const isCustodyBindAllowed = (hostname: string): boolean =>
  loopbackHosts.has(normalizedHost(hostname));
const configuredHosts = new Set(
  (process.env.CASHLOOM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map(normalizedHost)
    .filter(Boolean),
);
const configuredOrigins = new Set(
  (process.env.CASHLOOM_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const loopbackBound = isCustodyBindAllowed(HOSTNAME);
if (!loopbackBound) {
  throw new Error(
    "Wallet Kernel custody is loopback-only. CASHLOOM_BIND must be localhost, 127.0.0.1, or ::1; use a separately authenticated TLS gateway before any future remote exposure.",
  );
}
/** Loopback names are implicit only for a loopback listener. Once the owner
 * exposes the process, every accepted Host must be explicitly allowlisted—a
 * remote caller can forge `Host: 127.0.0.1` on a wildcard listener. */
export const isRequestHostAllowed = (
  bindHostname: string,
  explicitHosts: ReadonlySet<string>,
  requestedHostname: string,
): boolean => {
  const requested = normalizedHost(requestedHostname);
  const bindIsLoopback = isCustodyBindAllowed(bindHostname);
  return explicitHosts.has(requested) || (bindIsLoopback && loopbackHosts.has(requested));
};
const allowedRequestHost = (hostname: string): boolean =>
  isRequestHostAllowed(HOSTNAME, configuredHosts, hostname);

const agentSessionTrust = new Map<string, AgentTrustBinding>();

// Localhost is a network location, not an authentication primitive. Refuse
// hostile Host/Origin values before fresh-vault initialization, unlock, or any
// session-bearing route can be reached through browser DNS rebinding.
app.use("/api/*", async (c, next) => {
  const requestUrl = new URL(c.req.url);
  const hostHeader = c.req.header("Host");
  let headerHostname = requestUrl.hostname;
  if (hostHeader) {
    try {
      headerHostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return c.json({ error: "host_not_allowed", message: "Malformed request host." }, 403);
    }
  }
  if (!allowedRequestHost(requestUrl.hostname) || !allowedRequestHost(headerHostname)) {
    return c.json({ error: "host_not_allowed", message: "This host is not trusted by the local custody boundary." }, 403);
  }
  const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
  const originValue = c.req.header("Origin");
  if ((fetchSite === "cross-site" || fetchSite === "cross-origin") && !originValue) {
    return c.json({ error: "origin_not_allowed", message: "Cross-site browser requests are refused." }, 403);
  }
  if (originValue) {
    let origin: URL;
    try {
      origin = new URL(originValue);
    } catch {
      return c.json({ error: "origin_not_allowed", message: "Malformed browser origin." }, 403);
    }
    if (
      (fetchSite === "cross-site" || fetchSite === "cross-origin") &&
      !configuredOrigins.has(origin.origin)
    ) {
      return c.json({ error: "origin_not_allowed", message: "Cross-site browser requests are refused." }, 403);
    }
    if (origin.origin !== requestUrl.origin && !configuredOrigins.has(origin.origin)) {
      return c.json({ error: "origin_not_allowed", message: "This browser origin is not trusted." }, 403);
    }
  }
  await next();
});

app.use("*", publicDeliveryHeaders);
app.use("*", compressPublicResponses());

/* --------------------------------- public -------------------------------- */

app.get("/api/meta", (c) =>
  c.json({
    name: "cashloom-sovereign",
    mode: "sovereign", // there is no other mode
    version: "0.1.0",
    initialized: vault.isInitialized(),
    unlocked: vault.isUnlocked(),
    db: DB_PATH,
    wallet_kernel: {
      version: "2",
      intent_schema: "cashloom.payment-intent/1",
      identities: ["CAIP-2", "CAIP-10", "CAIP-19", "ISO-4217"],
      live_signers: ["Base EIP-1559", "Bitcoin mainnet P2WPKH"],
      request_schemas: ["EIP-1559", "EIP-712", "BIP-174/370 PSBT", "Solana transaction"],
      agent_policy: "agent-wallet/0.1",
      arithmetic: "exact atomic-unit decimal strings",
    },
  })
);

/* --------------------------- zerone front (public) ------------------------ */
// The front door to the zerone truth chain — read-only, no vault, no auth.
// Any human or agent can read the live chain and the participation guide.
// Registered above the /api/* session gate on purpose.

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

/* ------------------------- moneyworld (public) ---------------------------- */
// The money-world information door — public, secretless, and cited. Its bounded
// XENIA Surface is mounted separately above the legacy data routes.
// Reads public chain state only; never touches the vault. Registered here, above
// the /api/* session gate, on purpose: non-custodial by position.
mountXeniaSurface(app, { runtime: "local_sovereign" });
mountMoneyworld(app);
mountInfoDoors(app); // fees · assets · convert · guide — same covenant, same side of the gate
mountPriceDoors(app); // spot price · prices board · value — on-chain oracle, crypto→fiat, refuses when stale
mountCashRatesDoor(app); // SOFR + EFFR — official overnight cash reference rates, required notice attached
mountFedAnnouncementsDoor(app); // latest official Federal Reserve monetary-policy release titles and links
mountWorldDoor(app); // composed policy · yields · FX · crypto · fees · calendar — partial-safe, cited
mountOnchainDoor(app); // networks · stable money · lending · selected pools · bridge routes — pinned and cited
mountZeroneTruth(app); // zerone truth chain — verified facts · doctrine · commitments · calibration (read-only, cited)

// The rights the doors stand on, served AT the door — a guest should never
// need the git repo to read what this node has promised. Bytes cached at boot.
const rightsMd = readFileSync(new URL("../../RIGHTS.md", import.meta.url), "utf-8");
app.get("/RIGHTS.md", (c) => c.text(rightsMd, 200, { "Content-Type": "text/markdown; charset=utf-8" }));

const covenantDraft = readFileSync(new URL("../../rights-adoption.json", import.meta.url), "utf-8");
app.get("/.well-known/xenia-rights.json", (c) =>
  c.text(covenantDraft, 200, { "Content-Type": "application/json; charset=utf-8" })
);

const sessionScopeSchema = z.enum([
  "accounts:read",
  "accounts:write",
  "keys:manage",
  "payments:quote",
  "payments:confirm",
  "agent:authorize",
]);

const passphraseSchema = z.object({
  passphrase: z.string().min(1),
  // Omit both fields for the original, full-access unlock behavior. Scoped,
  // short-lived sessions let a local agent hold only the authority it needs.
  scopes: z.array(sessionScopeSchema).min(1).optional(),
  ttlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
});

app.post("/api/vault/init", async (c) => {
  const body = passphraseSchema.parse(await c.req.json());
  await vault.initialize(body.passphrase);
  const token = await vault.unlock(body.passphrase, {
    scopes: body.scopes,
    ttlMs: body.ttlMs,
  });
  return c.json({ ok: true, token });
});

app.post("/api/vault/unlock", async (c) => {
  const body = passphraseSchema.parse(await c.req.json());
  const token = await vault.unlock(body.passphrase, {
    scopes: body.scopes,
    ttlMs: body.ttlMs,
  });
  return c.json({ ok: true, token });
});

/* ---------------------------- session-gated API --------------------------- */

/** The local API's least-authority map. Public routes are mounted above this
 *  gate; every private route gets one explicit wallet-session capability.
 *  Exported so the authority surface can be audited without starting a node. */
export const requiredScopeForLocalRoute = (
  method: string,
  pathname: string,
): vault.VaultSessionScope | undefined => {
  const verb = method.toUpperCase();

  if (
    pathname === "/api/vault/lock" ||
    pathname === "/api/vault/keys" ||
    pathname.startsWith("/api/vault/keys/") ||
    pathname === "/api/vault/sessions"
  ) {
    return "keys:manage";
  }
  if (pathname === "/api/accounts" || pathname.startsWith("/api/accounts/")) {
    return verb === "GET" ? "accounts:read" : "accounts:write";
  }
  if (pathname === "/api/transactions" || pathname.startsWith("/api/transactions/")) {
    return verb === "GET" ? "accounts:read" : "accounts:write";
  }
  if (pathname === "/api/analytics" || pathname.startsWith("/api/analytics/")) {
    return "accounts:read";
  }
  if (pathname === "/api/pay/quote") return "payments:quote";
  if (pathname === "/api/pay/confirm") return "payments:confirm";
  if (pathname === "/api/pay/recover") return "payments:confirm";
  if (pathname === "/api/pay/agent/authorize") return "agent:authorize";
  if (pathname === "/api/pay/agent/confirm") return "agent:authorize";
  if (
    verb === "POST" &&
    /^\/api\/wallet\/v2\/intents\/[^/]+\/reconcile$/.test(pathname)
  ) {
    return "accounts:write";
  }
  if (pathname === "/api/wallet/v2" || pathname.startsWith("/api/wallet/v2/")) {
    return verb === "GET" ? "accounts:read" : undefined;
  }
  if (pathname === "/api/payments" || pathname.startsWith("/api/payments/")) {
    return "accounts:read";
  }
  return undefined;
};

app.use("/api/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  // Distinguish an absent/expired vault session from a real session that has
  // insufficient authority. This gives agent callers a recoverable signal
  // without broadening either token.
  if (!vault.isValidSession(token)) {
    if (token) agentSessionTrust.delete(token);
    return c.json({ error: "locked", message: "Unlock the vault first." }, 401);
  }
  const requiredScope = requiredScopeForLocalRoute(c.req.method, c.req.path);
  if (!requiredScope) {
    return c.json(
      {
        error: "route_scope_unmapped",
        message: "This private API route has no declared vault-session scope.",
      },
      403,
    );
  }
  if (!vault.isValidSession(token, requiredScope)) {
    return c.json(
      {
        error: "insufficient_scope",
        message: `This operation requires the ${requiredScope} vault-session scope.`,
        required_scope: requiredScope,
      },
      403,
    );
  }
  const session = vault.getSessionInfo(token);
  if (session?.principal.kind === "agent" && requiredScope === "payments:confirm") {
    return c.json(
      {
        error: "agent_attestation_required",
        message: "Agent sessions must use /api/pay/agent/confirm with a bound capability attestation.",
      },
      403,
    );
  }
  await next();
});

app.post("/api/vault/lock", (c) => {
  vault.lock();
  agentSessionTrust.clear();
  return c.json({ ok: true });
});

app.get("/api/vault/keys", (c) => c.json({ keys: vault.listKeys() }));

app.post("/api/vault/sessions", async (c) => {
  const ownerToken = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const sha256Id = z.string().regex(/^sha256:[0-9a-f]{64}$/);
  const body = z.object({
    trust: z.object({
      walletId: z.string().min(1).max(200),
      descriptorRecordId: sha256Id,
      ownerKeyId: sha256Id,
      grantId: z.string().min(1).max(200),
      capabilityRecordId: sha256Id,
      delegateKeyId: sha256Id,
      trustedSimulationAdapterKeyIds: z.array(sha256Id).min(1).max(16),
    }),
    scopes: z.array(sessionScopeSchema).min(1),
    ttlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  }).parse(await c.req.json());
  const delegated = vault.createDelegatedAgentSession(ownerToken, {
    delegateKeyId: body.trust.delegateKeyId,
    scopes: body.scopes,
    ttlMs: body.ttlMs,
  });
  const trust: AgentTrustBinding = Object.freeze({
    ...body.trust,
    trustedSimulationAdapterKeyIds: Object.freeze([
      ...new Set(body.trust.trustedSimulationAdapterKeyIds),
    ]),
  });
  agentSessionTrust.set(delegated.token, trust);
  return c.json({ ...delegated, trust }, 201);
});

const keySchema = z
  .object({
    label: z.string().min(1).max(80),
    action: z.enum(["generate", "import"]),
    kind: z.enum(["evm", "btc"]).default("evm"),
    privHex: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), // evm import
    secret: z.string().min(1).max(120).optional(), // btc import: WIF or 64-hex
  })
  .superRefine((body, ctx) => {
    // Each kind imports through its own field — a key pasted into the wrong
    // one should say so, not surface as "empty key" from the vault.
    if (body.action !== "import") return;
    if (body.kind === "evm" && !body.privHex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privHex"],
        message: "Importing an evm key needs privHex (0x + 64 hex). Did you mean kind: 'btc'?",
      });
    }
    if (body.kind === "btc" && !body.secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secret"],
        message: "Importing a btc key needs secret (mainnet WIF or 64-hex). Did you mean kind: 'evm'?",
      });
    }
  });

app.post("/api/vault/keys", async (c) => {
  const body = keySchema.parse(await c.req.json());
  const key =
    body.kind === "btc"
      ? body.action === "generate"
        ? await vault.generateBtcKey(body.label)
        : await vault.importBtcKey(body.label, body.secret ?? "")
      : body.action === "generate"
        ? await vault.generateEvmKey(body.label)
        : await vault.importEvmKey(body.label, body.privHex ?? "");
  return c.json({ key }, 201);
});

/* -------------------------------- accounts -------------------------------- */

const accountSchema = z.object({
  rail: z.enum(["STRIPE", "BANK", "CRYPTO", "CASH", "PLATFORM_CREDIT", "GIFT_CARD"]),
  display_name: z.string().min(1).max(120),
  currency: z.string().min(2).max(12),
  decimals: z.number().int().min(0).max(18),
  connector_type: z.string().max(40).optional(),
  external_account_id: z.string().max(200).optional(),
  chain_id: chainIdSchema.optional(),
  asset_id: caip19AssetIdSchema.optional(),
  account_ref: caip10AccountIdSchema.optional(),
  credential_ref: z
    .string()
    .regex(/^(STRIPE|GOCARDLESS|ALCHEMY|AGENTTOOL)_(?!BASE_URL$)[A-Z0-9_]+$/)
    .optional(),
  vault_key_id: z.string().uuid().optional(),
}).superRefine((body, context) => {
  if (body.rail !== "CRYPTO") return;
  if (!body.chain_id || !body.asset_id || !body.account_ref) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chain_id"],
      message: "Crypto accounts require explicit CAIP-2 chain_id, CAIP-19 asset_id, and CAIP-10 account_ref.",
    });
    return;
  }
  if (!body.asset_id.startsWith(`${body.chain_id}/`) || !body.account_ref.startsWith(`${body.chain_id}:`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["asset_id"],
      message: "Crypto asset_id and account_ref must belong to chain_id.",
    });
  }
});

app.get("/api/accounts", (c) =>
  c.json({
    accounts: db
      .query("SELECT * FROM accounts WHERE status = 'ACTIVE' ORDER BY created_at")
      .all(),
  })
);

app.post("/api/accounts", async (c) => {
  const body = accountSchema.parse(await c.req.json());
  const id = newId();
  db.query(
    `INSERT INTO accounts
       (id, rail, display_name, currency, decimals, connector_type,
        external_account_id, chain_id, asset_id, account_ref, credential_ref, vault_key_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.rail,
    body.display_name,
    body.currency.trim().toUpperCase(),
    body.decimals,
    body.connector_type ?? null,
    body.external_account_id ?? null,
    body.chain_id ?? null,
    body.asset_id ?? null,
    body.account_ref ?? null,
    body.credential_ref ?? null,
    body.vault_key_id ?? null
  );
  return c.json({ account: db.query("SELECT * FROM accounts WHERE id = ?").get(id) }, 201);
});

app.post("/api/accounts/:id/archive", (c) => {
  db.query("UPDATE accounts SET status = 'ARCHIVED' WHERE id = ?").run(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/accounts/:id/sync", async (c) => {
  const result = await syncAccount(c.req.param("id"));
  return c.json(result);
});

/* ------------------------------ transactions ------------------------------ */

const txSchema = z.object({
  account_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  amount_minor: z.string().regex(/^-?[0-9]+$/),
  date: z.string().datetime().optional(),
  category: z.string().max(60).optional(),
});

app.get("/api/transactions", (c) => {
  const accountId = c.req.query("accountId");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const rows = accountId
    ? db
        .query(
          "SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC LIMIT ?"
        )
        .all(accountId, limit)
    : db.query("SELECT * FROM transactions ORDER BY date DESC LIMIT ?").all(limit);
  return c.json({ transactions: rows });
});

app.post("/api/transactions", async (c) => {
  const body = txSchema.parse(await c.req.json());
  const id = newId();
  db.query(
    `INSERT INTO transactions (id, account_id, title, amount_minor, date, category, source)
     VALUES (?, ?, ?, ?, ?, ?, 'MANUAL')`
  ).run(
    id,
    body.account_id,
    body.title,
    body.amount_minor,
    body.date ?? new Date().toISOString(),
    body.category ?? null
  );
  return c.json({ transaction: db.query("SELECT * FROM transactions WHERE id = ?").get(id) }, 201);
});

/* -------------------------------- analytics ------------------------------- */

app.get("/api/analytics/summary", (c) => {
  // SQLite's INTEGER/SUM path is signed 64-bit. Atomic values are TEXT by
  // design, so aggregate them as BigInt and serialize decimal strings without
  // ever passing through SQLite INTEGER or JavaScript Number.
  const accounts = db
    .query(
      `SELECT id, display_name, currency, decimals, balance_minor
       FROM accounts WHERE status = 'ACTIVE' ORDER BY created_at`,
    )
    .all() as Array<{
      id: string;
      display_name: string;
      currency: string;
      decimals: number;
      balance_minor: string;
    }>;
  const totals = new Map<string, { inbound: bigint; outbound: bigint; count: number }>();
  const amounts = db.query(
    `SELECT t.account_id, t.amount_minor
     FROM transactions t
     INNER JOIN accounts a ON a.id = t.account_id
     WHERE a.status = 'ACTIVE'`,
  );

  // Stream the ledger rather than materializing it; exactness need not turn a
  // large local history into a refresh-time memory spike.
  for (const row of amounts.iterate() as IterableIterator<{
    account_id: string;
    amount_minor: string;
  }>) {
    const amount = BigInt(row.amount_minor);
    const total = totals.get(row.account_id) ?? { inbound: 0n, outbound: 0n, count: 0 };
    if (amount > 0n) total.inbound += amount;
    if (amount < 0n) total.outbound -= amount;
    total.count += 1;
    totals.set(row.account_id, total);
  }

  const perAccount = accounts.map((account) => {
    const total = totals.get(account.id) ?? { inbound: 0n, outbound: 0n, count: 0 };
    return {
      ...account,
      in_minor: total.inbound.toString(),
      out_minor: total.outbound.toString(),
      tx_count: total.count,
    };
  });
  return c.json({ accounts: perAccount });
});

/* ---------------------------------- pay ----------------------------------- */

const quoteSchema = z.object({
  accountId: z.string().uuid(),
  to: z.string().min(3).max(200),
  amountMinor: z.string().regex(/^[0-9]+$/),
  asset: z.string().min(2).max(12),
});

app.post("/api/pay/quote", async (c) => {
  const body = quoteSchema.parse(await c.req.json());
  return c.json(await quotePayment(body));
});

app.post("/api/pay/confirm", async (c) => {
  const body = z.object({
    paymentId: z.string().uuid(),
    agentAuthorizationId: z.string().uuid().optional(),
  }).parse(await c.req.json());
  return c.json(await confirmPayment(body.paymentId, {
    agentAuthorizationId: body.agentAuthorizationId,
  }));
});

app.post("/api/pay/recover", async (c) => {
  const body = z.object({ paymentId: z.string().uuid() }).parse(await c.req.json());
  return c.json(await resumePaymentBroadcast(body.paymentId));
});

app.post("/api/pay/agent/confirm", async (c) => {
  const body = z.object({
    paymentId: z.string().uuid(),
    agentAuthorizationId: z.string().uuid(),
  }).parse(await c.req.json());
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const principal = vault.getSessionInfo(token)?.principal;
  if (principal?.kind !== "agent") {
    return c.json(
      { error: "agent_session_required", message: "This route requires an owner-delegated agent session." },
      403,
    );
  }
  return c.json(
    {
      error: "base_agent_proposal_only",
      message:
        "Base autonomous execution is proposal-only: the signed agent max_fee is a hard bound, while Base L1 data/security and operator charges are not transaction-hard-capped. An owner session must confirm this quote.",
      payment_id: body.paymentId,
      agent_authorization_id: body.agentAuthorizationId,
    },
    403,
  );
});

app.get("/api/payments", (c) => c.json({ payments: listPayments() }));

app.get("/api/wallet/v2/positions", (c) => c.json(listWalletKernelPositions()));

app.get("/api/wallet/v2/intents/:id", (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  const view = getWalletKernelIntent(id);
  return view
    ? c.json(view)
    : c.json({ error: "intent_not_found", intent_id: id }, 404);
});

app.post("/api/wallet/v2/intents/:id/reconcile", async (c) => {
  const id = z.string().uuid().parse(c.req.param("id"));
  return c.json(await reconcileBasePayment(id, c.req.raw.signal));
});

// Agent payment authorization — the capability gate, in the pay flow. An agent
// submits signed {descriptor, capability, intent, simulation}; CashLoom derives
// durable usage itself. The gate authorizes only a within-grant intent and the vault
// signs the authorization. Nothing is broadcast: a pass records permission,
// the deliberate confirm step still does the send.
app.post("/api/pay/agent/authorize", async (c) => {
  try {
    const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const principal = vault.getSessionInfo(token)?.principal;
    const trust = token ? agentSessionTrust.get(token) : undefined;
    if (principal?.kind === "agent" && (!trust || trust.delegateKeyId !== principal.ref)) {
      return c.json(
        { authorized: false, refused: "This agent session has no owner-pinned capability root." },
        403,
      );
    }
    return c.json(await authorizeAgentPayment_wired(await c.req.json(), {
      expectedDelegateKeyId: principal?.kind === "agent" ? principal.ref : undefined,
      expectedTrust: principal?.kind === "agent" ? trust : undefined,
    }));
  } catch (e) {
    return c.json({ authorized: false, refused: e instanceof Error ? e.message : String(e) }, 403);
  }
});

/* --------------------------------- errors --------------------------------- */

app.onError((err, c) => {
  // Errors carry instructions, never secrets (vault/senders never embed key
  // material in messages — house discipline).
  const message = err instanceof Error ? err.message : "Something broke.";
  const status = err instanceof z.ZodError ? 400 : 500;
  return c.json({ error: "request_failed", message }, status);
});

/* ----------------------------------- ui ----------------------------------- */

app.use("/*", serveStatic({ root: "./ui/dist" }));
const serveUiIndex = serveStatic({ path: "./ui/dist/index.html" });
app.get("*", async (c, next) => {
  const accept = c.req.header("Accept")?.toLowerCase() ?? "";
  if (accept.includes("application/problem+json") || accept.includes("application/json")) {
    return surfaceRouteNotFoundResponse(c.req.raw);
  }
  return await serveUiIndex(c, next) ?? surfaceRouteNotFoundResponse(c.req.raw);
});
app.notFound((c) => surfaceRouteNotFoundResponse(c.req.raw));

if (import.meta.main) {
  const server = Bun.serve({ port: PORT, hostname: HOSTNAME, fetch: app.fetch });
  console.log(
    `\n  cashloom sovereign · http://${HOSTNAME}:${server.port}\n  ledger: ${DB_PATH}\n  your keys, your data, your machine.\n`,
  );
}
