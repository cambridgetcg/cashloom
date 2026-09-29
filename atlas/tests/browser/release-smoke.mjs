/** Deployed public-service smoke test. Never loads a personal browser profile.
 *
 * node atlas/tests/browser/release-smoke.mjs --origin https://cashloom.io
 * Add --baseline to observe an older deployment without asserting the new UI.
 * Set CASHLOOM_PLAYWRIGHT_PATH and CASHLOOM_BROWSER_EXECUTABLE to an installed,
 * matching playwright-core entrypoint and Chromium executable. No installation,
 * deployment, credentials, provider account access or wallet operations occur.
 * Exit: 0 verified / baseline observed; 1 assertion failure; 2 capability gaps.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const originIndex = args.indexOf("--origin");
const originInput = originIndex >= 0 ? args[originIndex + 1] : process.env.CASHLOOM_RELEASE_ORIGIN;
assert.ok(originInput, "Choose an explicit --origin (loopback, https://cashloom.io, or a Pages preview).");
const url = new URL(originInput);
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const deployed = url.protocol === "https:" && !url.port && (url.hostname === "cashloom.io" || /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.pages\.dev$/.test(url.hostname));
assert.ok((loopback && ["http:", "https:"].includes(url.protocol)) || deployed, "Origin is outside the explicit public-test allowlist.");
assert.ok(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "Use an origin only, without credentials, paths or query data.");
const origin = url.origin;
const baseline = args.includes("--baseline");
const output = process.env.CASHLOOM_RELEASE_OUTPUT ?? `/tmp/cashloom-release-smoke-${Date.now()}`;
assert.ok(process.env.CASHLOOM_PLAYWRIGHT_PATH, "Set CASHLOOM_PLAYWRIGHT_PATH to the installed playwright-core entrypoint.");
assert.ok(process.env.CASHLOOM_BROWSER_EXECUTABLE, "Set CASHLOOM_BROWSER_EXECUTABLE to the matching Chromium executable.");
await mkdir(output, { recursive: true });

const report = { origin, mode: baseline ? "baseline" : "release", startedAt: new Date().toISOString(), checks: [], failures: [], gaps: [], observations: [], externalRequests: [], assetErrors: [], pageErrors: [], unintendedWrites: [], plannerRequests: [], api: {}, routes: [], releaseReady: false };
let editingPlan = false;
function pass(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function gap(name) { if (!report.gaps.includes(name)) report.gaps.push(name); console.log(`GAP ${name}`); }
async function check(name, work) {
  try {
    const priorGaps = report.gaps.length;
    await work();
    if (report.gaps.length === priorGaps) pass(name);
    else report.observations.push({ check: name, state: "gap", passed: false });
  }
  catch (error) { const detail = `${name}: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`; report.failures.push(detail); console.log(`FAIL ${detail}`); }
}
function endpointPath(raw) { const parsed = new URL(raw); return `${parsed.origin}${parsed.pathname}`; }
function isApi(pathname) { return pathname.startsWith("/api/") || pathname.startsWith("/v1/"); }

/** Separate, unauthenticated requests: no cookies, auth headers, redirect following
 * or user-supplied bodies. The sole POST is an empty private-route refusal probe. */
async function publicRequest(pathname, method = "GET", headers = {}) {
  const target = new URL(pathname, origin);
  assert.equal(target.origin, origin);
  const response = await fetch(target, { method, headers: { Accept: "application/json", ...headers }, redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(20_000) });
  const reader = response.body?.getReader();
  const chunks = []; let bytes = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; assert.ok(bytes <= 2.5 * 1024 * 1024, "Public response exceeded the smoke-test body budget."); chunks.push(value);
    }
  } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
  finally { reader?.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = response.headers.get("content-type") ?? "";
  const json = /(?:application\/json|\+json)/i.test(type) && text ? JSON.parse(text) : null;
  return { status: response.status, type, bytes, json, etag: response.headers.get("etag"), cache: response.headers.get("cache-control") };
}

