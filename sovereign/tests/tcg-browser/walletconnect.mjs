// Actual isolated node and compiled UI/controller; synthetic Worker messages.
// This is a lifecycle/UX rehearsal, not a relay or real-wallet compatibility test.
// The separate SDK probe exercises production worker init and network restrictions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = process.env.TCG_BROWSER_ROOT;
assert(root && existsSync(join(root, '.tcg-browser-fixture')), 'Use the isolated run.py runner');
const nodeRoot = join(root, 'node', 'sovereign'), data = join(root, 'phone-wallet-data');
mkdirSync(data, { mode: 0o700 });
const passphrase = randomUUID() + randomUUID();
const addresses = [4, 5, 6].map(byte => `0x${String(byte).repeat(40)}`);
const label = 'Phone-selected Base watch';
const { chromium } = await import(pathToFileURL(process.env.TCG_BROWSER_DRIVER).href);
const checks = [], pageErrors = [], forbiddenRequests = [], workerReports = [];
const callsPath = join(root, 'walletconnect-rpc-calls.json');
const preload = join(root, 'phone-wallet-no-rpc.ts');
writeFileSync(preload, `import { existsSync, realpathSync, writeFileSync } from 'node:fs';
const root = process.env.TCG_BROWSER_ROOT;
if (!root || !existsSync(root + '/.tcg-browser-fixture') || realpathSync(process.env.HOME!) !== realpathSync(root + '/home') || realpathSync(process.env.CASHLOOM_DATA_DIR!) !== realpathSync(root + '/phone-wallet-data')) throw new Error('Isolated phone-wallet fixture required');
let calls = 0; const record = () => writeFileSync(root + '/walletconnect-rpc-calls.json', JSON.stringify({ calls })); record();
globalThis.fetch = (async () => { calls++; record(); throw new Error('No outgoing fetch allowed during phone-wallet rehearsal'); }) as unknown as typeof fetch;
`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
let server, browser, context, page, origin, output = '', watchWrites = 0;

async function start(configured) {
  output = '';
  server = spawn(process.env.TCG_BROWSER_BUN, ['--no-env-file', '--no-install', '--preload', preload, join(nodeRoot, 'src/index.ts')], {
    cwd: join(root, 'home'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CASHLOOM_DATA_DIR: data, CASHLOOM_BIND: '127.0.0.1', CASHLOOM_PORT: '0', CASHLOOM_BASE_RECONCILIATION_ENABLED: '0',
      CASHLOOM_BASE_RPC_URL: 'https://base-a.invalid/rpc', CASHLOOM_BASE_CONFIRMATION_RPC_URL: 'https://base-b.invalid/rpc',
      // Syntactically valid fixture identifier only; never sent to any relay.
      CASHLOOM_WALLETCONNECT_PROJECT_ID: configured ? 'f'.repeat(32) : '' },
  });
  const capture = chunk => { output = (output + String(chunk)).slice(-12000); };
  server.stdout.on('data', capture); server.stderr.on('data', capture);
  for (let count = 0; count < 200; count++) {
    const ready = output.match(/cashloom sovereign · (http:\/\/127\.0\.0\.1:(\d+))/);
    if (ready) { origin = ready[1]; return; }
    assert(server.exitCode === null, 'Isolated phone-wallet node exited before readiness');
    await delay(50);
  }
  throw new Error('Isolated phone-wallet node readiness timed out');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM'); await Promise.race([done, delay(2000)]);
  if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await done; }
}

