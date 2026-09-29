// Actual isolated node/UI with synthetic EIP-6963 and EIP-1193 providers.
// This verifies our integration, not real extensions or wallet interoperability.
// run.py supplies temporary HOME/data, a fresh browser profile and OS egress denial.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
const nodeRoot = join(root, 'node', 'sovereign');
const data = join(root, 'browser-wallet-data');
mkdirSync(data, { mode: 0o700 });
const passphrase = randomUUID() + randomUUID();
const addresses = [1, 2, 3].map(byte => `0x${String(byte).repeat(40)}`);
const alphaName = '<img src=x onerror=alert(1)> Synthetic wallet';
const betaName = 'Second synthetic wallet';
const label = 'Browser-selected Base watch';
const metadata = [alphaName, betaName, 'org.synthetic.alpha', 'org.synthetic.beta', 'not-requested.invalid', 'wallet-icon-script',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
const checks = [], pageErrors = [], forbiddenRequests = [], methodReports = [];
const callsPath = join(root, 'browser-wallet-rpc-calls.json');
const preload = join(root, 'browser-wallet-no-rpc.ts');
// A dedicated fixture preload rejects and counts every backend fetch. It does
// not touch the real provider transport, operator data, credentials or source.
writeFileSync(preload, `import { existsSync, realpathSync, writeFileSync } from 'node:fs';
const root = process.env.TCG_BROWSER_ROOT;
if (!root || !existsSync(root + '/.tcg-browser-fixture') || realpathSync(process.env.HOME!) !== realpathSync(root + '/home') || realpathSync(process.env.CASHLOOM_DATA_DIR!) !== realpathSync(root + '/browser-wallet-data')) throw new Error('Isolated browser-wallet fixture required');
let calls = 0; const record = () => writeFileSync(root + '/browser-wallet-rpc-calls.json', JSON.stringify({ calls })); record();
globalThis.fetch = (async () => { calls++; record(); throw new Error('No outgoing fetch allowed during browser-wallet rehearsal'); }) as unknown as typeof fetch;
`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, context, page, origin, output = '', watchWrites = 0;
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

async function start() {
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', '--preload', preload, join(nodeRoot, 'src/index.ts')], {
    cwd: join(root, 'home'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CASHLOOM_DATA_DIR: data, CASHLOOM_BIND: '127.0.0.1', CASHLOOM_PORT: '0', CASHLOOM_BASE_RECONCILIATION_ENABLED: '0',
      CASHLOOM_BASE_RPC_URL: 'https://base-a.invalid/rpc', CASHLOOM_BASE_CONFIRMATION_RPC_URL: 'https://base-b.invalid/rpc' },
  });
  const capture = chunk => { output = (output + String(chunk)).slice(-12000); };
  server.stdout.on('data', capture); server.stderr.on('data', capture);
  for (let count = 0; count < 200; count++) {
    const ready = output.match(/cashloom sovereign · (http:\/\/127\.0\.0\.1:(\d+))/);
    if (ready) { origin = ready[1]; return; }
    assert(server.exitCode === null, 'Isolated browser-wallet node exited before readiness');
    await delay(50);
  }
  throw new Error('Isolated browser-wallet node readiness timed out');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM'); await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}

function installSyntheticWallets({ mode, addresses, alphaName, betaName }) {
  const wallets = new Map();
  const methods = [], forbidden = [];
  let discoveries = 0, iconReads = 0;
  const allowed = new Set(['eth_chainId', 'eth_requestAccounts', 'eth_accounts']);
  const build = (key, uuid, name, rdns) => {
    const state = { chain: '0x2105', accounts: [], approved: [...addresses.slice(0, 2)], next: 'approve', afterApproveChain: null, pending: [], listeners: new Map() };
    const emit = (event, value) => { for (const listener of [...(state.listeners.get(event) ?? [])]) listener(value); };
    const approve = () => {
      state.accounts = [...state.approved];
      // Real wallets may announce newly authorized accounts before resolving the
      // user's original request. This initial permission event is not a race.
      emit('accountsChanged', [...state.accounts]);
      if (state.afterApproveChain) { state.chain = state.afterApproveChain; state.afterApproveChain = null; }
      return [...state.accounts];
    };
    const provider = {
      async request({ method }) {
        methods.push({ wallet: key, method });
        if (!allowed.has(method)) { forbidden.push(method); throw Object.assign(new Error('Unsupported synthetic method'), { code: 4200 }); }
        if (method === 'eth_chainId') return state.chain;
        if (method === 'eth_accounts') return [...state.accounts];
        const next = state.next; state.next = 'approve';
        if (next === 'deny') throw Object.assign(new Error('Synthetic wallet decline detail must not be shown'), { code: 4001 });
        if (next === 'pending') return new Promise(resolve => state.pending.push(() => resolve(approve())));
        return approve();
      },
      on(event, listener) { const set = state.listeners.get(event) ?? new Set(); set.add(listener); state.listeners.set(event, set); return this; },
      removeListener(event, listener) { state.listeners.get(event)?.delete(listener); return this; },
    };
    const info = { uuid, name, rdns };
    Object.defineProperty(info, 'icon', { enumerable: true, get() {
      iconReads++;
      return key === 'alpha' ? 'https://not-requested.invalid/wallet.png' : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="window.__walletIconRan=true"><text>wallet-icon-script</text></svg>';
    } });
    wallets.set(key, { state, provider, info, emit });
  };
  build('alpha', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alphaName, 'org.synthetic.alpha');
  build('beta', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', betaName, 'org.synthetic.beta');
  const announce = key => {
    const wallet = wallets.get(key);
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: wallet.info, provider: wallet.provider }) }));
  };
  window.addEventListener('eip6963:requestProvider', () => {
    discoveries++;
    if (mode === 'injected') { announce('alpha'); announce('beta'); announce('alpha'); }
  });
  if (mode === 'legacy') window.ethereum = wallets.get('alpha').provider;
  window.__cashloomWalletFixture = {
    set(key, patch) { Object.assign(wallets.get(key).state, patch); },
    emit(key, event, value) {
      const wallet = wallets.get(key);
      if (event === 'accountsChanged') wallet.state.accounts = [...value];
      if (event === 'chainChanged') wallet.state.chain = value;
      wallet.emit(event, value);
    },
    resolve(key) { const pending = wallets.get(key).state.pending.shift(); if (!pending) throw new Error('No synthetic prompt to resolve'); pending(); },
    announce,
    spoof() { const alpha = wallets.get('alpha'), beta = wallets.get('beta'); window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: alpha.info.uuid, name: 'Replacement must be ignored', rdns: 'org.synthetic.replacement' }, provider: beta.provider },
    })); },
    snapshot() { return { discoveries, iconReads, iconExecuted: window.__walletIconRan === true, methods: [...methods], forbidden: [...forbidden],
      pending: Object.fromEntries([...wallets].map(([key, wallet]) => [key, wallet.state.pending.length])),
      listeners: Object.fromEntries([...wallets].map(([key, wallet]) => [key, [...wallet.state.listeners.values()].reduce((sum, set) => sum + set.size, 0)])) }; },
  };
}

