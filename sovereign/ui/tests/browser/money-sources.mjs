// Browser-only synthetic contract rehearsal. No real node, provider, or credentials.
// Usage: MONEY_UI_ORIGIN=http://127.0.0.1:5182 MONEY_UI_DRIVER=/path/to/playwright-core/index.mjs MONEY_UI_CHROMIUM=/path/to/chrome-headless-shell node tests/browser/money-sources.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
let origin = process.env.MONEY_UI_ORIGIN;
let fixtureServer;
const fixtureRoot = process.env.TCG_BROWSER_ROOT;
if (!origin && fixtureRoot) {
  assert(existsSync(join(fixtureRoot, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
  const dist = resolve(fixtureRoot, 'ui/dist');
  const mime = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.html': 'text/html', '.svg': 'image/svg+xml' };
  fixtureServer = createServer((request, response) => {
    const path = resolve(dist, '.' + new URL(request.url, 'http://127.0.0.1').pathname);
    const file = path === dist ? join(dist, 'index.html') : path;
    if (!file.startsWith(dist + sep) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': mime[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(readFileSync(file));
  });
  await new Promise((ready) => fixtureServer.listen(0, '127.0.0.1', ready));
  fixtureServer.unref();
  origin = `http://127.0.0.1:${fixtureServer.address().port}`;
}
assert(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
const { chromium } = await import(pathToFileURL(process.env.MONEY_UI_DRIVER ?? process.env.TCG_BROWSER_DRIVER).href);
const screenshot = (name) => join(fixtureRoot ?? '/tmp', `cashloom-money-${name}.png`);
const at = '2026-09-29T12:00:00.000Z';
const base = { rail: 'BANK', connector_type: 'plaid', currency: 'USD', decimals: 2, balance_minor: '22550', balance_as_of: at, balance_kind: 'current', available_minor: '22000', pending_minor: null, held_minor: null, read_environment: 'sandbox', account_type: 'depository', external_account_id: null, chain_id: null, asset_id: null, account_ref: null, credential_ref: null, vault_key_id: null, status: 'ACTIVE', created_at: at };
const checking = { ...base, id: 'checking', display_name: 'Sandbox checking', read_connection_id: 'source' };
const savings = { ...base, id: 'savings', display_name: 'Sandbox savings', read_connection_id: 'source' };
const cash = { ...base, id: 'cash', display_name: 'Pocket money', rail: 'CASH', connector_type: null, read_environment: 'local', read_connection_id: null };
const accounts = [checking, savings, cash];
const record = (id, account, amount) => ({ id, account_id: account.id, account_name: account.display_name, title: 'Transfer fixture', amount_minor: amount, currency: 'USD', decimals: 2, date: at, read_environment: 'sandbox' });
const candidate = { outgoing: record('out', checking, '-5000'), incoming: record('in', savings, '5000'), day_gap: 0 };
let candidates = [candidate], links = [], imported = false, configured = true, canManage = true;
let scripts = 0, syncs = 0, exchanges = 0, imports = 0, disconnects = 0;
const errors = [], unexpected = [];
const browser = await chromium.launch({ executablePath: process.env.MONEY_UI_CHROMIUM ?? process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
await context.addInitScript(() => sessionStorage.setItem('cashloom.session', 'synthetic-browser-session'));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.href === 'https://cdn.plaid.com/link/v2/stable/link-initialize.js') {
    scripts++;
    return route.fulfill({ contentType: 'application/javascript', body: `window.Plaid={create(options){ window.fixturePlaidOptions=options; return {open(){ const b=document.createElement('button'); b.id='complete-test-link'; b.textContent='Complete synthetic Link'; b.onclick=()=>options.onSuccess('synthetic-public-token'); document.body.appendChild(b); }, destroy(){document.getElementById('complete-test-link')?.remove();} }; }};` });
  }
  if (url.origin !== origin) { unexpected.push(url.origin); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/')) return route.continue();
  if (path === '/api/meta') return json({ name: 'Synthetic CashLoom', mode: 'sovereign', version: 'fixture', initialized: true, unlocked: true, db: 'synthetic' });
  if (path === '/api/vault/session') return json({ serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  if (path === '/api/vault/lock') return json({ ok: true });
  if (path === '/api/accounts') return json({ accounts: accounts.map((account) => account.connector_type === 'plaid' ? { ...account, read_connection_status: disconnects ? 'disconnected' : 'active' } : account) });
  if (path === '/api/vault/keys') return json({ keys: [] });
  if (path === '/api/analytics/summary') return json({ accounts: [] });
  if (path === '/api/wallet/v3/positions') return json({ base_accounts: [] });
  if (path === '/api/wallet/v3/integrations') return json({ generated_at: at, integrations: [] });
  if (path === '/api/connections') return json({ schema_version: 'cashloom.connections/1', generated_at: at, can_manage: canManage, sources: [{ id: 'item', provider: 'plaid', environment: 'sandbox', display_name: 'Synthetic test bank', status: disconnects ? 'disconnected' : 'active', last_attempt_at: at, last_success_at: at, last_error_code: null, capabilities: { accounts: true, balances: true, transactions: true, payments: false }, accounts: [checking, savings] }], plaid: { environment: 'sandbox', configured, items: [{ id: 'item', label: 'Synthetic test bank', state: disconnects ? 'disconnected' : 'connected', account_count: 2, last_synced_at: at, error_code: null }] } });
  if (path === '/api/connections/plaid/link') return json({ environment: 'sandbox', attempt_id: 'attempt', link_token: 'synthetic-link-token', expires_at: at });
  if (path === '/api/connections/plaid/exchange') { exchanges++; assert.deepEqual(request.postDataJSON(), { attempt_id: 'attempt', public_token: 'synthetic-public-token' }); return json({ item_id: 'item', account_count: 2, state: 'connected', replayed: false }); }
  if (path === '/api/connections/plaid/item/sync') { syncs++; return json({ item_id: 'item', imported: 1, updated: 0, removed: 0 }); }
  if (path === '/api/connections/plaid/item/disconnect') { disconnects++; return json({ item_id: 'item', local_disabled: true, provider_revoked: true, state: 'disconnected' }); }
  if (path === '/api/transactions') return json({ transactions: [{ id: 'entry', account_id: 'checking', title: imported ? 'Imported fixture' : 'Test fixture', amount_minor: '-5000', date: at, category: null, source: 'CONNECTOR', status: 'posted', transfer_link_id: links[0]?.id ?? null }] });
  if (path === '/api/transactions/import/preview') return json({ preview_hash: 'review-hash', account_id: request.postDataJSON().account_id, currency: 'USD', decimals: 2, row_count: 1, duplicate_count: 0, distinct_rows: [], rows: [{ row_id: 'row', external_id: 'row', matched_existing: false, already_recorded: false, distinct_reference: null, date: at, title: 'Reviewed import', amount_minor: '-4250', currency: 'USD', category: 'Food' }] });
  if (path === '/api/transactions/import') { imports++; assert.equal(request.postDataJSON().preview_hash, 'review-hash'); assert.equal(request.postDataJSON().account_id, 'cash'); imported = true; return json({ imported: 1, skipped: 0, account_id: 'cash' }); }
  if (path === '/api/transactions/export') return json({ schema_version: 'cashloom.activity-export/1', transactions: [] });
  if (path === '/api/transfers') return json({ can_manage: canManage, candidates, links });
  if (path === '/api/transfers/link') { assert.deepEqual(request.postDataJSON(), { outgoing_id: 'out', incoming_id: 'in' }); const link = { id: 'linked', outgoing_id: 'out', incoming_id: 'in', created_at: at, outgoing: candidate.outgoing, incoming: candidate.incoming }; links = [link]; candidates = []; return json({ link }); }
  if (path === '/api/transfers/linked/unlink') { links = []; candidates = [candidate]; return json({ ok: true }); }
  unexpected.push(path); return json({ error: 'Unexpected synthetic route' }, 404);
});
await context.routeWebSocket('**/*', (socket) => socket.close());
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
page.setDefaultTimeout(8000);
const nav = (name) => page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
try {
  await page.goto(`${origin}/#/connections`);
  await page.getByRole('heading', { name: 'Where your money lives' }).waitFor();
  await page.getByRole('heading', { name: 'Pocket money', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Synthetic test bank', exact: true }).count(), 1, 'Each bank has one combined status, control and balance card');
  assert.equal(scripts, 0); assert.equal(exchanges, 0); assert.equal(syncs, 0);
  await page.screenshot({ path: screenshot('connections-1280'), fullPage: true });
  await nav('Accounts');
  assert.equal(await page.getByRole('article', { name: 'Sandbox checking', exact: true }).getByRole('button', { name: 'Archive', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('article', { name: 'Pocket money', exact: true }).getByRole('button', { name: 'Archive', exact: true }).isDisabled(), false);
  await nav('Connections');
  await page.getByRole('button', { name: 'Connect a test bank', exact: true }).click();
  await page.getByRole('button', { name: 'Complete synthetic Link' }).click();
  await page.getByText('Test bank linked.', { exact: false }).waitFor();
  assert.equal(scripts, 1); assert.equal(exchanges, 1);
  assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes('synthetic-public-token')), false);
  await page.getByRole('button', { name: 'Sync test accounts' }).click();
  await page.getByText('Test account sync finished.', { exact: false }).waitFor(); assert.equal(syncs, 1);
  await page.getByRole('button', { name: 'Review disconnect' }).click(); assert.equal(disconnects, 0);
  await page.getByRole('button', { name: 'Keep connected' }).click(); assert.equal(disconnects, 0);
  await page.getByRole('button', { name: 'Review disconnect' }).click();
  await page.getByRole('button', { name: 'Confirm disconnect' }).click();
  await page.getByText('Test bank disconnected.', { exact: false }).waitFor(); assert.equal(disconnects, 1);
  await page.getByText('This connection is disconnected;', { exact: false }).waitFor();
  await nav('Accounts');
  assert.equal(await page.getByRole('article', { name: 'Sandbox checking', exact: true }).getByRole('button', { name: 'Archive', exact: true }).isDisabled(), false);
  await nav('Activity');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const csv = page.getByLabel('Or paste CSV');
  await csv.fill('date,title,amount,currency\n2026-09-29,Food,-42.50,USD');
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await page.getByText('Reviewed import', { exact: true }).waitFor(); assert.equal(imports, 0);
  await csv.fill('date,title,amount,currency\n2026-09-29,Food,-42.51,USD');
  assert.equal(await page.getByRole('button', { name: /^Confirm import into/ }).count(), 0);
  await page.getByRole('button', { name: 'Preview import', exact: true }).click();
  await page.getByRole('button', { name: /^Confirm import into/ }).click();
  await page.getByText('1 entries imported;', { exact: false }).waitFor(); assert.equal(imports, 1);
  await page.getByText('Imported fixture', { exact: false }).waitFor();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export all activity (JSON)' }).click(); assert.equal((await download).suggestedFilename(), 'cashloom-activity.json');
  await page.getByRole('button', { name: 'Review internal transfers' }).click();
  await page.getByRole('button', { name: 'Review match' }).click();
  assert.equal(await page.getByRole('button', { name: 'Confirm transfer link' }).isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Both accounts belong to me', exact: false }).check();
  await page.getByRole('button', { name: 'Confirm transfer link' }).click();
  await page.getByRole('button', { name: 'Review unlink' }).click();
  await page.getByRole('checkbox', { name: 'Remove this transfer label.', exact: false }).check();
  await page.getByRole('button', { name: 'Confirm unlink' }).click();
  await page.getByText('Transfer link removed.', { exact: false }).waitFor(); assert.equal(links.length, 0);
  for (const name of ['Connections', 'Accounts', 'Activity', 'Overview']) {
    await page.setViewportSize({ width: 390, height: 844 }); await nav(name);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} must fit mobile`);
    await page.screenshot({ path: screenshot(`${name.toLowerCase()}-390`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await nav('Connections');
  configured = false; await page.getByRole('button', { name: 'Reload saved status' }).click();
  await page.getByText('Plaid sandbox is not configured', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect a test bank', exact: true }).count(), 0);
  configured = true; canManage = false; await page.getByRole('button', { name: 'Reload saved status' }).click();
  await page.getByText('The workspace owner can manage connections.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect a test bank', exact: true }).count(), 0);
  canManage = true; await page.getByRole('button', { name: 'Reload saved status' }).click();
  await page.getByRole('button', { name: 'Connect a test bank', exact: true }).click();
  await page.getByRole('button', { name: 'Complete synthetic Link' }).waitFor();
  await page.getByRole('button', { name: /^Lock/ }).click();
  await page.evaluate(() => window.fixturePlaidOptions.onSuccess('must-not-exchange'));
  await page.waitForTimeout(100); assert.equal(exchanges, 1);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS synthetic Connections, explicit Link loading, sandbox labeling, disconnect review, CSV preview/confirm/invalidation, JSON export, transfer link/unlink, owner gating, lock callback rejection, and 390px overflow checks');
} finally { await context.close(); await browser.close(); fixtureServer?.close(); }
