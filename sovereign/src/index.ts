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
import { quotePayment, confirmPayment, listPayments } from "./pay.ts";
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
import { mountInfoDoors } from "./info/doors.ts";
import { mountPriceDoors } from "./info/price-door.ts";
import { mountZeroneTruth } from "./info/zerone-truth.ts";
import { readFileSync } from "node:fs";
import { keyIdForPublicKey } from "@agenttool/wallet";
import {
  CASHLOOM_V2_NODE_AUTHORITY_LABEL,
  createV2NodeAuthorityProvider,
} from "./protocol/v2/node-authority.ts";
import { createV2RecordStore } from "./protocol/v2/record-store.ts";
import { createV2LocalService } from "./protocol/v2/local-service.ts";
import {
  mountV2LocalRoutes,
  mountV2PublicRoutes,
} from "./protocol/v2/router.ts";
import {
  createBitcoinPayLinkExecutionService,
} from "./pay/bitcoin-pay-link.ts";
import {
  mountBitcoinPayLinkExecutionRoutes,
} from "./pay/bitcoin-pay-link-router.ts";

const app = new Hono();

const PORT = Number(process.env.CASHLOOM_PORT ?? 4747);
// Local-first: never exposed unless the owner explicitly rebinds.
const HOSTNAME = process.env.CASHLOOM_BIND ?? "127.0.0.1";

const boundedV2EnvironmentInteger = (
  name: string,
  fallback: number,
  maximum: number,
): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${name} must be a canonical non-negative integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} exceeds its safe local bound.`);
  }
  return value;
};

const v2RemoteLimits = Object.freeze({
  maxRecordCount: boundedV2EnvironmentInteger(
    "CASHLOOM_V2_REMOTE_MAX_RECORDS",
    10_000,
    1_000_000,
  ),
  maxCanonicalBytes: boundedV2EnvironmentInteger(
    "CASHLOOM_V2_REMOTE_MAX_BYTES",
    64 * 1024 * 1024,
    1024 * 1024 * 1024,
  ),
});
const v2Stores = new Map<string, ReturnType<typeof createV2RecordStore>>();

const currentV2NodeKeyId = (): string | null => {
  const row = db
    .query(
      `SELECT address
         FROM vault_keys
        WHERE label = ? AND kind = 'secret'
        LIMIT 1`,
    )
    .get(CASHLOOM_V2_NODE_AUTHORITY_LABEL) as
    | { address: string | null }
    | null;
  if (row === null) return null;
  if (typeof row.address !== "string" || row.address.length === 0) {
    throw new Error("CashLoom v2 node authority has no usable public key.");
  }
  return keyIdForPublicKey(row.address);
};

const v2Store = (keyId = currentV2NodeKeyId()) => {
  const cacheKey = keyId ?? "unactivated";
  const cached = v2Stores.get(cacheKey);
  if (cached) return cached;
  const created = createV2RecordStore({
    db,
    localNodeKeyId: keyId,
    remoteLimits: v2RemoteLimits,
  });
  v2Stores.set(cacheKey, created);
  return created;
};

const v2AuthorityProvider = createV2NodeAuthorityProvider({
  db,
  vault,
});

const v2LocalService = async () => {
  const node = await v2AuthorityProvider.ensure();
  return createV2LocalService({
    store: v2Store(node.authority.key_id),
    authorityProvider: v2AuthorityProvider,
  });
};

/* --------------------------------- public -------------------------------- */

app.get("/api/meta", (c) =>
  c.json({
    name: "cashloom-sovereign",
    mode: "sovereign", // there is no other mode
    version: "0.1.0",
    initialized: vault.isInitialized(),
    unlocked: vault.isUnlocked(),
    db: DB_PATH,
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
// The money-world information door — public, secretless, cited, Xenia-negotiated.
// Reads public chain state only; never touches the vault. Registered here, above
// the /api/* session gate, on purpose: non-custodial by position.
mountMoneyworld(app);
mountInfoDoors(app); // fees · assets · convert · guide — same covenant, same side of the gate
mountPriceDoors(app); // spot price · prices board · value — on-chain oracle, crypto→fiat, refuses when stale
mountZeroneTruth(app); // zerone truth chain — verified facts · doctrine · commitments · calibration (read-only, cited)

// Signed-record transport only. These routes do not unlock a vault, create a
// key, enumerate records, or expose private evidence.
mountV2PublicRoutes(app, { store: v2Store });

// The rights the doors stand on, served AT the door — a guest should never
// need the git repo to read what this node has promised. Bytes cached at boot.
const rightsMd = readFileSync(new URL("../../RIGHTS.md", import.meta.url), "utf-8");
app.get("/RIGHTS.md", (c) => c.text(rightsMd, 200, { "Content-Type": "text/markdown; charset=utf-8" }));

const passphraseSchema = z.object({ passphrase: z.string().min(1) });

app.post("/api/vault/init", async (c) => {
  const body = passphraseSchema.parse(await c.req.json());
  await vault.initialize(body.passphrase);
  const token = await vault.unlock(body.passphrase);
  return c.json({ ok: true, token });
});

app.post("/api/vault/unlock", async (c) => {
  const body = passphraseSchema.parse(await c.req.json());
  const token = await vault.unlock(body.passphrase);
  return c.json({ ok: true, token });
});

/* ---------------------------- session-gated API --------------------------- */

app.use("/api/*", async (c, next) => {
  // Everything below this middleware requires an unlocked vault session.
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!vault.isValidSession(token)) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "locked", message: "Unlock the vault first." }, 401);
  }
  await next();
});

app.post("/api/vault/lock", (c) => {
  vault.lock();
  return c.json({ ok: true });
});

app.get("/api/vault/keys", (c) => c.json({ keys: vault.listKeys() }));

// Closed local creation and private-by-id reads. Registered after the session
// middleware; there is no arbitrary "sign these bytes" route.
mountV2LocalRoutes(app, {
  store: v2Store,
  service: v2LocalService,
});
mountBitcoinPayLinkExecutionRoutes(app, {
  service: () =>
    createBitcoinPayLinkExecutionService({
      database: db,
      store: v2Store,
      localService: v2LocalService,
    }),
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
  credential_ref: z
    .string()
    .regex(/^(STRIPE|GOCARDLESS|ALCHEMY|AGENTTOOL)_(?!BASE_URL$)[A-Z0-9_]+$/)
    .optional(),
  vault_key_id: z.string().uuid().optional(),
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
    `INSERT INTO accounts (id, rail, display_name, currency, decimals, connector_type, external_account_id, credential_ref, vault_key_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.rail,
    body.display_name,
    body.currency.trim().toUpperCase(),
    body.decimals,
    body.connector_type ?? null,
    body.external_account_id ?? null,
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
  // SQLite integer math is 64-bit — safe for realistic minor-unit sums.
  const perAccount = db
    .query(
      `SELECT a.id, a.display_name, a.currency, a.decimals, a.balance_minor,
              COALESCE(SUM(CASE WHEN CAST(t.amount_minor AS INTEGER) > 0 THEN CAST(t.amount_minor AS INTEGER) ELSE 0 END), 0) AS in_minor,
              COALESCE(SUM(CASE WHEN CAST(t.amount_minor AS INTEGER) < 0 THEN -CAST(t.amount_minor AS INTEGER) ELSE 0 END), 0) AS out_minor,
              COUNT(t.id) AS tx_count
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.status = 'ACTIVE'
       GROUP BY a.id ORDER BY a.created_at`
    )
    .all();
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
  const body = z.object({ paymentId: z.string().uuid() }).parse(await c.req.json());
  return c.json(await confirmPayment(body.paymentId));
});

