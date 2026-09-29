// Actual local node + observer + SQLite + stdio MCP, with synthetic RPC transport.
// run.py supplies a temporary HOME and OS-level non-loopback network denial.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
const nodeRoot = join(root, 'node', 'sovereign');
const data = join(root, 'crypto-data');
mkdirSync(data, { mode: 0o700 });
const passphrase = randomUUID() + randomUUID();
const address = '0x1234567890abcdef1234567890abcdef12345678';
const label = 'Watched Base savings';
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
const { Client } = await import(pathToFileURL(join(nodeRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(nodeRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
const checks = [], pageErrors = [], forbiddenRequests = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, browser, page, origin, client, transport, output = '';
let loseWatchResponse = true;
const mode = (value) => writeFileSync(join(root, 'crypto-rpc-mode'), value);
const rpc = () => JSON.parse(readFileSync(join(root, 'crypto-rpc-calls.json'), 'utf8'));
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function start(port = '0') {
  output = '';
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', '--preload', join(nodeRoot, 'tests/tcg-browser/crypto-rpc-preload.ts'), join(nodeRoot, 'src/index.ts')], {
    cwd: join(root, 'home'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CASHLOOM_DATA_DIR: data, CASHLOOM_BIND: '127.0.0.1', CASHLOOM_PORT: String(port), CASHLOOM_BASE_RECONCILIATION_ENABLED: '0',
      CASHLOOM_BASE_RPC_URL: 'https://base-a.invalid/rpc', CASHLOOM_BASE_CONFIRMATION_RPC_URL: 'https://base-b.invalid/rpc' },
  });
  const capture = (chunk) => { output = (output + String(chunk)).slice(-12000); };
  server.stdout.on('data', capture); server.stderr.on('data', capture);
  for (let n = 0; n < 200; n++) {
    const match = output.match(/cashloom sovereign · (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) { origin = match[1]; return; }
    assert(server.exitCode === null, 'Isolated crypto node exited before readiness: ' + output);
    await delay(50);
  }
  throw new Error('Isolated crypto node readiness timed out');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM'); await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}
async function ownerApi(path, body) {
  assert(/^\/api\/(accounts|transactions|assist\/|vault\/keys|wallet\/v3\/positions)/.test(path));
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('cashloom.session')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
}
async function agentApi(token, path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
async function readContext(args = {}) {
  const result = await client.callTool({ name: 'cashloom_read_context', arguments: args });
  assert(!result.isError, 'Scoped crypto read failed');
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
}
async function navigate(name) {
  await page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function watch(name, target = address) {
  await navigate('Connections');
  await page.getByRole('button', { name: 'Add crypto wallet', exact: true }).click();
  const form = page.getByRole('form', { name: 'Watch a wallet', exact: true });
  await form.getByLabel('Public wallet address', { exact: true }).fill(target);
  await form.getByLabel('Wallet label', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Add watched wallet', exact: true }).click();
  return form;
}
async function refresh(row) {
  const response = page.waitForResponse((r) => /\/base-positions\/refresh$/.test(new URL(r.url()).pathname));
  await row.getByRole('button', { name: 'Check balances', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200);
  await row.getByRole('button', { name: 'Check balances', exact: true }).waitFor();
  return result.json();
}

try {
  mode('unavailable'); await start();
  browser = await chromium.launch({ executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin || /\/api\/(pay\/|zerone)/.test(url.pathname)) { forbiddenRequests.push(url.pathname); return route.abort('blockedbyclient'); }
    if (loseWatchResponse && url.pathname === '/api/connections/crypto/watch' && request.method() === 'POST') {
      loseWatchResponse = false; const response = await route.fetch();
      assert.equal(response.status(), 201, 'Synthetic watch creation did not commit');
      return route.abort('failed');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', (socket) => { forbiddenRequests.push('websocket'); socket.close(); });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', () => pageErrors.push('Uncaught browser error'));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
  const form = await watch(label);
  await form.getByRole('button', { name: 'Retry same wallet', exact: true }).waitFor();
  assert(await form.getByLabel('Public wallet address', { exact: true }).isDisabled());
  assert.equal(rpc().calls, 0, 'Adding a watched address must not contact providers');
  await form.getByRole('button', { name: 'Retry same wallet', exact: true }).click();
  const row = page.getByRole('article', { name: label, exact: true });
  await row.waitFor();
  const account = (await ownerApi('/api/accounts')).data.accounts[0];
  assert.equal((await ownerApi('/api/accounts')).data.accounts.length, 1);
  assert.equal(account.account_ref, `eip155:8453:${address}`);
  assert.equal(account.vault_key_id, null); assert.equal(account.connector_type, null); assert.equal(account.credential_ref, null);
  assert.equal(account.balance_as_of, null);
  assert.equal((await ownerApi('/api/vault/keys')).data.keys.length, 0);
  assert.equal(rpc().calls, 0);
  assert.equal(await row.getByRole('button', { name: 'Send money', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Receive money', exact: true }).count(), 0);
  pass('A lost watch-creation response retries the same keyless Base account without duplicates, provider calls or payment actions');

  let result = await refresh(row);
  assert.equal(result.account.status, 'not_checked'); assert.equal(result.account.snapshot, null);
  assert.deepEqual(result.account.positions, []);
  mode('healthy'); result = await refresh(row);
  assert.equal(result.account.status, 'finalized'); assert.equal(result.account.snapshot.quorum, '2');
  assert.equal(result.account.positions.find((p) => p.symbol === 'ETH').observed_atomic, '1500000000000000001');
  assert.equal(result.account.positions.find((p) => p.symbol === 'USDC').observed_atomic, '2500123456');
  await row.locator('.base-position-values').waitFor();
  assert.match(await row.innerText(), /USDC/);
  const callsAfterCheck = rpc().calls;
  await navigate('Overview'); await page.getByRole('heading', { name: label, exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: label, exact: true }).count(), 1);
  await page.reload(); await page.getByRole('heading', { name: label, exact: true }).waitFor();
  assert.equal(rpc().calls, callsAfterCheck, 'Navigation and reload must read saved holdings without RPC');
  pass('Explicit checks preserve unknown on failure, then store exact ETH/native-USDC evidence; Overview and reload read it without RPC');

  await watch('A duplicate label must not replace the original'); await row.waitFor();
  assert.equal((await ownerApi('/api/accounts')).data.accounts.length, 1);
  assert.equal((await ownerApi('/api/accounts')).data.accounts[0].display_name, label);
  assert.equal(rpc().calls, callsAfterCheck);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 950 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(root, `crypto-watch-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  const hidden = (await ownerApi('/api/accounts', { rail: 'CASH', display_name: 'Unshared crypto rehearsal record', currency: 'USD', decimals: 2 })).data.account;
  const issued = (await ownerApi('/api/assist/access', { label: 'Crypto read rehearsal', account_ids: [account.id], allow_proposals: false, ttl_minutes: 15 })).data;
  assert(typeof issued.token === 'string');
  transport = new StdioClientTransport({ command: process.env.TCG_BROWSER_BUN,
    args: ['--no-env-file', '--no-install', join(nodeRoot, 'src/mcp/assist.ts')], cwd: join(root, 'home'), stderr: 'pipe',
    env: { ...process.env, CASHLOOM_ASSIST_URL: origin, CASHLOOM_ASSIST_TOKEN: issued.token } });
  // Never forward raw MCP stderr, which is outside the record projection.
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'cashloom-synthetic-crypto-review', version: '0.1.0' }); await client.connect(transport);
  let saved = await readContext();
  assert.deepEqual(saved.accounts.map((a) => a.id), [account.id]); assert.equal(saved.accounts[0].balance_minor, null);
  assert.equal(saved.base_holdings.length, 1); assert.equal(saved.base_holdings[0].status, 'saved_finalized');
  assert.deepEqual(saved.base_holdings[0].account_ids, [account.id]);
  assert.equal(saved.base_holdings[0].holdings.find((h) => h.asset === 'ETH').observed_atomic, '1500000000000000001');
  assert.equal(saved.base_holdings[0].holdings.find((h) => h.asset === 'USDC').observed_atomic, '2500123456');
  const encoded = JSON.stringify(saved);
  for (const forbidden of [address, hidden.id, 'base-a.invalid', 'base-b.invalid', 'credential_ref', 'vault_key_id', 'provider_ids', 'account_ref']) assert(!encoded.includes(forbidden), 'Scoped holdings contain an unadvertised identity or provider field');
  assert.equal((await agentApi(issued.token, '/api/assist/context?account_id=' + hidden.id)).status, 403);
  assert.equal((await agentApi(issued.token, '/api/connections/crypto/watch', { network: 'base', address, display_name: 'Unauthorized watch' })).status, 403);
  assert.equal((await agentApi(issued.token, `/api/wallet/v2/accounts/${account.id}/base-positions/refresh`, {})).status, 403);
  assert.equal((await agentApi(issued.token, '/api/pay/confirm', {})).status, 403);
  assert.equal(rpc().calls, callsAfterCheck);
  pass('Duplicate addresses retain their original account; real MCP returns scoped saved holdings without addresses, provider details or spending/refresh authority');

  mode('unavailable'); result = await refresh(row);
  assert.equal(result.account.status, 'finalized');
  assert.equal(result.account.positions.find((p) => p.symbol === 'ETH').observed_atomic, '1500000000000000001');
  saved = await readContext(); assert.equal(saved.base_holdings[0].status, 'retained_after_check');
  assert.equal(saved.base_holdings[0].holdings.length, 2);
  mode('conflict'); result = await refresh(row);
  assert.equal(result.account.status, 'conflicted');
  saved = await readContext(); assert.equal(saved.base_holdings[0].status, 'conflicted');
  assert.deepEqual(saved.base_holdings[0].holdings, []);
  assert.equal(await row.getByRole('button', { name: 'Check balances', exact: true }).isDisabled(), true);
  pass('A failed check retains dated holdings with a warning; contradictory finalized evidence freezes the view and removes agent balance claims');

  assert.equal((await ownerApi('/api/transactions')).data.transactions.length, 0);
  assert.equal((await ownerApi('/api/vault/keys')).data.keys.length, 0);
  assert.equal((await ownerApi('/api/accounts')).data.accounts.find((a) => a.id === account.id).balance_as_of, null);
  assert.equal(rpc().rejected, 0, 'The actual node attempted an unexpected outgoing request');
  await navigate('Connections'); await page.getByRole('button', { name: 'Add crypto wallet', exact: true }).click();
  await page.getByLabel('Wallet label', { exact: true }).fill('Unsaved watched label');
  await page.getByLabel('Public wallet address', { exact: true }).fill(address);
  const browserState = await page.evaluate(() => JSON.stringify({ href: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!browserState.includes(address) && !browserState.includes('Unsaved watched label'));
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByLabel('Passphrase', { exact: true }).waitFor();
  assert.equal((await agentApi(issued.token, '/api/assist/context')).status, 401);
  await client.close(); client = null;
  const port = new URL(origin).port; await stop(); mode('healthy'); await start(port);
  await page.reload(); await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
  await navigate('Connections'); assert.equal(await page.getByRole('form', { name: 'Watch a wallet', exact: true }).count(), 0);
  await navigate('Accounts'); await row.waitFor();
  assert.equal((await ownerApi('/api/wallet/v3/positions')).data.base_accounts.find((a) => a.account_id === account.id).status, 'conflicted');
  assert.equal(rpc().calls, 0); assert.equal(rpc().rejected, 0);
  pass('Watch setup stores no keys or fabricated activity; lock clears the draft/access and restart preserves saved evidence without refreshing');
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
} finally {
  await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  await browser?.close(); await stop();
  writeFileSync(join(root, 'crypto-watch-result.json'), JSON.stringify({ checks, pageErrors, forbiddenRequests, providerTransport: 'Synthetic RPC responses; non-loopback networking denied by run.py' }, null, 2));
}
console.log(`Actual-node crypto watch checks: ${checks.length} passed; processes stopped`);
