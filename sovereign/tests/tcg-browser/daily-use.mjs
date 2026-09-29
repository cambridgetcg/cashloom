// Actual node rehearsal, invoked by run.py with temporary HOME/data and no egress.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
const nodeRoot = join(root, 'node', 'sovereign');
const originalData = join(root, 'daily-data');
const restoredData = join(root, 'daily-restored');
const backupDir = join(root, 'daily-backup');
mkdirSync(originalData, { mode: 0o700 });
const passphrase = randomUUID() + randomUUID();
const checks = [], pageErrors = [], forbiddenRequests = [];
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, browser, context, page, origin, output = '';
let failSessionRead = false;
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }

async function start(data, port = '0') {
  output = '';
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', join(nodeRoot, 'src/index.ts')], {
    // Intentionally outside sovereign: installed UI paths must be cwd-independent.
    cwd: join(root, 'home'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CASHLOOM_DATA_DIR: data, CASHLOOM_BIND: '127.0.0.1', CASHLOOM_PORT: String(port), CASHLOOM_BASE_RECONCILIATION_ENABLED: '0' },
  });
  const record = (chunk) => { output = (output + String(chunk)).slice(-12000); };
  server.stdout.on('data', record); server.stderr.on('data', record);
  for (let n = 0; n < 200; n++) {
    const match = output.match(/cashloom sovereign · (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) { assert(Number(match[2]) > 0); origin = match[1]; return; }
    if (server.exitCode !== null) throw new Error('Isolated node exited before readiness: ' + output);
    await delay(50);
  }
  throw new Error('Isolated node readiness timed out');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}