app.get("/api/payments", (c) => c.json({ payments: listPayments() }));

// Agent Wallet authorization evidence. CashLoom trusts only locally configured
// simulation keys, derives + reserves usage in SQLite, and vault-signs the
// result. This is intentionally NOT wired to confirmPayment yet: until an
// adapter binds exact chain bytes to a CashLoom quote, the returned status is
// `authorized-not-bound` and cannot move money.
app.post("/api/pay/agent/authorize", async (c) => {
  try {
    return c.json(await authorizeAgentPayment_wired(await c.req.json()));
  } catch (e) {
    return c.json({ authorized: false, refused: e instanceof Error ? e.message : String(e) }, 403);
  }
});

/* --------------------------------- errors --------------------------------- */

app.onError((err, c) => {
  // Errors carry instructions, never secrets (vault/senders never embed key
  // material in messages — house discipline).
  const message = err instanceof Error ? err.message : "Something broke.";
  const status = err instanceof z.ZodError ? 400 : 400;
  return c.json({ error: "request_failed", message }, status);
});

/* ----------------------------------- ui ----------------------------------- */

app.use("/*", serveStatic({ root: "./ui/dist" }));
app.get("*", serveStatic({ path: "./ui/dist/index.html" }));

const server = Bun.serve({ port: PORT, hostname: HOSTNAME, fetch: app.fetch });
console.log(
  `\n  cashloom sovereign · http://${HOSTNAME}:${server.port}\n  ledger: ${DB_PATH}\n  your keys, your data, your machine.\n`
);
