import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WalletGuide from "../src/wallet/WalletGuide";

describe("public workspace handoff", () => {
  it("explains local ownership with source guidance and no private inputs or automatic localhost connection", () => {
    const html = renderToStaticMarkup(<WalletGuide />);
    expect(html).toContain('href="/wallet" aria-current="page"');
    expect(html).toContain("Run your workspace locally");
    expect(html).toContain("no passphrase recovery service");
    expect(html).toContain("simulation holds no money");
    expect(html).toContain("sovereign#run-it");
    expect(html).toContain("release/service-workspace-20260929");
    expect(html).toContain("private repository access required");
    expect(html).toContain("Everyone can use the money plan in this browser");
    expect(html).toContain("GitHub may show “Page not found.”");
    expect(html).not.toMatch(/<(input|iframe|form)\b/);
    expect(html).not.toMatch(/href="https?:\/\/(localhost|127\.0\.0\.1)/);
  });

  it("offers a manual first routine and scopes household and team use honestly", () => {
    const html = renderToStaticMarkup(<WalletGuide />);
    for (const label of ["For yourself", "For your household", "For self-employed work", "For a small team"]) expect(html).toContain(label);
    expect(html).toContain("One local owner controls this workspace.");
    expect(html).toContain("Shared sign-in, separate member permissions and live collaboration are not available.");
    expect(html).toContain("recording an expense does not change the balance or move money");
    expect(html).toContain("There is no hosted workspace sign-in.");
    expect(html).toContain("Bank payments and external-wallet execution are still in development.");
    expect(html).toContain('href="/plan"');
    expect(html).toContain('href="/connections"');
  });

  it("keeps setup and capability handoff anchors available without changing the install commands", () => {
    const html = renderToStaticMarkup(<WalletGuide />);
    for (const anchor of ["first-steps", "setup", "connections", "payments", "statements"]) expect(html).toContain(`id="${anchor}"`);
    expect(html).toContain("bun install --frozen-lockfile");
    expect(html).toContain("(cd ui &amp;&amp; bun install --frozen-lockfile)");
    expect(html).toContain("bun run build:ui\nbun start");
  });

  it("explains the operational import, export and transfer boundaries before setup", () => {
    const html = renderToStaticMarkup(<WalletGuide />);
    expect(html).toContain('aria-label="Workspace guide sections"');
    expect(html).toContain("imports are limited to manual accounts");
    expect(html).toContain("not a complete workspace backup");
    expect(html).toContain("does not include signing keys");
    expect(html).toContain("equal amounts without fee or currency differences");
    expect(html).toContain("Importing records does not update a saved balance");
  });
});