function installSyntheticTransport({ addresses }) {
  const workers = [], commands = [], rejected = [], uris = [];
  let holdStart = false, holdConfirm = false, acknowledgeClose = true;
  const expiry = () => new Date(Date.now() + 240_000).toISOString();
  const latest = () => workers.at(-1);
  class FixtureWorker {
    onmessage = null; onerror = null; terminated = false; captured = null;
    constructor(url, options) {
      if (!String(url).includes('walletconnect-worker') || options?.type !== 'module') {
        rejected.push('Unexpected Worker'); throw new Error('Fixture supports the phone-pairing worker only');
      }
      workers.push(this);
    }
    deliver(data, late = false) {
      const handler = late ? this.captured : this.onmessage;
      queueMicrotask(() => handler?.({ data }));
    }
    postMessage(message) {
      commands.push(message.type);
      if (message.type === 'start') {
        if (message.origin !== location.origin || !/^[0-9a-f]{32}$/.test(message.project_id)) rejected.push('Invalid startup boundary');
        this.captured = this.onmessage;
        if (!holdStart) {
          // Random synthetic bootstrap data is kept only in this test page.
          // It is neither a valid live pairing nor included in test artifacts.
          const hex = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          const uri = `wc:${hex()}@2?relay-protocol=irn&symKey=${hex()}`; uris.push(uri);
          this.deliver({ type: 'pairing', uri, expires_at: expiry() });
        }
      } else if (message.type === 'confirm') {
        if (!addresses.includes(message.address)) rejected.push('Unexpected address confirmation');
        this.confirmation = { type: 'confirmed', request_id: message.request_id, address: message.address };
        if (!holdConfirm) this.deliver(this.confirmation);
      } else if (message.type === 'close') { if (acknowledgeClose) this.deliver({ type: 'closed' }); }
      else { rejected.push('Unexpected worker command'); throw new Error('Unexpected worker command'); }
    }
    terminate() { this.terminated = true; }
  }
  window.Worker = FixtureWorker;
  window.__cashloomPhoneFixture = {
    approve(late = false) { latest().deliver({ type: 'ready', accounts: addresses.slice(0, 2), expires_at: expiry() }, late); },
    error(code) { latest().deliver({ type: 'error', code }); },
    confirmLate() { latest().deliver(latest().confirmation, true); },
    hold(start, confirm) { holdStart = start; holdConfirm = confirm; },
    acknowledgeClose(value) { acknowledgeClose = value; },
    snapshot() { return { created: workers.length, alive: workers.filter(worker => !worker.terminated).length, commands: [...commands], rejected: [...rejected] }; },
    privacy() {
      const persisted = JSON.stringify({ href: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } });
      const html = document.documentElement.outerHTML;
      return { uriAbsent: uris.every(uri => !persisted.includes(uri) && !html.includes(uri)),
        addressAbsent: addresses.every(address => !persisted.includes(address)),
        noRawUriLinks: ![...document.querySelectorAll('a,input,textarea')].some(node => String(node.href ?? node.value ?? '').includes('wc:')) };
    },
  };
}