async function newPage(mode = 'injected') {
  context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  await context.addInitScript(installSyntheticWallets, { mode, addresses, alphaName, betaName });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const permittedWrite = ['/api/vault/init', '/api/vault/unlock', '/api/vault/lock', '/api/connections/crypto/watch'];
    if (url.origin !== origin || /\/api\/(pay\/|.*\/sync$|.*\/refresh$|zerone)/.test(url.pathname) ||
      (request.method() !== 'GET' && request.method() !== 'HEAD' && !permittedWrite.includes(url.pathname))) {
      forbiddenRequests.push({ path: url.pathname, method: request.method() }); return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/connections/crypto/watch' && request.method() === 'POST') {
      watchWrites++;
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body).sort(), ['address', 'display_name', 'network']);
      assert.equal(body.network, 'base');
      assert(metadata.every(marker => !JSON.stringify(body).includes(marker)), 'Wallet metadata must not enter watch creation');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { forbiddenRequests.push({ path: 'websocket' }); socket.close(); });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', () => pageErrors.push('Uncaught browser error'));
  await page.goto(origin, { waitUntil: 'networkidle' });
}
const fixture = (operation, ...args) => page.evaluate(({ operation, args }) => window.__cashloomWalletFixture[operation](...args), { operation, args });
const snapshot = () => fixture('snapshot');
const picker = () => page.getByRole('region', { name: 'Browser wallet picker', exact: true });
const form = () => page.getByRole('form', { name: 'Watch a wallet', exact: true });
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function navigate(name) { await page.getByRole('navigation', { name: 'Views', exact: true }).getByRole('button', { name, exact: true }).click(); }
async function unlock() {
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
}
async function openForm() {
  await navigate('Connections');
  await page.getByRole('button', { name: 'Add crypto wallet', exact: true }).click();
  await form().waitFor();
}
async function openPicker() {
  const before = (await snapshot()).discoveries;
  await form().getByRole('button', { name: 'Choose from a wallet', exact: true }).click();
  await picker().waitFor();
  await page.waitForFunction(before => window.__cashloomWalletFixture.snapshot().discoveries > before, before);
  await settle();
}
async function request(name = alphaName) { await picker().getByRole('button', { name: `Request addresses from ${name}`, exact: true }).click(); }
async function ready(name = alphaName) { await request(name); await picker().getByRole('radio', { name: addresses[0], exact: true }).waitFor(); }
async function pending() { await fixture('set', 'alpha', { next: 'pending' }); await request(); await page.waitForFunction(() => window.__cashloomWalletFixture.snapshot().pending.alpha === 1); }
async function api(path) {
  assert(['/api/accounts', '/api/vault/keys', '/api/transactions'].includes(path));
  const result = await page.evaluate(async path => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${sessionStorage.getItem('cashloom.session')}` } });
    return { status: response.status, data: await response.json() };
  }, path);
  assert.equal(result.status, 200); return result.data;
}
async function assertEphemeral() {
  const state = await page.evaluate(({ metadata, addresses }) => {
    const browserState = JSON.stringify({ href: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } });
    return { metadataAbsent: metadata.every(marker => !browserState.includes(marker)), addressesAbsent: addresses.every(address => !browserState.includes(address)) };
  }, { metadata, addresses });
  assert.deepEqual(state, { metadataAbsent: true, addressesAbsent: true });
}
async function closeContext() {
  const report = await snapshot();
  assert.deepEqual(report.forbidden, []); assert.equal(report.iconReads, 0); assert.equal(report.iconExecuted, false);
  methodReports.push({ discoveries: report.discoveries, methods: report.methods });
  await context.close(); context = null;
}

try {
  await start();
  browser = await chromium.launch({ executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  await newPage();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
  await openForm();
  assert.equal((await snapshot()).discoveries, 0); assert.deepEqual((await snapshot()).methods, []);
  await form().getByLabel('Wallet label', { exact: true }).fill(label);
  await openPicker();
  await picker().getByRole('button', { name: `Request addresses from ${alphaName}`, exact: true }).waitFor();
  assert.equal(await picker().getByRole('button', { name: /^Request addresses from/ }).count(), 2);
  assert.equal(await picker().locator('img, svg, iframe, object').count(), 0);
  assert.deepEqual((await snapshot()).methods, []);
  await fixture('spoof');
  assert.equal(await picker().getByRole('button', { name: /^Request addresses from/ }).count(), 2);
  assert.equal(await picker().getByText('Replacement must be ignored', { exact: false }).count(), 0);
  await picker().getByRole('button', { name: 'Discover wallets again', exact: true }).click();
  assert.equal(await picker().getByRole('button', { name: /^Request addresses from/ }).count(), 2);
  assert.deepEqual((await snapshot()).methods, []);
  pass('Explicit discovery lists multiple deduplicated wallets without requesting accounts or rendering untrusted icons/markup');

  await fixture('set', 'beta', { chain: '0x1' }); await request(betaName);
  await picker().getByRole('alert').filter({ hasText: 'Choose Base' }).waitFor();
  assert.deepEqual((await snapshot()).methods.filter(call => call.wallet === 'beta').map(call => call.method), ['eth_chainId']);
  await fixture('set', 'alpha', { next: 'deny' }); await request();
  await picker().getByRole('alert').filter({ hasText: 'declined' }).waitFor();
  assert.equal(await picker().getByRole('radio').count(), 0);
  await ready();
  assert.equal(await picker().getByRole('radio').count(), 2);
  assert.equal(await picker().locator('input:checked').count(), 0);
  assert(await picker().getByRole('button', { name: 'Use this address', exact: true }).isDisabled());
  assert.equal((await api('/api/accounts')).accounts.length, 0); assert.equal(watchWrites, 0);
  pass('Wrong network is refused before permission; decline can retry and a normal initial accountsChanged approval exposes unselected addresses');

  for (const [event, value] of [['accountsChanged', [addresses[2]]], ['chainChanged', '0x1'], ['disconnect', { code: 4900 }]]) {
    await picker().getByRole('radio', { name: addresses[0], exact: true }).check();
    await fixture('emit', 'alpha', event, value);
    await picker().getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    assert.equal(await picker().getByRole('radio').count(), 0);
    assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
    await fixture('set', 'alpha', { chain: '0x2105' }); await ready();
  }
  await fixture('set', 'alpha', { afterApproveChain: '0x1' }); await request();
  await picker().getByRole('alert').filter({ hasText: 'Choose Base' }).waitFor();
  assert.equal(await picker().getByRole('radio').count(), 0);
  await fixture('set', 'alpha', { chain: '0x2105' }); await ready();
  await picker().getByRole('radio', { name: addresses[0], exact: true }).check();
  await fixture('set', 'alpha', { chain: '0x1' });
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click();
  await picker().getByRole('alert').filter({ hasText: 'Choose Base' }).waitFor();
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await fixture('set', 'alpha', { chain: '0x2105' }); await ready();
  pass('Later account/network/disconnect events and silent network changes invalidate review; Base is checked again after approval and before use');

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 950 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(root, `browser-wallet-picker-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await picker().getByRole('radio', { name: addresses[1], exact: true }).check();
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click();
  await picker().waitFor({ state: 'hidden' });
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), addresses[1]);
  assert.equal(await form().getByLabel('Wallet label', { exact: true }).inputValue(), label);
  assert.equal(watchWrites, 0); assert.equal((await api('/api/accounts')).accounts.length, 0);
  assert.equal((await snapshot()).listeners.alpha, 0);
  await fixture('emit', 'alpha', 'accountsChanged', [addresses[2]]); await settle();
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), addresses[1]);
  await assertEphemeral();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/connections/crypto/watch' && response.request().method() === 'POST');
  await form().getByRole('button', { name: 'Add watched wallet', exact: true }).click();
  assert.equal((await created).status(), 201);
  const row = page.getByRole('article', { name: label, exact: true }); await row.waitFor();
  const account = (await api('/api/accounts')).accounts[0];
  assert.equal(account.account_ref, `eip155:8453:${addresses[1]}`);
  for (const key of ['vault_key_id', 'connector_type', 'credential_ref', 'balance_as_of']) assert.equal(account[key], null);
  assert.equal(await row.getByRole('button', { name: 'Send money', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Receive money', exact: true }).count(), 0);
  pass('Explicit address choice only fills the editable draft; separate save creates a keyless Base watch with no payment authority');

  await openForm(); await form().getByLabel('Wallet label', { exact: true }).fill('Duplicate should preserve original'); await openPicker();
  await ready(); await picker().getByRole('radio', { name: addresses[1], exact: true }).check();
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click(); await picker().waitFor({ state: 'hidden' });
  await form().getByRole('button', { name: 'Add watched wallet', exact: true }).click(); await row.waitFor();
  const saved = (await api('/api/accounts')).accounts;
  assert.equal(saved.length, 1); assert.equal(saved[0].id, account.id); assert.equal(saved[0].display_name, label);
  assert.equal((await api('/api/vault/keys')).keys.length, 0); assert.equal((await api('/api/transactions')).transactions.length, 0);
  pass('A second explicit save of the same selected address reuses its account and creates no key or fabricated activity');

  await openForm(); await openPicker(); await pending();
  await fixture('emit', 'alpha', 'chainChanged', '0x1');
  await picker().getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  await fixture('resolve', 'alpha'); await settle();
  assert.equal(await picker().getByRole('radio').count(), 0);
  await fixture('set', 'alpha', { chain: '0x2105' }); await pending();
  await picker().getByRole('button', { name: 'Close wallet picker', exact: true }).click();
  await fixture('resolve', 'alpha'); await settle();
  assert.equal(await picker().count(), 0); assert.equal((await snapshot()).listeners.alpha, 0);
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await openPicker(); await pending(); await navigate('Overview');
  await fixture('resolve', 'alpha'); await settle();
  assert.equal(await picker().count(), 0); assert.equal((await snapshot()).listeners.alpha, 0);
  await openForm(); assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await openPicker(); await pending();
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await page.getByLabel('Passphrase', { exact: true }).waitFor();
  await fixture('resolve', 'alpha'); await settle();
  assert.equal(await picker().count(), 0); assert.equal((await snapshot()).listeners.alpha, 0);
  await unlock(); await openForm();
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  assert.equal((await api('/api/accounts')).accounts.length, 1); assert.equal(watchWrites, 2);
  await assertEphemeral(); await closeContext();
  pass('Pending chain changes, picker close, navigation and lock invalidate late approvals and clean up provider listeners');

  await newPage('legacy'); await unlock(); await openForm(); await openPicker();
  assert.equal(await picker().getByRole('button', { name: /^Request addresses from/ }).count(), 1);
  await ready('Browser wallet (legacy)');
  await picker().getByRole('radio', { name: addresses[0], exact: true }).check();
  await fixture('announce', 'beta');
  await picker().getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await picker().getByRole('radio').count(), 0);
  assert.equal(await picker().getByRole('button', { name: 'Request addresses from Browser wallet (legacy)', exact: true }).count(), 0);
  assert.equal((await snapshot()).listeners.alpha, 0);
  await assertEphemeral(); await closeContext();
  pass('Legacy injection is a named fallback only; a later standard announcement invalidates its active selection');

  await newPage('none'); await unlock(); await openForm(); await openPicker();
  await picker().getByRole('status').filter({ hasText: 'No browser wallet has been found' }).waitFor();
  await picker().getByRole('button', { name: 'Discover wallets again', exact: true }).click();
  assert.deepEqual((await snapshot()).methods, []);
  await picker().getByRole('button', { name: 'Close wallet picker', exact: true }).click();
  await form().getByLabel('Public wallet address', { exact: true }).fill(addresses[2]);
  assert.equal(watchWrites, 2); assert.equal((await api('/api/accounts')).accounts.length, 1);
  await assertEphemeral(); await closeContext();
  pass('No installed wallet has a useful empty state and leaves manual public-address entry available');

  assert.equal(JSON.parse(readFileSync(callsPath, 'utf8')).calls, 0, 'Browser address selection or watch saving attempted backend RPC');
  for (const suffix of ['', '-wal']) {
    const file = join(data, `sovereign.db${suffix}`);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (const marker of [...metadata, addresses[0], addresses[2]]) assert(!bytes.includes(Buffer.from(marker)), 'Unselected wallet data or metadata entered SQLite');
  }
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
  pass('Only approved read methods were called; no external browser requests, provider RPC, metadata persistence or unselected-address persistence occurred');
} finally {
  await context?.close(); await browser?.close(); await stop();
  writeFileSync(join(root, 'browser-wallet-result.json'), JSON.stringify({ checks, pageErrors, forbiddenRequests, methodReports,
    fixture: 'Actual isolated local node and UI; synthetic EIP-6963/EIP-1193 providers, no real extensions or profiles; run.py denies non-loopback network access' }, null, 2));
}
console.log(`Actual-node synthetic browser-wallet checks: ${checks.length} passed; processes stopped`);
