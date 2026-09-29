// Real local node + stdio MCP + browser, using run.py's isolated synthetic data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
const nodeRoot = join(root, 'node', 'sovereign');
const data = join(root, 'assist-data');
mkdirSync(data, { mode: 0o700 });
const passphrase = randomUUID() + randomUUID();
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
const { Client } = await import(pathToFileURL(join(nodeRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(nodeRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
const checks = [], pageErrors = [], forbiddenRequests = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server, browser, page, origin, client, transport;
let serverOutput = '', mcpErrors = '';
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }

async function start(port = '0') {
  serverOutput = '';
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', join(nodeRoot, 'src/index.ts')], {
    cwd: join(root, 'home'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CASHLOOM_DATA_DIR: data, CASHLOOM_BIND: '127.0.0.1', CASHLOOM_PORT: port, CASHLOOM_BASE_RECONCILIATION_ENABLED: '0' },
  });
  const capture = (chunk) => { serverOutput = (serverOutput + String(chunk)).slice(-12000); };
  server.stdout.on('data', capture); server.stderr.on('data', capture);
  for (let n = 0; n < 200; n++) {
    const match = serverOutput.match(/cashloom sovereign · (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) { assert(Number(match[2]) > 0); origin = match[1]; return; }
    assert(server.exitCode === null, 'Isolated agent-test node exited before readiness');
    await delay(50);
  }
  throw new Error('Isolated agent-test node readiness timed out');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM'); await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}
async function ownerApi(path, body) {
  assert(/^\/api\/(accounts|transactions|assist\/|vault\/lock)/.test(path));
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${sessionStorage.getItem('cashloom.session')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body });
}
async function agentApi(token, path, body) {
  assert(path.startsWith('/api/'));
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json() };
}
async function navigate(name) {
  await page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function reloadAccess() { await navigate('Overview'); await navigate('Agent access'); }
async function unlock() {
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
}
async function callTool(name, args = {}, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, expectError, 'Unexpected MCP tool success/error state');
  return JSON.parse(result.content.find((part) => part.type === 'text').text);
}

try {
  await start();
  browser = await chromium.launch({ executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /\/api\/(pay\/|.*\/sync$|.*\/refresh$|zerone)/.test(url.pathname)) {
      forbiddenRequests.push(url.pathname); return route.abort('blockedbyclient');
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
  const selected = (await ownerApi('/api/accounts', { rail: 'CASH', display_name: 'Shared travel records', currency: 'USD', decimals: 2 })).data.account;
  const hidden = (await ownerApi('/api/accounts', { rail: 'CASH', display_name: 'Unshared household records', currency: 'USD', decimals: 2 })).data.account;
  const entry = (await ownerApi('/api/transactions', { account_id: selected.id, title: 'Synthetic train fare', amount_minor: '-240', category: 'Unsorted' })).data.transaction;
  await ownerApi('/api/transactions', { account_id: hidden.id, title: 'Unshared synthetic purchase', amount_minor: '-100' });
  const beforeBalance = selected.balance_minor;
  await navigate('Agent access');
  const form = page.getByRole('form', { name: 'Create agent access', exact: true });
  await form.getByLabel('Access label', { exact: true }).fill('Local review fixture');
  await form.getByRole('checkbox', { name: /Shared travel records/ }).check();
  await form.getByRole('checkbox', { name: /Allow category suggestions/ }).check();
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/assist/access' && response.request().method() === 'POST');
  await form.locator('button[type="submit"]').click();
  const response = await created;
  assert.equal(response.status(), 201);
  const issued = await response.json();
  assert(typeof issued.token === 'string' && issued.token.length > 20, 'Creation did not return an access credential');
  assert.deepEqual(issued.access.account_ids, [selected.id]);
  assert.deepEqual(new Set(issued.access.permissions), new Set(['read', 'propose_categories']));
  assert(!(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes(issued.token), 'Access credential persisted in browser storage');
  assert(!page.url().includes(issued.token), 'Access credential entered the URL');
  // Unmount clears the one-time credential before any screenshot is taken.
  await reloadAccess();
  assert(!await page.locator('input, textarea').evaluateAll((inputs, token) => inputs.some((input) => input.value === token), issued.token), 'Access credential survived navigation');
  pass('Owner grants only selected accounts and proposal permission; credential is not persisted and clears on navigation');

  transport = new StdioClientTransport({
    command: process.env.TCG_BROWSER_BUN,
    args: ['--no-env-file', '--no-install', join(nodeRoot, 'src/mcp/assist.ts')],
    cwd: join(root, 'home'), stderr: 'pipe',
    env: { ...process.env, CASHLOOM_ASSIST_URL: origin, CASHLOOM_ASSIST_TOKEN: issued.token },
  });
  transport.stderr?.on('data', (chunk) => { mcpErrors = (mcpErrors + String(chunk)).slice(-4000); });
  client = new Client({ name: 'cashloom-synthetic-local-review', version: '0.1.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['cashloom_list_proposals', 'cashloom_read_context', 'cashloom_suggest_category']);
  const snapshot = await callTool('cashloom_read_context');
  assert.equal(snapshot.schema_version, 'cashloom.assist-context/1');
  assert.deepEqual(snapshot.accounts.map((account) => account.id), [selected.id]);
  assert.equal(snapshot.accounts[0].balance_minor, null, 'An unobserved balance must remain unknown');
  assert.equal(snapshot.transactions.length, 1);
  assert.equal(snapshot.activity_window.has_more, false);
  for (const field of ['credential_ref', 'external_account_id', 'vault_key_id', 'raw', 'account_ref']) assert(!JSON.stringify(snapshot).includes(`"${field}"`), 'Private read projection contains a forbidden field');
  await callTool('cashloom_read_context', { account_id: hidden.id }, true);
  assert.equal((await agentApi(issued.token, '/api/accounts')).status, 403);
  assert.equal((await agentApi(issued.token, '/api/vault/keys')).status, 403);
  assert.equal((await agentApi(issued.token, '/api/assist/review')).status, 403);
  assert.equal((await ownerApi('/api/assist/proposals')).status, 403);
  assert.equal((await agentApi(issued.token, '/api/pay/confirm', {})).status, 403);
  pass('Real stdio MCP exposes three tools and reads only the grant projection; broad reads, keys and payments are refused');

  const observed = snapshot.transactions.find((row) => row.id === entry.id);
  const input = { request_id: randomUUID(), transaction_id: entry.id, expected_record_version: observed.record_version, category: 'Travel', reason: 'Synthetic train fare describes travel; please review.' };
  const submitted = await callTool('cashloom_suggest_category', input);
  assert.equal(submitted.proposal.status, 'pending');
  const replay = await callTool('cashloom_suggest_category', input);
  assert.equal(replay.replayed, true); assert.equal(replay.proposal.id, submitted.proposal.id);
  const competitor = await callTool('cashloom_suggest_category', { ...input, request_id: randomUUID(), category: 'Commuting' });
  const ownProposals = await callTool('cashloom_list_proposals');
  assert.equal(ownProposals.proposals.length, 2);
  assert(ownProposals.proposals.every((proposal) => proposal.grant_id === issued.access.id));
  assert.equal((await agentApi(issued.token, `/api/assist/proposals/${submitted.proposal.id}/accept`, { expected_record_version: observed.record_version })).status, 403);
  assert.equal((await ownerApi('/api/transactions')).data.transactions.find((row) => row.id === entry.id).category, 'Unsorted');
  pass('MCP suggestions are durable, idempotent proposals and cannot approve themselves or change records');

  await reloadAccess();
  const proposal = page.locator('article').filter({ has: page.getByText('Travel', { exact: true }) }).filter({ has: page.getByRole('button', { name: /Apply category/i }) });
  await proposal.first().getByRole('button', { name: /Apply category/i }).waitFor();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Agent access overflows at ${width}px`);
    await page.screenshot({ path: join(root, `agent-review-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  const accepted = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/assist/proposals/${submitted.proposal.id}/accept`);
  await proposal.first().getByRole('button', { name: /Apply category/i }).click();
  assert.equal((await accepted).status(), 200);
  const after = (await ownerApi('/api/transactions')).data.transactions.find((row) => row.id === entry.id);
  assert.equal(after.category, 'Travel'); assert.equal(after.amount_minor, '-240');
  assert.equal((await ownerApi('/api/accounts')).data.accounts.find((row) => row.id === selected.id).balance_minor, beforeBalance);
  const stale = await ownerApi(`/api/assist/proposals/${competitor.proposal.id}/accept`, { expected_record_version: observed.record_version });
  assert.equal(stale.status, 409);
  assert.equal((await ownerApi('/api/transactions')).data.transactions.find((row) => row.id === entry.id).category, 'Travel');
  pass('Responsive owner review applies only the category; a competing stale suggestion cannot overwrite it');

  const updated = (await callTool('cashloom_read_context')).transactions.find((row) => row.id === entry.id);
  const pending = await callTool('cashloom_suggest_category', { ...input, request_id: randomUUID(), expected_record_version: updated.record_version, category: 'Transport' });
  await reloadAccess();
  const accessRow = page.locator('article').filter({ has: page.getByRole('button', { name: /Revoke access/i }) }).filter({ hasText: 'Local review fixture' });
  const revoked = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/assist/access/${issued.access.id}/revoke`);
  await accessRow.first().getByRole('button', { name: /Revoke access/i }).click();
  assert.equal((await revoked).status(), 200);
  await callTool('cashloom_read_context', {}, true);
  await callTool('cashloom_suggest_category', { ...input, request_id: randomUUID() }, true);
  await reloadAccess();
  const rejectionRow = page.locator('article').filter({ has: page.getByText('Transport', { exact: true }) }).filter({ has: page.getByRole('button', { name: /^Reject/ }) });
  const rejected = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/assist/proposals/${pending.proposal.id}/reject`);
  await rejectionRow.first().getByRole('button', { name: /^Reject/ }).click();
  assert.equal((await rejected).status(), 200);
  pass('Owner revokes future MCP access and can still reject an existing suggestion');

  const port = new URL(origin).port;
  await client.close(); client = null;
  await stop(); await start(port);
  await page.reload({ waitUntil: 'networkidle' }); await unlock();
  const saved = (await ownerApi('/api/assist/review')).data.proposals;
  assert.equal(saved.find((p) => p.id === submitted.proposal.id).status, 'accepted');
  assert.equal(saved.find((p) => p.id === pending.proposal.id).status, 'rejected');
  assert.equal(saved.find((p) => p.id === competitor.proposal.id).status, 'stale');
  assert.deepEqual((await ownerApi('/api/assist/access')).data.access, []);
  assert.equal((await agentApi(issued.token, '/api/assist/context')).status, 401);
  pass('Restart preserves proposal decisions while agent access ends');
  assert(!serverOutput.includes(issued.token) && !mcpErrors.includes(issued.token), 'An access credential appeared in process output');
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await browser?.close(); await stop();
  writeFileSync(join(root, 'agent-access-result.json'), JSON.stringify({ checks, pageErrors, forbiddenRequests }, null, 2));
}
console.log(`Agent access actual-node/MCP checks: ${checks.length} passed; processes stopped`);