async function newPage() {
  context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  await context.addInitScript(installSyntheticTransport, { addresses });
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
      assert.equal(body.network, 'base'); assert.equal(body.address, addresses[1]);
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { forbiddenRequests.push({ path: 'websocket' }); socket.close(); });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', () => pageErrors.push('Uncaught browser error'));
  await page.goto(origin, { waitUntil: 'networkidle' });
}
const fixture = (operation, ...args) => page.evaluate(({ operation, args }) => window.__cashloomPhoneFixture[operation](...args), { operation, args });
const snapshot = () => fixture('snapshot');
const picker = () => page.getByRole('region', { name: 'Phone wallet pairing', exact: true });
const form = () => page.getByRole('form', { name: 'Watch a wallet', exact: true });
const startButton = () => picker().getByRole('button', { name: /^(Start pairing|Start new pairing)$/ });
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
  await form().getByRole('button', { name: 'Connect a phone wallet', exact: true }).click();
  await picker().waitFor();
}
async function begin() {
  await startButton().click();
  const canvas = picker().getByRole('img', { name: 'Wallet pairing QR code', exact: true });
  await canvas.waitFor();
  assert(await canvas.evaluate(node => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
    let dark = false, light = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && pixels[i] < 50) dark = true;
      if (pixels[i + 3] > 0 && pixels[i] > 200) light = true;
    }
    return node.width > 0 && node.height > 0 && dark && light;
  }), 'QR canvas must contain rendered light and dark pixels');
}
async function approve() {
  await fixture('approve');
  await picker().getByRole('radio', { name: addresses[0], exact: true }).waitFor();
}
async function api(path) {
  assert(['/api/accounts', '/api/vault/keys', '/api/transactions'].includes(path));
  const result = await page.evaluate(async path => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${sessionStorage.getItem('cashloom.session')}` } });
    return { status: response.status, data: await response.json() };
  }, path);
  assert.equal(result.status, 200); return result.data;
}
async function privacy() { assert.deepEqual(await fixture('privacy'), { uriAbsent: true, addressAbsent: true, noRawUriLinks: true }); }
async function closedWorkers() { await page.waitForFunction(() => window.__cashloomPhoneFixture.snapshot().alive === 0); }
async function screenshot(name, hideQr = false) {
  assert(await page.evaluate(() => {
    const skip = document.querySelector('.skip-link');
    return !skip || (document.activeElement !== skip && skip.getBoundingClientRect().bottom <= 0);
  }), 'Mouse pairing flow must not focus or expose the skip link');
  // Chromium may reposition fixed offscreen elements when expanding a tall
  // element screenshot. Suppress only the already-hidden, unfocused skip link.
  await picker().screenshot({ path: join(root, name), animations: 'disabled',
    style: '.skip-link:not(:focus) { visibility: hidden !important; }',
    ...(hideQr ? { mask: [picker().getByRole('img', { name: 'Wallet pairing QR code', exact: true })], maskColor: '#edf2e7' } : {}) });
}
async function closeContext() {
  await closedWorkers(); const report = await snapshot(); assert.deepEqual(report.rejected, []); workerReports.push(report);
  await context.close(); context = null;
}

try {
  await start(false);
  browser = await chromium.launch({ executablePath: process.env.TCG_BROWSER_CHROMIUM, headless: true, args: ['--disable-background-networking'] });
  await newPage();
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Views', exact: true }).waitFor();
  await openForm(); await openPicker();
  await picker().getByText('CASHLOOM_WALLETCONNECT_PROJECT_ID', { exact: false }).waitFor();
  assert.equal(await startButton().count(), 0); assert.equal((await snapshot()).created, 0);
  await picker().getByRole('button', { name: 'Cancel pairing', exact: true }).click();
  await form().getByLabel('Public wallet address', { exact: true }).fill(addresses[2]);
  assert.equal(watchWrites, 0); await privacy(); await closeContext(); await stop();
  pass('Missing configuration has an actionable local setup state and retains manual entry without starting a worker or relay');

  await start(true); await newPage(); await unlock(); await openForm();
  assert.equal((await snapshot()).created, 0);
  await form().getByLabel('Wallet label', { exact: true }).fill(label); await openPicker();
  await startButton().waitFor(); assert.equal((await snapshot()).created, 0);
  assert(await form().getByRole('button', { name: 'Add watched wallet', exact: true }).isDisabled());
  await begin(); assert.equal((await snapshot()).created, 1);
  assert.equal(await picker().getByRole('radio').count(), 0); await privacy();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 950 }); await settle();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await picker().scrollIntoViewIfNeeded();
    // Blank the QR in the captured artifact, even though it is synthetic.
    await screenshot(`walletconnect-pairing-${width}.png`, true);
  }
  pass('Only explicit Start pairing creates the worker; the synthetic QR fits desktop/mobile and its URI stays out of DOM links and storage');

  await fixture('error', 'phone_declined'); await picker().getByRole('alert').filter({ hasText: 'declined' }).waitFor();
  await begin(); await approve();
  assert.equal(await picker().getByRole('radio').count(), 2); assert.equal(await picker().locator('input:checked').count(), 0);
  assert(await picker().getByRole('button', { name: 'Use this address', exact: true }).isDisabled());
  for (const code of ['phone_changed', 'phone_scope_refused', 'phone_expired']) {
    await picker().getByRole('radio', { name: addresses[0], exact: true }).check();
    await fixture('error', code); await picker().getByRole('alert').waitFor();
    assert.equal(await picker().getByRole('radio').count(), 0);
    assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
    await begin(); await approve();
  }
  assert.equal(watchWrites, 0); assert.equal((await api('/api/accounts')).accounts.length, 0);
  pass('Decline can retry; returned addresses need explicit choice, and changed, overbroad or expired sessions invalidate selection');

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 950 }); await settle();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await picker().scrollIntoViewIfNeeded();
    await screenshot(`walletconnect-addresses-${width}.png`);
  }
  await picker().getByRole('radio', { name: addresses[1], exact: true }).check();
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click(); await picker().waitFor({ state: 'hidden' });
  await closedWorkers();
  assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), addresses[1]);
  assert.equal(await form().getByLabel('Wallet label', { exact: true }).inputValue(), label);
  assert.equal(watchWrites, 0); await privacy();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/connections/crypto/watch' && response.request().method() === 'POST');
  await form().getByRole('button', { name: 'Add watched wallet', exact: true }).click(); assert.equal((await created).status(), 201);
  const row = page.getByRole('article', { name: label, exact: true }); await row.waitFor();
  const account = (await api('/api/accounts')).accounts[0];
  assert.equal(account.account_ref, `eip155:8453:${addresses[1]}`);
  for (const key of ['vault_key_id', 'connector_type', 'credential_ref', 'balance_as_of']) assert.equal(account[key], null);
  assert.equal(await row.getByRole('button', { name: 'Send money', exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Receive money', exact: true }).count(), 0);
  pass('Use this address only fills the draft and ends pairing; explicit Add watched wallet saves a keyless watch with no payment authority');

  await openForm(); await form().getByLabel('Wallet label', { exact: true }).fill('Duplicate keeps original');
  await openPicker(); await begin(); await approve();
  await picker().getByRole('radio', { name: addresses[1], exact: true }).check();
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click(); await picker().waitFor({ state: 'hidden' });
  await form().getByRole('button', { name: 'Add watched wallet', exact: true }).click(); await row.waitFor();
  const saved = (await api('/api/accounts')).accounts;
  assert.equal(saved.length, 1); assert.equal(saved[0].id, account.id); assert.equal(saved[0].display_name, label);
  assert.equal((await api('/api/vault/keys')).keys.length, 0); assert.equal((await api('/api/transactions')).transactions.length, 0);
  pass('A second explicit save reuses the existing account without a key, duplicate balance or fabricated activity');

  await openForm(); await openPicker(); await begin();
  await picker().getByRole('button', { name: 'Cancel pairing', exact: true }).click(); await closedWorkers();
  await fixture('approve', true); await settle();
  assert.equal(await picker().count(), 0); assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await openPicker(); await begin();
  await form().getByRole('button', { name: 'Cancel', exact: true }).click(); await closedWorkers();
  await fixture('approve', true); await settle();
  await openForm(); assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await openPicker(); await begin();
  const createdBeforeHide = (await snapshot()).created;
  assert(await page.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label="Wallet pairing QR code"]');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return canvas !== null && canvas.width === 0 && canvas.height === 0 && window.__cashloomPhoneFixture.snapshot().alive === 0;
  }), 'Pagehide must clear QR pixels and terminate the worker synchronously, before a page freeze can pause timers');
  await picker().waitFor({ state: 'hidden' }); await closedWorkers();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await fixture('approve', true); await settle();
  assert.equal(await picker().count(), 0); assert.equal((await snapshot()).created, createdBeforeHide);
  await openPicker(); await startButton().waitFor(); assert.equal((await snapshot()).created, createdBeforeHide);
  await picker().getByRole('button', { name: 'Cancel pairing', exact: true }).click();
  await fixture('hold', true, false); await fixture('acknowledgeClose', false); await openPicker(); await startButton().click();
  await page.waitForFunction(() => window.__cashloomPhoneFixture.snapshot().alive === 1);
  const cleanupStarted = Date.now(); await navigate('Overview'); await closedWorkers();
  assert(Date.now() - cleanupStarted < 2500, 'Unmount must terminate an unresponsive worker within its bounded close deadline');
  await fixture('acknowledgeClose', true); await fixture('approve', true); await settle();
  await openForm(); assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  await fixture('hold', false, true); await openPicker(); await begin(); await approve();
  await picker().getByRole('radio', { name: addresses[0], exact: true }).check();
  const confirmations = (await snapshot()).commands.filter(command => command === 'confirm').length;
  await picker().getByRole('button', { name: 'Use this address', exact: true }).click();
  await page.waitForFunction(before => window.__cashloomPhoneFixture.snapshot().commands.filter(command => command === 'confirm').length > before, confirmations);
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await page.getByLabel('Passphrase', { exact: true }).waitFor();
  await closedWorkers(); await fixture('confirmLate'); await settle(); assert.equal(await picker().count(), 0);
  await unlock(); await openForm(); assert.equal(await form().getByLabel('Public wallet address', { exact: true }).inputValue(), '');
  assert.equal((await api('/api/accounts')).accounts.length, 1); assert.equal(watchWrites, 2); await privacy();
  await closeContext();
  pass('Cancel, pagehide, navigation and lock stop pairing, including the close timer; QR clears immediately and late results cannot restore addresses');

  assert.equal(JSON.parse(readFileSync(callsPath, 'utf8')).calls, 0, 'Phone pairing or watch save attempted backend RPC');
  for (const suffix of ['', '-wal']) {
    const file = join(data, `sovereign.db${suffix}`); if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (const marker of [addresses[0], addresses[2], 'symKey=', 'wc:']) assert(!bytes.includes(Buffer.from(marker)), 'Pairing data or unselected address entered SQLite');
  }
  assert.deepEqual(pageErrors, []); assert.deepEqual(forbiddenRequests, []);
  pass('No browser egress, backend RPC, signing command, pairing persistence or unselected-address persistence occurred');
} finally {
  await context?.close(); await browser?.close(); await stop();
  writeFileSync(join(root, 'walletconnect-result.json'), JSON.stringify({ checks, pageErrors, forbiddenRequests, workerReports,
    fixture: 'Actual isolated local node and compiled UI/controller; synthetic Worker protocol, no live relay or wallet; production SDK coverage is reported by the separate SDK probe' }, null, 2));
}
console.log(`Actual-node simulated phone-wallet checks: ${checks.length} passed; processes stopped`);
