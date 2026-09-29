import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletNavigation } from "../src/App";
import { OverviewContent, WorkspaceActions } from "../src/views/Dashboard";
import { WALLET_VIEWS } from "../src/navigation";

function clickButtons(node: ReactNode): void {
  if (Array.isArray(node)) { node.forEach(clickButtons); return; }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.type === "button") element.props.onClick?.();
  clickButtons(element.props.children);
}

test("grouped navigation keeps every private destination reachable using its original view ID", () => {
  const calls: unknown[][] = [];
  const tree = WalletNavigation({ view: "ledger", onGoto: (...args) => calls.push(args) });
  clickButtons(tree);
  expect(calls).toEqual(WALLET_VIEWS.map((view) => [view.id]));
  const html = renderToStaticMarkup(tree);
  expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  expect(html).toContain('aria-current="page">Activity</button>');
});

test("new-workspace actions guide setup and returning-workspace actions prepare payment without side effects", () => {
  for (const empty of [true, false]) {
    const calls: unknown[][] = [];
    clickButtons(WorkspaceActions({ empty, onGoto: (...args) => calls.push(args) }));
    expect(calls).toEqual([["accounts"], ["ledger"], [empty ? "connections" : "pay"]]);
  }
});

test("the unconfigured workspace does not offer an unpublished hosted planner", () => {
  const html = renderToStaticMarkup(<OverviewContent accounts={[]} summary={[]} positions={[]} onGoto={() => undefined} />);
  expect(html).toContain("The money planner is available in the separate CashLoom service preview.");
  expect(html).not.toContain('href="https://cashloom.io/plan"');
});
