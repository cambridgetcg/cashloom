// Isolated UI contract checks. Credentials exist only in memory and are never printed.
// Run from sovereign/ui after build; set MONEY_UI_DRIVER and MONEY_UI_CHROMIUM.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const dist = resolve(process.env.ASSIST_UI_DIST ?? 'dist');
assert(existsSync(join(dist, 'index.html')), 'Build the private UI before running this test.');
const output = process.env.ASSIST_UI_OUTPUT ?? '/tmp/cashloom-agent-access-review';
mkdirSync(output, { recursive: true });
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.html': 'text/html' };
const server = createServer((request, response) => {
  const path = resolve(dist, '.' + new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path === dist ? join(dist, 'index.html') : path;
  if (!file.startsWith(dist + sep) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  response.end(readFileSync(file));
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.MONEY_UI_DRIVER ?? process.env.TCG_BROWSER_DRIVER).href);
const browser = await chromium.launch({ executablePath: process.env.MONEY_UI_CHROMIUM ?? process.env.TCG_BROWSER_CHROMIUM, headless: true });
let checks = 0;
const pass = message => { checks++; console.log(`PASS ${message}`); };
const at = new Date().toISOString();
const account = { id: 'account', display_name: 'Sandbox household', currency: 'USD', decimals: 2, rail: 'BANK', connector_type: null, balance_minor: '50000', balance_as_of: at, read_environment: 'sandbox', status: 'ACTIVE', created_at: at };
const archived = { ...account, id: 'archived', display_name: 'Archived account', status: 'ARCHIVED' };
const makeProposal = (id, title, review_state = 'current') => ({ id, grant_id: 'original', access_label: 'Household helper', account_id: account.id, transaction_id: id, before: { id, account_id: account.id, title, amount_minor: '-4250', currency: 'USD', decimals: 2, date: at, category: null, status: 'posted', source: 'CSV', is_internal_transfer: false, record_version: `sha256:${'a'.repeat(64)}` }, category: 'Groceries', reason: '<img src="https://must-not-load.invalid/"> and a stated reason', status: 'pending', review_state, created_at: at, decided_at: null });
let grants = [], proposals = [makeProposal('current', 'Food purchase'), { ...makeProposal('competing', 'Other suggestion for food'), transaction_id: 'current' }, makeProposal('changed', 'Changed purchase', 'changed'), makeProposal('unavailable', 'Missing purchase', 'unavailable'), makeProposal('conflict', 'Concurrent change')];
const issuedCredentials = [], writes = [], errors = [], unexpected = [];
let ownerAllowed = true, proposalReads = 0, applyCalls = 0, creates = 0, deferCreation = false, releaseCreation;
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
await context.addInitScript(() => sessionStorage.setItem('cashloom.session', crypto.randomUUID()));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.origin !== origin) { unexpected.push('external request'); return route.abort(); }
  if (!path.startsWith('/api/')) return route.continue();
  if (request.method() !== 'GET') writes.push({ path });
  if (path === '/api/meta') return json({ name: 'Synthetic CashLoom', mode: 'sovereign', version: 'fixture', initialized: true, unlocked: true, db: 'fixture' });
  if (path === '/api/vault/session') return json({ serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  if (path === '/api/vault/lock') return json({ ok: true });
  if (path === '/api/accounts') return json({ accounts: [account, archived] });
  if (path === '/api/vault/keys') return json({ keys: [] });
  if (path === '/api/wallet/v3/positions') return json({ base_accounts: [] });
  if (path === '/api/assist/access' && request.method() === 'GET') return ownerAllowed ? json({ access: grants }) : json({ error: 'owner_required' }, 403);
  if (path === '/api/assist/access' && request.method() === 'POST') {
    creates++;
    const input = request.postDataJSON();
    assert.deepEqual(input.account_ids, [account.id]);
    const access = { id: `grant-${creates}`, label: input.label, account_ids: input.account_ids, permissions: input.allow_proposals ? ['read', 'propose_categories'] : ['read'], created_at: at, expires_at: new Date(Date.now() + 300000).toISOString() };
    const token = randomUUID(); issuedCredentials.push(token); grants = [...grants, access];
    if (deferCreation) await new Promise(done => { releaseCreation = done; });
    return json({ access, token }, 201);
  }
  if (/^\/api\/assist\/access\/[^/]+\/revoke$/.test(path)) { grants = grants.filter(grant => grant.id !== path.split('/')[4]); return json({ ok: true, revoked: true }); }
  if (path === '/api/assist/review') { proposalReads++; return json({ proposals, has_more: false }); }
  if (/^\/api\/assist\/proposals\/[^/]+\/(accept|reject)$/.test(path)) {
    const id = path.split('/')[4], accept = path.endsWith('/accept');
    const proposal = proposals.find(item => item.id === id);
    if (accept) {
      applyCalls++;
      assert.equal(request.postDataJSON().expected_record_version === proposal.before.record_version, true);
      if (id === 'conflict') { proposals = proposals.map(item => item.id === id ? { ...item, status: 'stale', review_state: 'changed' } : item); return json({ error: { code: 'assist_record_stale', message: 'Record changed' } }, 409); }
      await new Promise(done => setTimeout(done, 120));
    }
    const updated = { ...proposal, status: accept ? 'accepted' : 'rejected', decided_at: new Date().toISOString() };
    proposals = proposals.map(item => item.id === id ? updated : accept && item.transaction_id === proposal.transaction_id && item.status === 'pending' ? { ...item, review_state: 'changed' } : item);
    return json({ proposal: updated, replayed: false });
  }
  unexpected.push(path); return json({ error: 'Unexpected synthetic route' }, 404);
});
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(8000);
page.on('pageerror', error => errors.push(error.name));
const nav = name => page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click();
const suggestion = title => page.getByRole('article', { name: `Category suggestion for ${title}`, exact: true });
const noCredentialStored = async () => assert.equal(await page.evaluate(credentials => credentials.some(value => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }).includes(value)), issuedCredentials), false, 'A generated credential must not enter storage or URL.');
const noCredentialVisible = async () => assert.equal(await page.evaluate(credentials => credentials.some(value => document.body.innerText.includes(value) || [...document.querySelectorAll('input,textarea')].some(field => field.value.includes(value))), issuedCredentials), false, 'A cleared credential must not remain in rendered content.');
try {
  await page.goto(`${origin}/#/assist`);
  const form = page.getByRole('form', { name: 'Create agent access' });
  await form.waitFor();
  assert.equal(await form.getByRole('button', { name: 'Create access', exact: true }).isDisabled(), true);
  assert.equal(await form.locator('input:checked').count(), 0);
  assert.equal(await form.getByText('Archived account', { exact: true }).count(), 0);
  assert.equal(writes.length, 0);
  assert.equal(await suggestion('Food purchase').locator('img').count(), 0);
  assert.equal(await suggestion('Changed purchase').getByRole('button', { name: 'Apply category' }).isDisabled(), true);
  assert.equal(await suggestion('Missing purchase').getByRole('button', { name: 'Apply category' }).isDisabled(), true);
  pass('read-only entry, empty access selection, escaped suggestions and stale/unavailable guards');
  await form.getByLabel('Access label', { exact: true }).fill('My test helper');
  await form.getByRole('checkbox', { name: /Sandbox household/ }).check();
  await form.getByRole('button', { name: 'Create access', exact: true }).click();
  await page.getByRole('region', { name: 'New access credential' }).waitFor();
  assert.equal(await page.getByLabel('One-time access credential').count(), 0);
  await noCredentialStored(); await noCredentialVisible();
  await page.getByRole('button', { name: 'Reveal credential', exact: true }).click();
  assert.equal(await page.getByLabel('One-time access credential').inputValue().then(value => issuedCredentials.includes(value)), true);
  await noCredentialStored();
  await page.getByRole('button', { name: 'Hide and forget credential' }).click();
  await noCredentialVisible();
  assert.equal(await page.getByRole('button', { name: 'Reveal credential' }).count(), 0);
  pass('one-time credentials require reveal, never persist, and explicit hiding forgets them');
  await form.getByRole('button', { name: 'Create access', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal credential', exact: true }).click();
  await nav('Signing keys'); await nav('Agent access');
  await page.getByRole('form', { name: 'Create agent access' }).waitFor();
  await noCredentialVisible();
  assert.equal(await page.getByRole('button', { name: 'Reveal credential' }).count(), 0);
  pass('leaving and reopening access cannot restore an issued credential');
  await form.getByLabel('Access label', { exact: true }).fill('Visibility helper');
  await form.getByRole('checkbox', { name: /Sandbox household/ }).check();
  await form.getByRole('button', { name: 'Create access', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal credential', exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(30);
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('form', { name: 'Create agent access' }).waitFor();
  await noCredentialVisible();
  assert.equal(await page.getByRole('button', { name: 'Reveal credential' }).count(), 0);
  pass('hiding a browser tab forgets the credential before resuming');
  const current = suggestion('Food purchase');
  await current.getByRole('button', { name: 'Apply category' }).evaluate(button => { button.click(); button.click(); });
  await current.getByText('Category applied', { exact: true }).waitFor();
  assert.equal(applyCalls, 1);
  assert.equal(await current.getByRole('button', { name: 'Apply category' }).count(), 0);
  assert.equal(await suggestion('Other suggestion for food').getByRole('button', { name: 'Apply category' }).isDisabled(), true, 'Competing proposals must stop offering apply immediately.');
  await suggestion('Changed purchase').getByRole('button', { name: 'Reject suggestion' }).click();
  await suggestion('Changed purchase').getByText('Rejected', { exact: true }).waitFor();
  await suggestion('Concurrent change').getByRole('button', { name: 'Apply category' }).click();
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  await page.getByRole('button', { name: 'Reload access and suggestions' }).click();
  await suggestion('Concurrent change').getByText('Stale · not applied', { exact: true }).waitFor();
  pass('duplicate apply coalesces, rejection keeps receipts, and server conflicts require refreshed review');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Agent access must fit ${width}px.`);
    await page.screenshot({ path: join(output, `agent-access-${width}.png`), fullPage: true });
  }
  pass('populated access and suggestions fit desktop and 390/320px screens');
  await form.getByLabel('Access label', { exact: true }).fill('Revoke helper');
  await form.getByRole('button', { name: 'Create access', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal credential', exact: true }).click();
  await page.getByRole('article', { name: 'Revoke helper', exact: true }).getByRole('button', { name: 'Revoke access' }).click();
  await page.getByText('Access revoked.', { exact: false }).waitFor();
  await noCredentialVisible();
  pass('revoking the newly issued grant also clears its credential');
  ownerAllowed = false;
  const readCount = proposalReads;
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Only the workspace owner' }).waitFor();
  assert.equal(await page.getByRole('form', { name: 'Create agent access' }).count(), 0);
  assert.equal(proposalReads, readCount);
  ownerAllowed = true;
  await page.getByRole('button', { name: 'Reload access and suggestions' }).click();
  await form.waitFor();
  pass('owner access-list permission gates private management reads and controls');
  await form.getByLabel('Access label', { exact: true }).fill('Delayed helper');
  await form.getByRole('checkbox', { name: /Sandbox household/ }).check();
  deferCreation = true;
  await form.getByRole('button', { name: 'Create access', exact: true }).click();
  while (!releaseCreation) await new Promise(done => setTimeout(done, 10));
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  releaseCreation();
  await page.waitForTimeout(100);
  await noCredentialVisible(); await noCredentialStored();
  assert.equal(await page.getByRole('region', { name: 'New access credential' }).count(), 0);
  pass('late credential creation after lock cannot reach the screen or browser storage');
  assert.equal(errors.length, 0, 'No uncaught browser errors.');
  assert.deepEqual(unexpected, [], 'Only local fixture routes were requested.');
  console.log(`Completed ${checks} agent-access UI checks. Screenshots: ${output}`);
} finally { await context.close(); await browser.close(); server.close(); }
