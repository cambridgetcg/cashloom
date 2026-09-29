// Invoked only by run.py inside its inherited OS no-egress sandbox.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Run via run.py, never against a real node');
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
let server, browser, page, origin;
let dropResponsePath = null, lostCommittedResponse = null;
let serverLog = '';
const failures = [], pageErrors = [], blockedRequests = [], commands = [];
const checks = [];
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function startServer(port = '0') {
  const ready = join(root, 'server-ready.json');
  rmSync(ready, { force: true });
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', join(here, 'server.ts')], {
    cwd: root, env: { ...process.env, TCG_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = (data) => { serverLog = (serverLog + String(data)).slice(-12000); };
  server.stdout.on('data', record); server.stderr.on('data', record);
  for (let i = 0; i < 150; i++) {
    if (existsSync(ready)) {
      const candidate = JSON.parse(readFileSync(ready, 'utf8')).origin;
      const url = new URL(candidate);
      assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
      assert(Number(url.port) > 0, 'No production/default port fallback');
      origin = candidate;
      return;
    }
    if (server.exitCode !== null) throw new Error(`Fixture server failed: ${serverLog}`);
    await delay(50);
  }
  throw new Error(`Fixture server readiness timeout: ${serverLog}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}
async function fixtureStatus() {
  const res = await fetch(origin + '/__fixture/status'); assert.equal(res.status, 200); return res.json();
}
async function api(path, body) {
  assert(path.startsWith('/api/tcg/'), 'Browser helper limited to TCG APIs');
  return page.evaluate(async ({ path, body }) => {
    const token = sessionStorage.getItem('cashloom.session');
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }, { path, body });
}
async function visible(text) { await page.getByText(text, { exact: true }).first().waitFor(); }
async function clickMutation(label, suffix) {
  const result = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(suffix) && res.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click();
  const res = await result;
  const data = await res.json();
  assert(res.ok(), `${label}: HTTP ${res.status()} ${JSON.stringify(data)}`);
  return data;
}
async function login() {
  await page.getByLabel('Passphrase', { exact: true }).fill('synthetic-browser-only');
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views' }).waitFor();
}
async function tradesView() {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Agreements', exact: true }).click();
  await page.getByRole('button', { name: 'New agreement', exact: true }).waitFor();
}
async function listView() {
  await page.getByRole('button', { name: 'All agreements and simulations', exact: true }).click();
  await page.getByRole('button', { name: 'New agreement', exact: true }).waitFor();
}
async function openSimulation(id) {
  await page.getByRole('region', { name: 'Saved simulations' }).locator('li').filter({ has: page.getByText(id, { exact: true }) }).getByRole('button', { name: /^Open simulation:/ }).click();
  await page.getByRole('region', { name: 'Escrow simulation', exact: true }).waitFor();
}
function conserve(run) {
  assert.equal(run.mode, 'simulation'); assert.equal(run.protection, 'unavailable');
  const b = run.state.balances;
  assert.equal(BigInt(b.funded.atomic), BigInt(b.held.atomic) + BigInt(b.released.atomic) + BigInt(b.refunded.atomic));
  assert.equal(b.fee.atomic, '0');
  assert(!(BigInt(b.released.atomic) > 0n && BigInt(b.refunded.atomic) > 0n));
}
async function action(run, type, extra = {}) {
  const permitted = run.permittedActions.find((entry) => entry.command.type === type && Object.entries(extra).every(([k, v]) => entry.command[k] === v));
  assert(permitted, `Missing permitted ${type} ${JSON.stringify(extra)} in ${JSON.stringify(run.permittedActions)}`);
  const label = permitted.label.startsWith('Simulate') ? permitted.label : `Simulate ${permitted.label}`;
  const { simulation } = await clickMutation(label, `/simulations/${run.id}/commands`);
  conserve(simulation);
  await visible('Simulation — no funds held or protected.');
  return simulation;
}
async function blocked(run, type, code) {
  assert(!run.permittedActions.some((entry) => entry.command.type === type), `${type} must not be rendered as permitted`);
  const result = await api(`/api/tcg/simulations/${run.id}/commands`, { expectedVersion: run.version, idempotencyKey: randomUUID(), command: { type } });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, code);
  const current = await api(`/api/tcg/simulations/${run.id}`);
  assert.equal(current.data.simulation.version, run.version);
  assert.deepEqual(current.data.simulation.state, run.state);
}
async function screenshot(name, selector = '[aria-label="Escrow simulation"]') {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
  });
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector);
    if (!panel || panel.getBoundingClientRect().width <= 0 || panel.getBoundingClientRect().height <= 0) return false;
    for (let element = panel; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (Number(style.opacity) < 1 || style.visibility !== 'visible' || style.display === 'none') return false;
    }
    return true;
  }, selector);
  await page.screenshot({ path: join(root, name), fullPage: true, animations: 'disabled' });
}
async function storage() {
  return page.evaluate(async () => ({
    local: { ...localStorage }, session: { ...sessionStorage },
    indexedDB: indexedDB.databases ? await indexedDB.databases() : [],
    caches: await caches.keys(),
  }));
}
async function assertNoTradePersistence() {
  const state = await storage();
  assert.deepEqual(state.local, {});
  assert.deepEqual(Object.keys(state.session), ['cashloom.session']);
  assert.deepEqual(state.indexedDB, []); assert.deepEqual(state.caches, []);
  return state;
}

try {
  await startServer();
  const baseline = await fixtureStatus();
  assert.equal(baseline.sandboxExists, false); assert(baseline.walletTables > 20);
  assert.equal(baseline.positions[0].observed_atomic, '123456');
  browser = await chromium.launch({
    executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-first-run', '--metrics-recording-only'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blockedRequests.push(route.request().url()); return route.abort('blockedbyclient'); }
    if (dropResponsePath === url.pathname && route.request().method() === 'POST') {
      dropResponsePath = null;
      // Commit through the actual backend, then discard only the response.
      // This deliberately exercises the view's same-key transport retry.
      const response = await route.fetch();
      lostCommittedResponse = { status: response.status(), data: await response.json() };
      return route.abort('failed');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', (ws) => { blockedRequests.push(ws.url()); ws.close(); });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => pageErrors.push(error.stack || String(error)));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/tcg/')) {
      commands.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    }
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await screenshot('gate-desktop.png', '.gate-card');
  await login();
  const navigate = async (name) => {
    await page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
  };
  await navigate('Signing keys');
  await page.getByRole('button', { name: 'Use in an account', exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 248, 242)');
  assert.equal(await page.locator('.btn-primary').first().evaluate((button) => getComputedStyle(button).backgroundColor), 'rgb(37, 91, 70)');
  await screenshot('keys-desktop.png', '.key-forms');
  assert.equal(await page.getByRole('button', { name: 'Use in an account', exact: true }).count(), 1, 'Record-signing keys have no payment handoff');
  await page.getByRole('button', { name: 'Use in an account', exact: true }).click();
  assert.equal(await page.getByLabel('Vault key', { exact: true }).inputValue(), 'fixture-key');
  assert.equal(await page.getByLabel('Asset & network', { exact: true }).inputValue(), 'BASE_ETH');
  assert.equal((await fixtureStatus()).nonTcgMutationAttempts, 0, 'Key handoff must not create an account automatically');
  pass('Keys hands its selected key to account setup without creating anything');

  await page.getByRole('article', { name: 'Synthetic pocket', exact: true }).getByRole('button', { name: 'Record balance', exact: true }).click();
  const balanceForm = page.getByRole('form', { name: 'Record balance for Synthetic pocket', exact: true });
  await balanceForm.getByLabel('Balance (GBP)', { exact: true }).fill('42.19');
  await screenshot('account-balance-form.png', '.create-form');
  const balanceSaved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/accounts/fixture-cash/balance');
  await balanceForm.getByRole('button', { name: 'Record balance', exact: true }).click();
  assert.equal((await balanceSaved).status(), 200);
  await balanceForm.waitFor({ state: 'hidden' });
  assert.equal((await fixtureStatus()).balanceObservations, 1);
  await navigate('Overview');
  const pocketCard = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic pocket', exact: true }) });
  await pocketCard.getByText('42.19', { exact: false }).waitFor();
  await pocketCard.getByRole('button', { name: 'Open Activity', exact: true }).click();
  await page.getByRole('button', { name: '+ record an entry', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic coffee');
  await page.getByLabel('Amount', { exact: true }).fill('2.50');
  await page.getByLabel('Date', { exact: true }).fill('2026-09-23');
  await screenshot('activity-entry-form.png', '.entry-form');
  const entrySaved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/transactions' && response.request().method() === 'POST');
  await page.locator('form.entry-form').getByRole('button', { name: 'Record', exact: true }).click();
  const entryResponse = await entrySaved;
  assert.equal(entryResponse.status(), 200);
  const entry = await entryResponse.json();
  assert.equal(entry.transaction.account_id, 'fixture-cash');
  assert.equal(entry.transaction.amount_minor, '-250');
  assert.match(entry.transaction.date, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  await navigate('Overview');
  await pocketCard.getByText('42.19', { exact: false }).waitFor();
  pass('Ledger records the selected account, exact amount and calendar date without changing its observed balance');
  await navigate('Accounts');
  pass('An explicit manual balance observation appears in Overview without a payment or inferred opening balance');

  const usdcAccount = page.getByRole('article', { name: 'Synthetic Base USDC', exact: true });
  await usdcAccount.getByRole('button', { name: 'Send money', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select')?.value === 'fixture-base-usdc');
  assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), 'fixture-base-usdc');
  assert.equal(new URL(page.url()).hash, '#/pay');
  assert(!page.url().includes('fixture-'), 'Private context must not enter URLs');
  const [ledgerResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/transactions'),
    page.getByRole('button', { name: 'Open activity', exact: true }).click(),
  ]);
  assert.equal(new URL(ledgerResponse.url()).searchParams.get('accountId'), 'fixture-base-usdc');
  assert.equal(new URL(page.url()).hash, '#/ledger');
  assert.equal(await page.locator('select').last().inputValue(), 'fixture-base-usdc');
  await page.goBack();
  await page.getByRole('heading', { name: 'Send money', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('select')?.value === 'fixture-base-usdc');
  assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), 'fixture-base-usdc', 'Back must retain the account selected in this session');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Send money', exact: true }).waitFor();
  pass('Accounts to Pay to Ledger preserves selection; browser back and reload reopen the view without private URL data');

  await navigate('Accounts');
  await page.getByRole('article', { name: 'Synthetic Base USDC', exact: true }).getByRole('button', { name: 'Receive money', exact: true }).click();
  await visible('Receiving into Synthetic Base USDC · USDC on Base.');
  await page.getByRole('button', { name: 'Copy address', exact: true }).waitFor();
  await screenshot('receive-desktop.png', '.receive-card');
  assert.equal(await page.locator('.receive-card').count(), 1);
  pass('Receive keeps the selected account, asset and network together');

  await navigate('Send money');
  await page.getByRole('button', { name: 'Review recovery', exact: true }).click();
  await screenshot('payment-review-desktop.png', '[aria-labelledby="payment-recovery-title"]');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Payment recovery review must fit narrow mobile');
  await screenshot('payment-review-mobile.png', '[aria-labelledby="payment-recovery-title"]');
  await page.setViewportSize({ width: 1280, height: 1000 });
  assert.equal((await fixtureStatus()).recoveryAttempts, 0, 'Review is read-only');
  dropResponsePath = '/api/pay/recover';
  await page.getByRole('button', { name: 'Rebroadcast this transaction', exact: true }).click();
  await page.getByRole('button', { name: 'Check Base now', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  assert.equal((await fixtureStatus()).recoveryAttempts, 1, 'Lost recovery response must not trigger an automatic retry');
  assert.equal(await page.getByRole('button', { name: 'Review recovery', exact: true }).count(), 0);
  pass('Recovery requires review and explicit confirmation; a lost response reloads saved truth without rebroadcasting twice');

  await navigate('Connections');
  await page.getByText('Advanced connection readiness', { exact: true }).click();
  await page.locator('.integration-card').first().waitFor();
  await page.getByText('Capabilities and limits', { exact: true }).first().click();
  await screenshot('connections-desktop.png', '.integration-grid');
  await navigate('Zerone network');
  await page.getByText('Synthetic network status for visual checks.', { exact: true }).waitFor();
  await page.getByRole('button', { name: "I'm an agent", exact: true }).click();
  assert.equal(await page.getByRole('button', { name: "I'm an agent", exact: true }).getAttribute('aria-pressed'), 'true');
  await screenshot('zerone-desktop.png', '.zerone-view');
  pass('Shared light theme covers Gate, forms, payment review, connections and advanced network views');

  await tradesView();
  assert.equal((await fixtureStatus()).sandboxExists, false);
  await assertNoTradePersistence();
  pass('native Gate unlock and empty Trades; sandbox database remains lazy');

  // Positive operations below use the actual native UI. Only explicit negative
  // transition checks and durable state assertions use browser-origin fetch.
  await page.getByRole('button', { name: 'New agreement', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic card sale');
  await page.getByLabel('Origin channel', { exact: true }).fill('Offline browser fixture');
  await page.getByLabel('Buyer label', { exact: true }).fill('Reported buyer');
  await page.getByLabel('Seller label', { exact: true }).fill('Reported seller');
  await page.getByLabel(/^Quote asset(?! type)/).selectOption('iso4217:GBP');
  assert.equal(await page.getByLabel('Currency code', { exact: true }).inputValue(), 'GBP');
  assert.equal(await page.getByLabel('Decimals', { exact: false }).inputValue(), '2');
  await page.getByLabel('Game', { exact: true }).fill('Synthetic TCG');
  await page.getByLabel('Card name', { exact: true }).fill('Synthetic card alpha');
  await page.getByLabel('Unit price', { exact: false }).fill('12.34');
  await page.getByLabel('Condition description', { exact: true }).fill('Owner reports near mint, unverified');
  await page.getByLabel('Shipping amount', { exact: true }).fill('2.50');
  await page.getByLabel('Shipping responsibility', { exact: true }).fill('Seller packages and dispatches; delivery is separately reported');
  await page.getByLabel('Dispute terms', { exact: true }).fill('Report condition disagreement during inspection');
  await page.getByLabel('Return terms', { exact: true }).fill('Return authorization, dispatch, receipt, and refund are distinct');
  await page.getByLabel('Proposal expiry (ISO time with timezone)', { exact: true }).fill('2099-01-01T00:00:00.000Z');
  let { trade } = await clickMutation('Save agreement', '/api/tcg/trades');
  assert.equal(trade.mode, 'record'); assert.equal(trade.protection, 'unavailable');
  assert.equal(trade.current.totals.total.atomic, '1484');
  const tradeId = trade.id, firstHash = trade.current.hash;
  await visible('Record only — no escrow protection.');
  pass('native shipped-card creation with exact GBP total 14.84');

  // Detail and evidence selectors are intentionally accessible labels/buttons,
  // not coupled to React internals or synthetic replacement components.
  await page.getByLabel('Evidence kind', { exact: false }).selectOption('payment');
  const evidenceText = 'Owner-reported synthetic payment <script>not executable</script>';
  await page.getByLabel('Evidence text', { exact: false }).fill(evidenceText);
  await page.getByLabel('Source references', { exact: false }).fill('https://example.invalid/evidence-not-fetched');
  dropResponsePath = `/api/tcg/trades/${tradeId}/evidence`;
  await page.getByRole('button', { name: 'Record evidence', exact: true }).click();
  await page.getByRole('button', { name: 'Retry exact request', exact: true }).waitFor();
  assert(lostCommittedResponse?.status < 300, 'Lost response follows a successful real backend commit');
  const firstEvidenceAttempt = structuredClone(commands.at(-1));
  assert.equal(await page.getByRole('button', { name: 'Record evidence', exact: true }).isDisabled(), true);
  ({ trade } = await clickMutation('Retry exact request', `/trades/${tradeId}/evidence`));
  assert.deepEqual(commands.at(-1), firstEvidenceAttempt, 'Transport retry must reuse exact key, version, and payload');
  assert.equal(trade.evidence.length, 1);
  pass('lost committed evidence response retries exact key and cannot append twice');
  assert.equal(trade.evidence[0].provenance, 'owner_reported');
  assert.equal(trade.evidence[0].revision, 1); assert.equal(trade.evidence[0].agreementHash, firstHash);
  await visible(evidenceText);
  assert.equal(await page.locator('script').filter({ hasText: 'not executable' }).count(), 0);
  await page.getByRole('button', { name: 'Edit current terms', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic card sale revised');
  await page.getByLabel('Unit price', { exact: false }).fill('24.68');
  ({ trade } = await clickMutation('Save new revision', `/trades/${tradeId}/revisions`));
  assert.equal(trade.currentRevision, 2); assert.notEqual(trade.current.hash, firstHash);
  assert.equal(trade.current.totals.total.atomic, '2718');
  assert.equal(trade.evidence[0].revision, 1); assert.equal(trade.evidence[0].agreementHash, firstHash);
  await assertNoTradePersistence();
  pass('reported plain-text evidence and immutable new revision preserve original hash binding');

  await page.reload({ waitUntil: 'networkidle' }); await tradesView();
  await page.getByRole('button', { name: 'Open agreement: Synthetic card sale revised', exact: true }).click();
  await visible(evidenceText);
  pass('reload and reopen retain revised agreement and original evidence');

  let { simulation: sale } = await clickMutation('Try escrow simulation', '/api/tcg/simulations');
  assert.equal(sale.snapshot.revision, 2); conserve(sale);
  assert.equal((await fixtureStatus()).sandboxExists, true);
  sale = await action(sale, 'accept', { simulatedRole: 'buyer' });
  sale = await action(sale, 'accept', { simulatedRole: 'seller' });
  sale = await action(sale, 'fund');
  assert.equal(sale.state.funding, 'pending');
  sale = await action(sale, 'advance_operation', { outcome: 'complete' });
  sale = await action(sale, 'dispatch');
  await blocked(sale, 'request_release', 'INVALID_TRANSITION');
  pass('dispatch does not authorize release despite owner-reported real payment');
  sale = await action(sale, 'deliver');
  sale = await action(sale, 'accept_inspection');
  sale = await action(sale, 'request_release');
  assert.equal(sale.state.settlement, 'release_pending');
  const operationId = sale.state.operation.id;
  sale = await action(sale, 'advance_operation', { outcome: 'unknown' });
  assert.equal(sale.state.operation.id, operationId); assert.equal(sale.state.settlement, 'unknown');
  await blocked(sale, 'request_refund', 'RECONCILIATION_REQUIRED');
  await blocked(sale, 'request_release', 'RECONCILIATION_REQUIRED');
  await screenshot('unknown-outcome.png');
  pass('unknown release retains stable operation ID and blocks conflicting settlement');

  const port = new URL(origin).port;
  await stopServer(); await startServer(port);
  await page.reload({ waitUntil: 'networkidle' });
  // Existing browser credential is intentionally invalid after fixture restart.
  // A TCG request must drop it and unmount private state before re-authentication.
  await page.getByLabel('Passphrase', { exact: true }).waitFor();
  assert.deepEqual((await storage()).session, {});
  await login(); await tradesView();
  await openSimulation(sale.id);
  const durable = await api(`/api/tcg/simulations/${sale.id}`);
  assert.equal(durable.data.simulation.state.operation.id, operationId);
  assert.equal(durable.data.simulation.state.settlement, 'unknown');
  sale = durable.data.simulation;
  sale = await action(sale, 'reconcile_operation');
  assert.equal(sale.state.settlement, 'released'); assert.equal(sale.state.balances.released.atomic, '2718');
  assert.equal(sale.state.balances.held.atomic, '0');
  const replay = commands.at(-1);
  const replayResult = await api(replay.path, replay.body);
  assert.equal(replayResult.status, 200); assert.equal(replayResult.data.simulation.version, sale.version);
  assert.deepEqual(replayResult.data.simulation.state, sale.state);
  pass('service restart retains unknown operation; native reconciliation completes sale exactly once');

  await listView();
  await page.getByRole('button', { name: 'Open agreement: Synthetic card sale revised', exact: true }).click();
  let { simulation: dispute } = await clickMutation('Try escrow simulation', '/api/tcg/simulations');
  assert.notEqual(dispute.id, sale.id, 'Second native run was created');
  dispute = await action(dispute, 'accept', { simulatedRole: 'buyer' });
  dispute = await action(dispute, 'accept', { simulatedRole: 'seller' });
  dispute = await action(dispute, 'fund');
  dispute = await action(dispute, 'advance_operation', { outcome: 'complete' });
  dispute = await action(dispute, 'dispatch');
  dispute = await action(dispute, 'deliver');
  dispute = await action(dispute, 'open_dispute');
  await blocked(dispute, 'request_release', 'INVALID_TRANSITION');
  dispute = await action(dispute, 'authorize_return');
  assert.equal(dispute.state.return, 'authorized'); assert.equal(dispute.state.settlement, 'none');
  dispute = await action(dispute, 'dispatch_return');
  assert.equal(dispute.state.return, 'dispatched'); assert.equal(dispute.state.balances.refunded.atomic, '0');
  dispute = await action(dispute, 'receive_return');
  assert.equal(dispute.state.return, 'received'); assert.equal(dispute.state.balances.refunded.atomic, '0');
  dispute = await action(dispute, 'authorize_refund');
  assert.equal(dispute.state.dispute, 'refund_authorized'); assert.equal(dispute.state.settlement, 'none');
  dispute = await action(dispute, 'request_refund');
  assert.equal(dispute.state.settlement, 'refund_pending');
  dispute = await action(dispute, 'advance_operation', { outcome: 'complete' });
  assert.equal(dispute.state.settlement, 'refunded'); assert.equal(dispute.state.balances.refunded.atomic, '2718');
  assert.equal(dispute.state.balances.released.atomic, '0');
  pass('native condition dispute blocks release and completes distinct return/refund steps');

  await listView();
  await page.getByRole('button', { name: 'Open agreement: Synthetic card sale revised', exact: true }).click();
  await page.getByRole('button', { name: 'Edit current terms', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Synthetic card sale revision three');
  ({ trade } = await clickMutation('Save new revision', `/trades/${tradeId}/revisions`));
  assert.equal(trade.currentRevision, 3);
  await listView(); await openSimulation(dispute.id);
  const all = await api('/api/tcg/simulations');
  assert(all.data.simulations.every((run) => run.staleRevision && run.snapshot.revision === 2));
  assert.equal(trade.evidence.length, 1); assert.equal(trade.evidence[0].revision, 1);
  await visible('Source-revision mismatch: this run remains bound to revision 2; the source is now revision 3. Nothing has been rebound or reaccepted.');
  await page.reload({ waitUntil: 'networkidle' }); await tradesView(); await openSimulation(dispute.id);
  const persistedRuns = await api('/api/tcg/simulations');
  assert.equal(persistedRuns.data.simulations.find((run) => run.id === sale.id).state.settlement, 'released');
  assert.equal(persistedRuns.data.simulations.find((run) => run.id === dispute.id).state.settlement, 'refunded');
  pass('source revision advances without rebinding simulations; both completed outcomes survive reload');

  // Seed only additional synthetic owner records through the actual API; the
  // original deal and both financial rehearsals above were driven natively.
  // This places the original deal beyond two 50-row pages without 100 forms.
  for (let i = 1; i <= 100; i++) {
    const seeded = await api('/api/tcg/trades', {
      expectedVersion: 0, idempotencyKey: randomUUID(),
      terms: { ...trade.current.terms, title: `Synthetic pagination ${String(i).padStart(3, '0')}` },
    });
    assert(seeded.status < 300, `Synthetic pagination create ${i} failed`);
  }
  await page.reload({ waitUntil: 'networkidle' }); await tradesView();
  const oldDealButton = page.getByRole('button', { name: 'Open agreement: Synthetic card sale revision three', exact: true });
  assert.equal(await oldDealButton.count(), 0, 'Original deal should begin beyond the first page');
  let pages = 0;
  while (!(await oldDealButton.count()) && pages < 10) {
    await page.getByRole('button', { name: 'Load more agreements', exact: true }).click();
    await page.getByRole('button', { name: 'Reload latest', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Saved agreements"]')?.textContent?.includes('Loading more'));
    // Await the local page response/render, not a guessed sleep.
    const list = page.getByRole('region', { name: 'Saved agreements', exact: true });
    await list.locator('li.card').nth(Math.min((pages + 2) * 50, 101) - 1).waitFor();
    pages++;
  }
  assert.equal(await page.getByRole('region', { name: 'Saved agreements', exact: true }).locator('li.card').count(), 101);
  await oldDealButton.click();
  await visible(tradeId); await visible(evidenceText);
  await page.setViewportSize({ width: 390, height: 844 });
  await visible(tradeId); await visible(evidenceText);
  assert.equal(await page.getByRole('region', { name: 'Saved owner record', exact: true }).getByRole('heading', { name: 'Synthetic card sale revision three', exact: true }).count(), 1);
  pass(`101 saved records discoverable after ${pages} Load more actions; desktop/mobile selected deal remains stable`);
  await listView(); await openSimulation(dispute.id);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, 'Mobile page must not overflow horizontally');
  await screenshot('mobile-refunded.png');
  await assertNoTradePersistence();
  const finalStatus = await fixtureStatus();
  assert.equal(finalStatus.walletDigest, baseline.walletDigest);
  assert.equal(finalStatus.nonTcgMutationAttempts, 0);
  assert(finalStatus.sandboxTables.every((table) => table.name.startsWith('tcg_sim_') || table.name === 'sqlite_sequence'));
  assert.deepEqual(blockedRequests, [], 'UI must not attempt external resource fetching');
  assert.deepEqual(pageErrors, [], 'No browser runtime errors');
  pass('mobile layout, browser storage, sandbox separation, and every wallet table unchanged');

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.getByRole('navigation', { name: 'Views', exact: true }).locator('button').evaluateAll((buttons) => buttons.map((button) => {
      const r = button.getBoundingClientRect(); return { label: button.textContent, left: r.left, right: r.right, height: r.height };
    }));
    assert.equal(geometry.length, 9);
    for (const rect of geometry) assert(rect.left >= 0 && rect.right <= width && rect.height >= 44, `${width}px navigation target clipped: ${JSON.stringify(rect)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  pass('All wallet destinations remain visible and reachable at desktop and narrow mobile widths');

  for (const [label, selector] of [
    ['Overview', '.workspace-intro'], ['Accounts', '.account-rows'], ['Activity', '.ledger-toolbar'],
    ['Send money', '.pay-form'], ['Receive money', '.receive-list'], ['Agreements', '.trade-toolbar'],
    ['Connections', '.money-source-grid'], ['Signing keys', '.key-forms'], ['Zerone network', '.zerone-view .grid2'],
  ]) {
    await navigate(label);
    await page.locator(selector).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} must fit at 320px`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 248, 242)');
  }
  await screenshot('zerone-mobile.png', '.zerone-view');
  pass('Every private module retains the shared light surface without narrow-mobile page overflow');

  await page.getByRole('button', { name: 'Lock', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Passphrase', { exact: true }).waitFor();
  const locked = await storage();
  assert.deepEqual(locked.session, {}); assert.deepEqual(locked.local, {});
  assert.equal(await page.getByText(evidenceText, { exact: true }).count(), 0);
  pass('keyboard lock unmounts trade evidence and removes the existing session token');
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(failures.at(-1));
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(root, 'failure-page.txt'), (await page.locator('body').innerText().catch(() => '')).slice(0, 16000));
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  writeFileSync(join(root, 'server.log'), serverLog);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ checks, failures, pageErrors, blockedRequests, mutationCount: commands.length }, null, 2));
  console.log(`Browser checks: ${checks.length} passed, ${failures.length} failed; processes stopped`);
}
