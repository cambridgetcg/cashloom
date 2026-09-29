/** Test-only loopback app: real TCG routes/stores, real built UI, synthetic auth.
 * Never import index.ts/db.ts/vault.ts: those are separately verified by index
 * tests. No signing/provider code is loaded here. Launch only via run.py.
 */
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { installWalletKernelSchema } from "../../src/wallet/infrastructure/sqlite/schema";
import { TradeStore } from "../../src/tcg/store";
import { SimulationStore } from "../../src/tcg/simulation-store";
import { createTcgRoutes } from "../../src/tcg/routes";

const root = process.env.TCG_BROWSER_ROOT;
if (!root || !existsSync(join(root, ".tcg-browser-fixture"))) throw new Error("Use the isolated run.py fixture");
if (realpathSync(process.env.HOME ?? "/") !== join(root, "home") || realpathSync(process.env.CASHLOOM_DATA_DIR ?? "/") !== join(root, "data")) throw new Error("Refusing non-fixture HOME/data");
globalThis.fetch = (() => { throw new Error("Server outgoing fetch forbidden in TCG browser fixture"); }) as typeof fetch;
const db = new Database(join(root, "data", "wallet-fixture.db"), { create: true });
installWalletKernelSchema(db);
const stamp = "2030-01-01T00:00:00.000Z";
if (!db.query("SELECT id FROM wk_wallets LIMIT 1").get()) {
  db.transaction(() => {
    db.query("INSERT INTO wk_wallets(id,label,created_at,updated_at) VALUES(?,?,?,?)").run("fixture-wallet", "Synthetic untouched wallet", stamp, stamp);
    db.query("INSERT INTO wk_assets(id,kind,symbol,name,decimals,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("iso4217:GBP", "fiat", "GBP", "Synthetic pounds", 2, stamp, stamp);
    db.query("INSERT INTO wk_accounts(id,wallet_id,label,kind,rail,custody_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("fixture-account", "fixture-wallet", "Synthetic cash", "cash", "cash", "watch_only", stamp, stamp);
    db.query("INSERT INTO wk_positions(account_id,asset_id,observed_atomic,pending_atomic,source,as_of,updated_at) VALUES(?,?,?,?,?,?,?)").run("fixture-account", "iso4217:GBP", "123456", "0", "synthetic-browser-fixture", stamp, stamp);
  })();
}
const trades = new TradeStore(db);
let sandbox: SimulationStore | null = null;
let sandboxDb: Database | null = null;
const sandboxPath = join(root, "data", "tcg-sandbox.db");
function getSimulationStore(create: boolean) {
  if (!sandbox && (create || existsSync(sandboxPath))) {
    sandboxDb = new Database(sandboxPath, { create, readwrite: true });
    sandbox = new SimulationStore(sandboxDb);
  }
  return sandbox;
}
let token: string | null = null;
let nonTcgMutationAttempts = 0;
let recoveryAttempts = 0;
let balanceObservations = 0;
const fixtureTransactions: { id: string; account_id: string; title: string; amount_minor: string; date: string; category: string | null; external_id: null; created_at: string; kind: string; status: string; source: string }[] = [];
const publicAddress = `0x${"1".repeat(40)}`;
const fixtureKey = { id: "fixture-key", kind: "evm", label: "Synthetic Base key", address: publicAddress, created_at: stamp };
const accountDefaults = { status: "ACTIVE", connector_type: null, external_account_id: null, credential_ref: null, balance_minor: "0", balance_as_of: null, created_at: stamp };
const fixtureAccounts = [
  { ...accountDefaults, id: "fixture-cash", display_name: "Synthetic pocket", rail: "CASH", currency: "GBP", decimals: 2, balance_minor: "123456", balance_as_of: stamp, chain_id: null, asset_id: null, account_ref: null, vault_key_id: null },
  { ...accountDefaults, id: "fixture-base-eth", display_name: "Synthetic Base ETH", rail: "CRYPTO", currency: "ETH", decimals: 18, chain_id: "eip155:8453", asset_id: "eip155:8453/slip44:60", account_ref: `eip155:8453:${publicAddress}`, vault_key_id: fixtureKey.id },
  { ...accountDefaults, id: "fixture-base-usdc", display_name: "Synthetic Base USDC", rail: "CRYPTO", currency: "USDC", decimals: 6, chain_id: "eip155:8453", asset_id: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", account_ref: `eip155:8453:${publicAddress}`, vault_key_id: fixtureKey.id },
];
const fixturePayment = {
  id: "fixture-payment", account_id: "fixture-base-eth", rail: "evm-base", to_addr: `0x${"2".repeat(40)}`,
  asset: "ETH", amount_minor: "10000000000000000", fee_minor: "1000", status: "confirmed", tx_hash: `0x${"a".repeat(64)}`,
  error: null, created_at: stamp, intent_state: "signed",
  truth: { intent_id: "fixture-payment", chain_id: "eip155:8453", lifecycle_state: "signed", network_tx_id: `0x${"a".repeat(64)}`,
    actions: { exact_rebroadcast: true, reconcile: true, safe_to_create_new_payment: false } },
};
const app = new Hono();
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname !== "127.0.0.1") return c.json({ error: "fixture_loopback_only" }, 403);
  const origin = c.req.header("origin");
  if (origin && origin !== url.origin) return c.json({ error: "fixture_origin_denied" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/api/meta", (c) => c.json({ name: "cashloom-synthetic-browser-fixture", mode: "sovereign", version: "fixture", initialized: true, unlocked: token !== null, db: "temporary synthetic fixture only" }));
app.post("/api/vault/unlock", async (c) => {
  const body = await c.req.json();
  if (body.passphrase !== "synthetic-browser-only") return c.json({ error: "fixture_passphrase_required" }, 401);
  token = randomUUID();
  return c.json({ ok: true, token });
});
app.post("/api/vault/lock", (c) => { token = null; return c.json({ ok: true }); });
app.use("/api/*", async (c, next) => {
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: { code: "UNAUTHORIZED", message: "Synthetic fixture session expired" } }, 401);
  await next();
});
app.get("/api/vault/session", (c) => c.json({ serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }));
// Read-only presentation fixtures. These never connect a provider or network.
app.get("/api/connections", (c) => c.json({ schema_version: "cashloom.connections/1", generated_at: stamp, can_manage: false, sources: [], plaid: { environment: "sandbox", configured: false, items: [] } }));
app.get("/api/transfers", (c) => c.json({ can_manage: false, candidates: [], links: [] }));
app.get("/api/wallet/v3/integrations", (c) => c.json({ generated_at: stamp, integrations: [
  { id: "fixture-device", family: "hardware", label: "Synthetic device wallet", configuration_state: "ready", execution_enabled: false, interaction: "owner_device", persisted_connections: "0", capabilities: ["Review a prepared request"], limitations: ["Execution remains disabled in this fixture"] },
  { id: "fixture-bank", family: "bank-data", label: "Synthetic bank reader", configuration_state: "credentials_required", execution_enabled: false, interaction: "owner_redirect", persisted_connections: "0", capabilities: ["Read configured account information"], limitations: ["No bank authorization is started"] },
  { id: "fixture-payment", family: "pay-by-bank", label: "Synthetic bank payment", configuration_state: "policy_blocked", execution_enabled: false, interaction: "owner_redirect", persisted_connections: "0", capabilities: ["Inspect readiness"], limitations: ["No payment execution"] },
] }));
const visualNetwork = (id: string, label: string) => ({ id, label, rpc: "https://example.invalid/rpc", rest: "https://example.invalid/rest", p2pSeed: "synthetic-only", what: "Synthetic network for visual checks." });
app.get("/api/zerone/guide", (c) => c.json({ what_is_zerone: "Synthetic network guide for visual checks.", honest_status: "Synthetic network status for visual checks.", for_humans: ["Read the network guide.", "Review any participation requirements."], for_agents: ["Inspect the read-only network guide."], exit: "No participation is started in this fixture.", onboarding: { mainnet_passport_listing: "synthetic-only" }, networks: { mainnet: visualNetwork("synthetic-mainnet", "Synthetic mainnet"), testnet: visualNetwork("synthetic-testnet", "Synthetic testnet") }, links: { source: "https://example.invalid/source" } }));
app.get("/api/zerone/status", (c) => c.json({ mainnet: { ...visualNetwork("synthetic-mainnet", "Synthetic mainnet"), reachable: true, height: "1234", supply_zrn: 120, hard_cap_zrn: 222222222 }, testnet: { ...visualNetwork("synthetic-testnet", "Synthetic testnet"), reachable: false, height: null, supply_zrn: null, hard_cap_zrn: 222222222 } }));
app.get("/api/accounts", (c) => c.json({ accounts: fixtureAccounts }));
app.get("/api/vault/keys", (c) => c.json({ keys: [fixtureKey, { id: "fixture-record-key", kind: "secret", label: "Synthetic record signer", address: "ed25519-public-fixture", created_at: stamp }] }));
app.get("/api/analytics/summary", (c) => c.json({ accounts: fixtureAccounts.map((account) => ({ ...account, in_minor: "0", out_minor: "0", tx_count: 0 })) }));
app.get("/api/wallet/v3/positions", (c) => c.json({ base_accounts: [] }));
app.get("/api/transactions", (c) => c.json({ transactions: fixtureTransactions.filter((row) => !c.req.query("accountId") || c.req.query("accountId") === row.account_id) }));
app.post("/api/transactions", async (c) => {
  const body = await c.req.json();
  if (!fixtureAccounts.some((account) => account.id === body.account_id && account.status === "ACTIVE")
    || typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(body.date) || !Number.isFinite(Date.parse(body.date))) return c.json({ error: "fixture_requires_active_account_and_iso_datetime" }, 400);
  const transaction = { id: randomUUID(), account_id: body.account_id, title: body.title, amount_minor: body.amount_minor, date: body.date,
    category: body.category ?? null, external_id: null, created_at: new Date().toISOString(), kind: "manual", status: "posted", source: "MANUAL" };
  fixtureTransactions.push(transaction);
  return c.json({ transaction });
});
app.get("/api/payments", (c) => c.json({ payments: [fixturePayment] }));
app.post("/api/accounts/:id/balance", async (c) => {
  const account = fixtureAccounts.find((entry) => entry.id === c.req.param("id"));
  if (!account || account.rail !== "CASH") return c.json({ error: { code: "manual_balance_not_allowed", message: "Synthetic manual account required" } }, 422);
  const body = await c.req.json();
  if (body.expected_balance_minor !== account.balance_minor || body.expected_balance_as_of !== account.balance_as_of) return c.json({ error: { code: "account_balance_conflict", message: "Reload the saved balance" } }, 409);
  if (typeof body.balance_minor !== "string" || !/^-?\d+$/.test(body.balance_minor)) return c.json({ error: "invalid_fixture_balance" }, 400);
  account.balance_minor = body.balance_minor;
  account.balance_as_of = new Date().toISOString();
  balanceObservations++;
  return c.json({ account });
});
// Synthetic transport outcome only: no signer, broadcaster or wallet write.
app.post("/api/pay/recover", async (c) => {
  const body = await c.req.json();
  if (body.paymentId !== fixturePayment.id) return c.json({ error: "fixture_payment_required" }, 400);
  recoveryAttempts++;
  fixturePayment.intent_state = "ambiguous";
  fixturePayment.truth.lifecycle_state = "ambiguous";
  fixturePayment.truth.actions.exact_rebroadcast = false;
  return c.json({ paymentId: fixturePayment.id, status: "confirmed", txHash: fixturePayment.tx_hash, error: "Synthetic outcome unknown" });
});
app.route("/api/tcg", createTcgRoutes({ trades, getSimulationStore, getActor: () => ({ kind: "owner", ref: "local-owner" }) }));
app.all("/api/*", (c) => {
  if (c.req.method !== "GET") nonTcgMutationAttempts++;
  return c.json({ error: "non_tcg_effect_disabled" }, 404);
});
app.get("/__fixture/status", (c) => {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wk_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const rows = Object.fromEntries(tables.map((name) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return c.json({ walletDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), walletTables: tables.length, positions: rows.wk_positions, nonTcgMutationAttempts, recoveryAttempts, balanceObservations, sandboxExists: existsSync(sandboxPath), sandboxTables: sandboxDb ? sandboxDb.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() : [] });
});
app.get("*", async (c) => {
  const dist = join(root, "ui", "dist");
  const path = resolve(dist, `.${new URL(c.req.url).pathname}`);
  if (!path.startsWith(dist + sep) && path !== dist) return c.text("Not found", 404);
  const file = Bun.file(path === dist + sep || path === dist ? join(dist, "index.html") : path);
  if (!(await file.exists())) return c.text("Not found", 404);
  return new Response(file, { headers: { "Cache-Control": "no-store" } });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.TCG_BROWSER_PORT ?? "0"), fetch: app.fetch });
writeFileSync(join(root, "server-ready.json"), JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }));
console.log(`TCG synthetic loopback server ready on port ${server.port}`);
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  server.stop(true);
  sandboxDb?.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setTimeout(stop, 180_000).unref();
