/** Browser checks against a separately started local preview. No providers or wallet node. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const origin = process.env.CASHLOOM_BROWSER_ORIGIN ?? "http://127.0.0.1:5179";
assert.equal(new URL(origin).hostname, "127.0.0.1", "Use a loopback-only test preview");
assert.ok(process.env.CASHLOOM_PLAYWRIGHT_PATH, "Set CASHLOOM_PLAYWRIGHT_PATH to the installed playwright-core entrypoint");
assert.ok(process.env.CASHLOOM_BROWSER_EXECUTABLE, "Set CASHLOOM_BROWSER_EXECUTABLE to its matched Chromium executable");
const output = process.env.CASHLOOM_BROWSER_OUTPUT ?? "/tmp/cashloom-service-review";
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.CASHLOOM_PLAYWRIGHT_PATH).href);
const browser = await chromium.launch({ executablePath: process.env.CASHLOOM_BROWSER_EXECUTABLE, headless: true });
let checkpoints = 0;
const checkpoint = (message) => { checkpoints++; console.log(`PASS ${message}`); };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, colorScheme: "dark" });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(15_000);
  const external = [];
  const errors = [];
  const resourceErrors = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.origin); await route.abort(); return; }
    if (url.pathname.startsWith("/v1/")) { await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline test"}' }); return; }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && !url.pathname.startsWith("/v1/")) resourceErrors.push(`${response.status()} ${url.pathname}`);
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(origin);
  await page.getByRole("heading", { level: 1, name: /Your money\.\s*Your direction\./ }).waitFor();
  await page.screenshot({ path: path.join(output, "overview-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "My household", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "My household", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("link", { name: "Plan household money" }).click();
  await page.getByRole("radio", { name: "Our household", exact: true }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "Our household", exact: true }).isChecked(), true);
  checkpoint("audience choice carries into the planner without private URL data");
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);

  const entries = [
    ["Add income", "Salary", "3000.10"],
    ["Add a commitment", "Rent", "1000.20"],
    ["Add spending", "Food", "400.30"],
    ["Add a set-aside", "Rainy day", "200.40"],
  ];
  for (const [add, name, amount] of entries) {
    await page.getByRole("button", { name: add, exact: true }).click();
    const focused = page.locator("input:focus");
    await focused.fill(name);
    await page.getByRole("textbox", { name: `Per month for ${name}`, exact: true }).fill(amount);
  }
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "£1,399.20");
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
  assert.deepEqual(external, [], "service/planner must not request external fonts or send entries");
  checkpoint("exact monthly arithmetic and editing without automatic persistence or external requests");

  await page.getByRole("textbox", { name: "Per month for Rent", exact: true }).fill("4000");
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "£1,600.60");
  assert.equal(await page.locator(".plan-remainder").innerText().then((text) => text.includes("Monthly shortfall")), true);
  await page.getByRole("textbox", { name: "Per month for Rent", exact: true }).fill("1,000");
  assert.equal(await page.getByRole("textbox", { name: "Per month for Rent", exact: true }).getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "—");
  await page.getByRole("textbox", { name: "Per month for Rent", exact: true }).fill("1000.20");
  checkpoint("shortfall and invalid input remain distinct from spendable money");

  await page.getByRole("checkbox", { name: "Save this plan in this browser" }).check();
  await page.getByText("Saved in this browser.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("textbox", { name: "Per month for Salary", exact: true }).waitFor();
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "£1,399.20");
  assert.equal(await page.getByRole("checkbox", { name: "Save this plan in this browser" }).isChecked(), true);
  checkpoint("opt-in saved plan survives reload");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export plan", exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.items.length, 4);
  assert.equal(exported.items[0].amount, "3000.10");
  await page.getByRole("button", { name: "Clear plan", exact: true }).click();
  await page.getByRole("button", { name: "Keep my plan", exact: true }).click();
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "£1,399.20");
  await page.getByRole("button", { name: "Clear plan", exact: true }).click();
  await page.getByRole("button", { name: "Yes, clear plan", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
  assert.equal(await page.locator(".plan-entry").count(), 0);
  checkpoint("export preserves decimal values and clear requires confirmation");

  const fileInput = page.getByLabel("Choose a CashLoom plan file", { exact: true });
  await fileInput.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"version":1}') });
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator(".plan-entry").count(), 0);
  await fileInput.setInputFiles({ name: "plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await page.getByRole("button", { name: "Replace with imported plan", exact: true }).waitFor();
  assert.equal(await page.locator(".plan-entry").count(), 0);
  await page.getByRole("button", { name: "Replace with imported plan", exact: true }).click();
  assert.equal(await page.locator(".plan-remainder strong").innerText(), "£1,399.20");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, "money-plan-desktop.png"), fullPage: true });
  checkpoint("malformed imports preserve the draft; valid import waits for replacement review");

  const exportAgain = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export plan", exact: true }).click();
  await exportAgain;
  assert.equal(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), true);
  checkpoint("preparing an export does not assume the file was saved or suppress draft protection");

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `populated planner overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  checkpoint("populated plan stays within narrow mobile layouts");

  await page.getByRole("checkbox", { name: "Save this plan in this browser" }).check();
  await page.getByText("Saved in this browser.", { exact: true }).waitFor();
  const other = await context.newPage();
  await other.goto(`${origin}/plan`);
  await other.getByRole("textbox", { name: "Per month for Salary", exact: true }).fill("3100.10");
  await page.getByRole("heading", { name: "Choose which plan to keep", exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "Save this plan in this browser" }).isChecked(), false);
  assert.equal(await page.getByRole("textbox", { name: "Per month for Salary", exact: true }).inputValue(), "3000.10");
  await page.getByRole("textbox", { name: "Per month for Salary", exact: true }).fill("3200.10");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("cashloom.money-plan.v1")).items[0].amount), "3100.10");
  await page.getByRole("button", { name: "Load latest saved plan", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Per month for Salary", exact: true }).inputValue(), "3100.10");
  await other.getByRole("checkbox", { name: "Save this plan in this browser" }).uncheck();
  await page.getByRole("heading", { name: "Choose which plan to keep", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Per month for Salary", exact: true }).fill("3000.10");
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
  await other.close();
  await page.getByRole("button", { name: "Review saving this draft", exact: true }).click();
  // This click is a review; it must not write until the person confirms.
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
  await page.getByRole("button", { name: "Save this draft and resume", exact: true }).click();
  await page.getByText("Saved in this browser.", { exact: true }).waitFor();
  checkpoint("other-tab edits and removals pause saving, preserve both drafts and require reviewed resumption");

  await page.getByRole("checkbox", { name: "Save this plan in this browser" }).uncheck();
  assert.equal(await page.evaluate(() => localStorage.getItem("cashloom.money-plan.v1")), null);
  assert.equal(await page.locator(".plan-entry").count(), 4);
  checkpoint("turning off saving removes only the browser copy and keeps the open draft");
  await page.getByRole("button", { name: "Clear plan", exact: true }).click();
  await page.getByRole("button", { name: "Yes, clear plan", exact: true }).click();

  await page.goto(`${origin}/connections`);
  await page.getByRole("button", { name: "Send money", exact: true }).click();
  assert.equal(await page.locator(".service-connection").count(), 5);
  assert.equal(await page.locator(".service-connection").filter({ hasText: "Not enabled" }).count(), 3);
  assert.equal(await page.locator(".service-connection").filter({ hasText: "PayPal & Cash App" }).filter({ hasText: "Planned · not enabled" }).count(), 1);
  await page.getByRole("link", { name: "Understand local payments" }).first().click();
  await page.locator("#payments").waitFor();
  assert.equal(new URL(page.url()).hash, "#payments");
  checkpoint("connection filters and handoff anchors lead to honest local setup guidance");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/plan", "/connections", "/wallet", "/world", "/capital-flows", "/onchain", "/atlas"]) {
      await page.goto(origin + route);
      await page.locator(".public-nav").waitFor();
      await page.locator("h1").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const metadata = await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content,
        socialTitle: document.querySelector('meta[property="og:title"]')?.content,
        socialDescription: document.querySelector('meta[property="og:description"]')?.content,
        canonical: document.querySelector('link[rel="canonical"]')?.href,
        robots: document.querySelector('meta[name="robots"]')?.content,
      }));
      assert.equal(metadata.canonical, `https://cashloom.io${route}`);
      assert.equal(metadata.socialTitle, metadata.title);
      assert.equal(metadata.socialDescription, metadata.description);
      assert.equal(metadata.robots, "index,follow");
      if (route === "/plan") assert.ok(metadata.description.includes("monthly money plan"));
      if (route === "/wallet") assert.ok(metadata.description.includes("requires repository access"));
      const theme = await page.evaluate(() => ({
        scheme: getComputedStyle(document.documentElement).colorScheme,
        headerFont: getComputedStyle(document.querySelector(".cashloom-header")).fontFamily,
        headingFont: getComputedStyle(document.querySelector("h1")).fontFamily,
        headerColor: getComputedStyle(document.querySelector(".cashloom-header")).color,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
      }));
      assert.equal(theme.scheme, "light", `${route} retains the chosen service theme under OS dark preference`);
      assert.ok(theme.headerFont.includes("Spline Sans"), `${route} shared header typeface`);
      assert.ok(theme.headingFont.includes("Fraunces"), `${route} shared heading typeface`);
      assert.equal(theme.headerColor, "rgb(24, 58, 48)", `${route} shared brand text`);
      assert.equal(theme.bodyBackground, "rgb(247, 248, 242)", `${route} shared page surface`);
      assert.equal(await page.locator('.public-nav a[aria-current="page"]').count(), 1, `${route} current link`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} overflow at ${width}`);
      for (const link of await page.locator('.public-nav a:visible, .public-nav summary:visible').all()) {
        assert.ok((await link.boundingBox()).height >= 40, `${route} tap target at ${width}`);
      }
      if (width === 390 || width === 1440) await page.screenshot({ path: path.join(output, `${route === "/" ? "overview" : route.slice(1)}-${width === 390 ? "mobile" : "desktop"}.png`), fullPage: false });
    }
    checkpoint(`all eight routes, active navigation and narrow layouts at ${width}px`);
  }
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/atlas`);
    await page.locator(".module-index .mi").first().click();
    await page.getByRole("dialog").waitFor();
    await page.locator(".cl__code span").first().waitFor();
    assert.equal(await page.locator(".overlay__panel").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 254, 249)");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `source viewer document overflow at ${width}`);
    assert.ok(await page.locator(".overlay__panel").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `source viewer prose must fit the dialog at ${width}`);
    await page.screenshot({ path: path.join(output, `architecture-source-${width}.png`) });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
  }
  checkpoint("architecture diagrams and highlighted source viewer use the service theme at desktop/mobile widths");
  await page.goto(`${origin}/not-a-page`);
  await page.getByRole("link", { name: "Back to overview" }).waitFor();
  assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex,follow");
  assert.equal(await page.locator('link[rel="canonical"]').count(), 0);
  await page.goto(`${origin}/blockchain/`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.equal(await page.locator('.public-nav a[aria-current="page"]').getAttribute("href"), "/onchain");
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://cashloom.io/onchain");
  checkpoint("page metadata, not-found indexing, legacy canonical alias and trailing-slash routes");
  assert.deepEqual(errors, [], "No uncaught client errors");
  assert.deepEqual(resourceErrors, [], "Page assets load successfully");

  // Deliberately fail a route chunk in an isolated context, then make it available again.
  const recoveryContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  let rejectChunk = true, rejectedChunks = 0, capitalReads = 0;
  await recoveryContext.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (rejectChunk && /\/assets\/WalletGuide-[^/]+\.js$/.test(url.pathname)) { rejectedChunks++; await route.abort(); return; }
    if (url.pathname === "/v1/capital-flows") { capitalReads++; await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not enabled"}' }); return; }
    if (url.pathname.startsWith("/v1/")) { await route.fulfill({ status: 503, contentType: "application/json", body: '{}' }); return; }
    await route.continue();
  });
  const recoveryPage = await recoveryContext.newPage();
  await recoveryPage.goto(`${origin}/wallet`);
  await recoveryPage.getByRole("heading", { name: "Let’s get you back on track." }).waitFor();
  assert.ok(rejectedChunks > 0, "test must fail the real lazy route download");
  assert.ok(await recoveryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await recoveryPage.screenshot({ path: path.join(output, "page-download-recovery-mobile.png") });
  rejectChunk = false;
  await recoveryPage.getByRole("button", { name: "Reload page", exact: true }).click();
  await recoveryPage.getByRole("navigation", { name: "Workspace guide sections" }).waitFor();
  await recoveryPage.getByRole("link", { name: "Import & export", exact: true }).click();
  await recoveryPage.getByRole("heading", { name: "Bring in activity. Keep a copy." }).waitFor();
  assert.equal(new URL(recoveryPage.url()).hash, "#statements");
  await recoveryPage.screenshot({ path: path.join(output, "workspace-import-guidance-mobile.png") });
  checkpoint("failed page download has a readable recovery screen and reload restores the workspace guide");
  await recoveryPage.goto(`${origin}/capital-flows`);
  await recoveryPage.getByRole("alert").filter({ hasText: "not enabled on this server" }).waitFor();
  assert.equal(await recoveryPage.getByRole("button", { name: "Refresh reports" }).count(), 0);
  assert.equal(await recoveryPage.getByRole("link", { name: "Explore available money insights →", exact: true }).getAttribute("href"), "/world");
  assert.equal(capitalReads, 1);
  await recoveryPage.screenshot({ path: path.join(output, "capital-feed-not-enabled-mobile.png") });
  checkpoint("missing capital feed stops checking and offers a useful money-insights path");
  await recoveryContext.close();
  await writeFile(path.join(output, "result.json"), JSON.stringify({ checkpoints, externalRequestsBlocked: [...new Set(external)], clientErrors: errors, note: "Synthetic browser inputs; insight requests intentionally return 503; no provider or payment execution." }, null, 2));
  console.log(`Completed ${checkpoints} checkpoints. Screenshots: ${output}`);
} finally { await browser.close(); }