const { chromium } = await import(pathToFileURL(process.env.CASHLOOM_PLAYWRIGHT_PATH).href);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CASHLOOM_BROWSER_EXECUTABLE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 }, colorScheme: "light", serviceWorkers: "block", acceptDownloads: false });
  context.setDefaultTimeout(8_000); context.setDefaultNavigationTimeout(20_000);
  await context.route("**/*", async (route) => {
    const request = route.request(); const parsed = new URL(request.url());
    if (parsed.origin !== origin) {
      report.externalRequests.push({ url: endpointPath(request.url()), type: request.resourceType() });
      await route.abort(); return;
    }
    if (editingPlan && (["fetch", "xhr", "eventsource", "websocket"].includes(request.resourceType()) || /Synthetic|1000\.10|250\.20/.test(parsed.search))) {
      report.plannerRequests.push({ path: parsed.pathname, type: request.resourceType() });
      await route.abort(); return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      report.unintendedWrites.push({ path: parsed.pathname, method: request.method() });
      await route.abort(); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("dialog", (dialog) => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  page.on("response", (response) => {
    const parsed = new URL(response.url());
    if (parsed.origin === origin && response.status() >= 400 && !isApi(parsed.pathname)) report.assetErrors.push(`${response.status()} ${parsed.pathname}`);
  });
  page.on("requestfailed", (request) => {
    const parsed = new URL(request.url());
    if (parsed.origin === origin && !isApi(parsed.pathname) && !request.failure()?.errorText.includes("ERR_ABORTED")) report.assetErrors.push(`${request.failure()?.errorText ?? "failed"} ${parsed.pathname}`);
  });

  const routes = [
    ["/", /Your money\.\s*Your direction\./, "/"],
    ["/plan", /A little clarity\.\s*A lot more control\./, "/plan"],
    ["/wallet", /Know where you stand\.\s*Choose what comes next\./, "/wallet"],
    ["/connections", /Bring your money\s*into focus\./, "/connections"],
    ["/world", /Understand money,\s*with source receipts\./, "/world"],
    ["/capital-flows", /^Capital flows$/, "/capital-flows"],
    ["/onchain", /Understand the networks\s*money moves through\./, "/onchain"],
    ["/atlas", /^Understand your workspace\.$/, "/atlas"],
  ];
  for (const [route, heading, current] of routes) await check(`human route ${route}`, async () => {
    const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
    assert.ok(response && response.status() === 200, "Human route did not return 200.");
    assert.equal(new URL(page.url()).origin, origin, "Navigation left the selected origin.");
    await page.locator("h1").first().waitFor();
    const observed = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ").trim();
    report.routes.push({ path: route, heading: observed, title: await page.title() });
    if (!heading.test(observed)) {
      if (baseline) { gap(`Current release UI not deployed at ${route}`); return; }
      assert.match(observed, heading);
    }
    const nav = page.getByRole("navigation", { name: "CashLoom", exact: true });
    if (baseline && !(await nav.count())) { gap(`Current release navigation not deployed at ${route}`); return; }
    await nav.waitFor();
    assert.equal(await nav.locator('a[aria-current="page"]').getAttribute("href"), current);
    for (const width of [1365, 390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} overflows at ${width}px.`);
    }
    await page.setViewportSize({ width: 1365, height: 950 });
  });

  await check("planner edits remain local and calculate exact monthly amounts", async () => {
    await page.goto(`${origin}/plan`, { waitUntil: "domcontentloaded" });
    await page.locator("h1").first().waitFor();
    if (baseline && !(await page.getByRole("button", { name: "Add income", exact: true }).count())) { gap("New browser-only money planner is not deployed"); return; }
    await page.getByRole("button", { name: "Add income", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
    editingPlan = true;
    try {
    for (const [button, label, amount] of [["Add income", "Synthetic release income", "1000.10"], ["Add a commitment", "Synthetic release cost", "250.20"]]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await page.locator("input:focus").fill(label);
      await page.getByRole("textbox", { name: `Per month for ${label}`, exact: true }).fill(amount);
    }
    assert.equal(await page.locator(".plan-remainder strong").innerText(), "£749.90");
    assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null, "Saving must be opt-in.");
    assert.equal(new URL(page.url()).search, "", "Plan entries must not appear in the URL.");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Populated planner overflows at ${width}px.`);
    }
    await page.getByRole("combobox", { name: "Currency", exact: true }).selectOption("USD");
    await page.getByRole("radio", { name: "Our household", exact: true }).check();
    await page.getByRole("button", { name: "Clear plan", exact: true }).click();
    await page.getByRole("button", { name: "Yes, clear plan", exact: true }).click();
    assert.equal(await page.locator(".plan-entry").count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Currency", exact: true }).inputValue(), "USD");
    assert.equal(await page.getByRole("radio", { name: "Our household", exact: true }).isChecked(), true);
    await page.setViewportSize({ width: 1365, height: 950 });
    assert.deepEqual(report.plannerRequests, [], "Planner edits must not trigger network data requests.");
    } finally { editingPlan = false; }
  });

  await check("workspace guide discloses local operation and source-access requirements", async () => {
    await page.goto(`${origin}/wallet`, { waitUntil: "domcontentloaded" });
    await page.locator("h1").first().waitFor();
    const copy = await page.locator("body").innerText();
    if (baseline && !/no hosted workspace sign-in/i.test(copy)) { gap("New local-workspace guide is not deployed"); return; }
    assert.match(copy, /no hosted workspace sign-in/i);
    assert.match(copy, /does not open your private node or ask for your keys/i);
    const sourceLinks = await page.locator('a[href*="github.com/cambridgetcg/cashloom"]').evaluateAll((links) => links.map((link) => ({ href: link.href, text: link.textContent })));
    report.observations.push({ sourceLinks, sourceLinksOpened: false });
    if (!/repository access|source access|access to (?:the |this )?(?:source|repository)|private repository|source repository.{0,40}private|invitation/i.test(copy)) gap("Source access restriction is not explicitly disclosed in the workspace guide");
  });

  await check("connection requirements reach local setup and actionable sandbox guidance", async () => {
    await page.goto(`${origin}/connections`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Read workspace requirements", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, "/wallet");
    assert.equal(new URL(page.url()).hash, "#setup");
    await page.waitForFunction(() => {
      const top = document.getElementById("setup")?.getBoundingClientRect().top;
      return top !== undefined && top >= -1 && top < innerHeight / 2;
    });
    const guide = page.locator("#connections");
    assert.match(await guide.innerText(), /Connect a test bank/);
    assert.match(await guide.innerText(), /Only supported USD test accounts/);
    assert.ok(await guide.locator('a[href*="README.md#unified-money-view-local-pilot"]').count());
  });

  await check("agent setup handoff keeps local scope and owner review explicit", async () => {
    await page.goto(`${origin}/connections`, { waitUntil: "domcontentloaded" });
    const link = page.getByRole("link", { name: "Understand agent access", exact: true });
    if (baseline && !(await link.count())) { gap("Local agent setup guide is not deployed"); return; }
    await link.click();
    await page.getByRole("heading", { name: "Let an agent help sort your records.", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/wallet");
    assert.equal(new URL(page.url()).hash, "#agents");
    await page.waitForFunction(() => {
      const top = document.getElementById("agents")?.getBoundingClientRect().top;
      return top !== undefined && top >= -1 && top < innerHeight / 2;
    });
    const copy = await page.locator("#agents").innerText();
    assert.match(copy, /You apply or reject it/);
    assert.match(copy, /does not include a hosted model/);
    assert.match(copy, /may send records to its model provider/);
    assert.match(copy, /cannot refresh providers, change balances, approve suggestions or send money/);
    for (const width of [1365, 320]) {
      await page.setViewportSize({ width, height: 950 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.setViewportSize({ width: 1365, height: 950 });
  });

  await check("public API identifies the INFO process", async () => {
    const result = await publicRequest("/api/meta"); report.api.meta = result;
    assert.equal(result.status, 200); assert.equal(result.json?.mode, "info"); assert.equal(result.json?.name, "cashloom-info");
  });
  for (const endpoint of ["/api/accounts", "/api/transactions?q=synthetic", "/api/connections", "/api/plaid/status", "/api/wallet/positions", "/api/vault/status", "/api/assist/access", "/api/assist/context", "/api/assist/proposals", "/api/assist/review"]) await check(`private route absent: ${endpoint}`, async () => {
    const result = await publicRequest(endpoint); report.api[endpoint] = { status: result.status, type: result.type };
    assert.equal(result.status, 404); assert.ok(result.json && typeof result.json === "object", "Private route must return a JSON refusal, never the SPA or private data.");
  });
  await check("public edge refuses a private POST", async () => {
    const result = await publicRequest("/api/pay/confirm", "POST"); report.api.privatePost = { status: result.status, type: result.type };
    assert.equal(result.status, 405); assert.ok(result.json, "POST refusal must be JSON.");
  });
  await check("capital-flow API availability is reported truthfully", async () => {
    const result = await publicRequest("/v1/capital-flows");
    report.api.capitalFlows = { status: result.status, type: result.type, bytes: result.bytes, refresh: result.json?.refresh, cache: result.cache };
    if (result.status === 404) { gap("Hosted /v1/capital-flows is not deployed (404); capital-flow capability is unavailable"); return; }
    assert.equal(result.status, 200); assert.equal(result.json?.schema, "cashloom.capital-flows/1");
    assert.match(result.cache ?? "", /must-revalidate/);
    report.observations.push({ capitalSourceStates: result.json.sources.map((source) => ({ id: source.definition.id, state: source.retrievalState, failure: source.failure })) });
    assert.ok(result.etag, "Capital response must expose an ETag.");
    const head = await publicRequest("/v1/capital-flows", "HEAD"); assert.equal(head.status, 200); assert.equal(head.bytes, 0);
  });

  await check("assets and page scripts load without errors", async () => { assert.deepEqual(report.assetErrors, []); assert.deepEqual(report.pageErrors, []); });
  await check("pages attempt no external fonts, external resources or writes", async () => { assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.unintendedWrites, []); });
  await context.close();
} catch (error) {
  report.failures.push(`runner: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`);
} finally {
  await browser?.close();
  report.releaseReady = !baseline && report.failures.length === 0 && report.gaps.length === 0;
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, checks: report.checks.length, failures: report.failures, gaps: report.gaps, releaseReady: report.releaseReady, report: path.join(output, "result.json") }, null, 2));
  process.exitCode = report.failures.length ? 1 : !baseline && report.gaps.length ? 2 : 0;
}