async function cli(args) {
  const child = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', join(nodeRoot, 'src/local-data/cli.ts'), ...args], {
    cwd: join(root, 'home'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let report = '';
  child.stdout.on('data', (chunk) => { report += String(chunk); });
  child.stderr.on('data', (chunk) => { report += String(chunk); });
  const result = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(result, 0, 'Local-data command failed: ' + report);
}
async function api(path, body) {
  assert(/^\/api\/(accounts|transactions|vault\/keys|vault\/lock|tcg\/)/.test(path), 'Rehearsal cannot invoke payment or provider routes');
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('cashloom.session')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body });
}
async function navigate(name) {
  await page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function unlock() {
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
}
async function returnCheck() {
  const checked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/vault/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await checked;
}

try {
  await start(originalData);
  browser = await chromium.launch({ executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || /\/api\/(pay\/|.*\/sync$|.*\/refresh$|zerone)/.test(url.pathname)) {
      forbiddenRequests.push(url.pathname); return route.abort('blockedbyclient');
    }
    if (failSessionRead && url.pathname === '/api/vault/session') {
      failSessionRead = false; return route.abort('failed');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', (socket) => { forbiddenRequests.push('websocket'); socket.close(); });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => pageErrors.push(error.stack || String(error)));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Create your private workspace', exact: true }).waitFor();
  assert.equal(existsSync(join(originalData, 'tcg-sandbox.db')), false);
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Add an account', exact: true }).click();
  pass('Actual node starts outside its source directory and initializes a fresh isolated vault through the UI');

  await page.getByLabel('Name', { exact: true }).fill('Daily pilot pocket');
  await page.getByLabel('Currency', { exact: true }).fill('GBP');
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/accounts' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 201);
  const account = (await createdResponse.json()).account;
  const pocket = page.getByRole('article', { name: 'Daily pilot pocket', exact: true });
  await pocket.getByRole('button', { name: 'Record balance', exact: true }).click();
  const balance = page.getByRole('form', { name: 'Record balance for Daily pilot pocket', exact: true });
  await balance.getByLabel('Balance (GBP)', { exact: true }).fill('57.25');
  await balance.getByRole('button', { name: 'Record balance', exact: true }).click();
  await balance.waitFor({ state: 'hidden' });
  await pocket.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: '+ record an entry', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Daily pilot tea');
  await page.getByLabel('Amount', { exact: true }).fill('3.40');
  await page.getByLabel('Date', { exact: true }).fill('2026-03-14');
  const recorded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/transactions' && response.request().method() === 'POST');
  await page.locator('form.entry-form').getByRole('button', { name: 'Record', exact: true }).click();
  const recordedResponse = await recorded;
  assert.equal(recordedResponse.status(), 201);
  const recordedDate = (await recordedResponse.json()).transaction.date;
  const localDay = await page.evaluate((iso) => {
    const date = new Date(iso);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  }, recordedDate);
  assert.deepEqual(localDay, [2026, 3, 14]);
  assert.equal((await api('/api/accounts')).data.accounts[0].balance_minor, '5725');
  assert.equal((await api('/api/transactions')).data.transactions[0].amount_minor, '-340');
  pass('Actual API persists a manual balance and dated Ledger entry without changing the observed balance');

  await page.getByLabel('Title', { exact: true }).fill('Unsaved return draft');
  await returnCheck();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved return draft');
  failSessionRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: 'Session status is unknown', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).isVisible(), false);
  await page.getByRole('button', { name: 'Check session again', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved return draft');
  pass('Return checks conceal private content on uncertainty and preserve a valid unsaved draft after retry');

  await navigate('Overview'); await navigate('Activity');
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const statement = 'date,title,amount,currency\n2026-03-14,Daily pilot bus,-2.40,GBP';
  const importer = page.getByRole('region', { name: 'Import activity from CSV', exact: true });
  const paste = importer.getByLabel('Or paste CSV');
  const confirmImport = importer.getByRole('button', { name: /^Confirm import into/ });
  const previewImport = async () => {
    await paste.fill(statement);
    await importer.getByRole('button', { name: 'Preview import', exact: true }).click();
    await confirmImport.waitFor();
  };
  await previewImport();
  await importer.getByText('1 will be added; 0 already recorded will be skipped.', { exact: false }).waitFor();
  await confirmImport.click();
  await importer.getByText('1 entries imported; 0 already recorded entries skipped.', { exact: false }).waitFor();
  await previewImport();
  await importer.getByText('0 will be added; 1 already recorded will be skipped.', { exact: false }).waitFor();
  await confirmImport.click();
  await importer.getByText('0 entries imported; 1 already recorded entries skipped.', { exact: false }).waitFor();
  assert.equal((await api('/api/transactions')).data.transactions.length, 2);
  pass('Actual CSV imports require confirmation and skip ordinary matching entries by default');

  await previewImport();
  await importer.getByRole('checkbox', { name: 'Keep as a separate transaction: row 1, Daily pilot bus', exact: true }).check();
  assert.equal(await confirmImport.isDisabled(), true);
  await importer.getByRole('button', { name: 'Update preview', exact: true }).click();
  await importer.getByRole('alert').getByText('Give every separate transaction a reusable reference', { exact: false }).waitFor();
  const reference = importer.getByLabel('Reusable reference for row 1', { exact: true });
  await reference.fill('March statement, line 18');
  await importer.getByRole('button', { name: 'Update preview', exact: true }).click();
  await importer.getByText('Will add · separate transaction', { exact: true }).waitFor();
  assert.equal(await confirmImport.isEnabled(), true);
  await reference.fill('Changed after review');
  assert.equal(await confirmImport.isDisabled(), true);
  await reference.fill('March statement, line 18');
  await importer.getByRole('button', { name: 'Update preview', exact: true }).click();
  await importer.getByText('Will add · separate transaction', { exact: true }).waitFor();
  await page.locator('.toast').first().waitFor({ state: 'hidden' });
  await importer.screenshot({ path: join(root, 'daily-import-reviewed-1280.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Import review must fit mobile');
  const referenceBox = await reference.boundingBox();
  assert(referenceBox && referenceBox.x >= 0 && referenceBox.x + referenceBox.width <= 390, 'Mobile reference controls remain visible without horizontal scrolling');
  await importer.screenshot({ path: join(root, 'daily-import-reviewed-390.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await confirmImport.click();
  await importer.getByText('1 entries imported; 0 already recorded entries skipped.', { exact: false }).waitFor();
  await previewImport();
  await importer.getByRole('checkbox', { name: 'Keep as a separate transaction: row 1, Daily pilot bus', exact: true }).check();
  await importer.getByLabel('Reusable reference for row 1', { exact: true }).fill('March statement, line 18');
  await importer.getByRole('button', { name: 'Update preview', exact: true }).click();
  await importer.getByText('0 will be added; 1 already recorded will be skipped.', { exact: false }).waitFor();
  await confirmImport.click();
  await importer.getByText('0 entries imported; 1 already recorded entries skipped.', { exact: false }).waitFor();
  assert.equal((await api('/api/transactions')).data.transactions.length, 3);
  assert.equal((await api('/api/accounts')).data.accounts[0].balance_minor, '5725');
  pass('A separate matching transaction needs a reusable reference and renewed review; reference replay skips it without changing balances');

  const cryptoAccount = await api('/api/accounts', { display_name: 'Archived pilot ETH', rail: 'CRYPTO', currency: 'ETH', decimals: 18,
    chain_id: 'eip155:8453', asset_id: 'eip155:8453/slip44:60', account_ref: `eip155:8453:0x${'1'.repeat(40)}` });
  assert.equal(cryptoAccount.status, 201);
  const archivedId = cryptoAccount.data.account.id;
  assert.equal((await api('/api/transactions', { account_id: archivedId, title: 'Archived precision check', amount_minor: '-1234567890123456789' })).status, 201);
  assert.equal((await api(`/api/accounts/${archivedId}/archive`, {})).status, 200);
  await navigate('Overview'); await navigate('Activity');
  const row = page.getByRole('row').filter({ hasText: 'Archived precision check' });
  await row.getByText('Archived pilot ETH · archived', { exact: true }).waitFor();
  assert.match(await row.innerText(), /ETH/);
  assert.match(await row.innerText(), /1\.234567890123456789/);
  assert.match(await row.innerText(), /archived/i);
  await page.getByRole('button', { name: '+ record an entry', exact: true }).click();
  assert.equal(await page.getByLabel('Account', { exact: true }).locator(`option[value="${archivedId}"]`).count(), 0);
  assert.equal((await api('/api/transactions', { account_id: archivedId, title: 'Refused archived entry', amount_minor: '1' })).status, 409);
  pass('Archived ETH history retains exact 18-decimal amounts and cannot receive new manual entries');

  // No signer is generated; these are actual private record/simulation endpoints.
  const asset = { kind: 'fiat', currency: 'GBP' };
  const terms = { kind: 'shipped_sale', title: 'Daily pilot card agreement', originChannel: 'manual', ownerRole: 'buyer', buyerLabel: 'Buyer claim', sellerLabel: 'Seller claim', quoteAsset: asset, quoteDecimals: 2,
    items: [{ id: 'pilot-card', representation: 'homogeneous_lot', game: 'Synthetic', cardName: 'Synthetic card', set: 'Unknown', collectorNumber: 'Unknown', language: 'Unknown', variant: 'Unknown', quantity: 1, condition: { description: 'Owner-reported', standard: 'Manual' }, unitPrice: { asset, atomic: '1250' } }],
    shipping: { payer: 'buyer', amount: { asset, atomic: '200' }, responsibility: 'Seller dispatches' }, charges: [], plannedPaymentMethod: 'bank', inspectionWindowHours: 48, disputeTerms: 'Record disagreement', returnTerms: 'Return after agreement', expiresAt: '2099-01-01T00:00:00.000Z' };
  const savedTrade = await api('/api/tcg/trades', { expectedVersion: 0, idempotencyKey: randomUUID(), terms });
  assert.equal(savedTrade.status, 200);
  const trade = savedTrade.data.trade;
  const savedSimulation = await api('/api/tcg/simulations', { expectedVersion: 0, idempotencyKey: randomUUID(), tradeId: trade.id, revision: 1 });
  assert.equal(savedSimulation.status, 200);
  const simulation = savedSimulation.data.simulation;
  assert.equal(simulation.protection, 'unavailable');
  assert.equal((await api('/api/vault/keys')).data.keys.length, 0);
  for (const name of ['sovereign.db', 'tcg-sandbox.db']) assert.equal(statSync(join(originalData, name)).mode & 0o777, 0o600);

  // Simulate another tab locking the shared node, then returning to this view.
  assert.equal((await api('/api/vault/lock', {})).status, 200);
  await returnCheck();
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  assert.equal(await page.locator('form.entry-form').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('cashloom.session')), null);
  await unlock();
  pass('A return after another tab locks the actual node clears this tab session and unmounts private drafts');

  const port = new URL(origin).port;
  await stop(); await start(originalData, port);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  await unlock();
  assert.equal((await api('/api/accounts')).data.accounts.find((a) => a.id === account.id).balance_minor, '5725');
  assert.equal((await api('/api/transactions')).data.transactions.length, 4);
  assert.equal((await api(`/api/tcg/trades/${trade.id}`)).data.trade.current.hash, trade.current.hash);
  assert.equal((await api(`/api/tcg/simulations/${simulation.id}`)).data.simulation.snapshot.hash, simulation.snapshot.hash);
  pass('Actual process restart requires unlocking again and retains balances, history, agreements and simulation identity');

  await stop();
  await cli(['backup', '--source', originalData, '--target', backupDir]);
  await cli(['verify', '--source', backupDir]);
  await cli(['restore', '--source', backupDir, '--target', restoredData]);
  assert(existsSync(join(originalData, 'sovereign.db')) && existsSync(join(restoredData, 'tcg-sandbox.db')));
  await start(restoredData, port);
  await page.reload({ waitUntil: 'networkidle' }); await unlock();
  assert.equal((await api('/api/accounts')).data.accounts.find((a) => a.id === account.id).balance_minor, '5725');
  assert.equal((await api('/api/transactions')).data.transactions.length, 4);
  assert.equal((await api(`/api/tcg/trades/${trade.id}`)).data.trade.current.hash, trade.current.hash);
  const recovered = (await api(`/api/tcg/simulations/${simulation.id}`)).data.simulation;
  assert.equal(recovered.snapshot.hash, simulation.snapshot.hash);
  assert.equal(recovered.staleRevision, false);
  assert.equal(recovered.protection, 'unavailable');
  await navigate('Overview');
  await page.getByText('57.25', { exact: false }).first().waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: join(root, 'daily-restored.png'), fullPage: true });
  pass('Verified backup restores into a separate directory, unlocks with the existing passphrase and preserves both databases');

  await stop();
  unlinkSync(join(nodeRoot, 'ui')); mkdirSync(join(nodeRoot, 'ui'));
  let refused = false;
  try { await start(restoredData, port); } catch { refused = true; }
  assert(refused && server.exitCode === 1 && output.includes('wallet UI is not built'));
  pass('Missing UI build produces an actionable startup refusal instead of an apparently ready node');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(forbiddenRequests, []);
} finally {
  await browser?.close();
  await stop();
  writeFileSync(join(root, 'daily-use-result.json'), JSON.stringify({ checks, pageErrors, forbiddenRequests }, null, 2));
}
console.log(`Actual-node daily-use checks: ${checks.length} passed; processes stopped`);
