import { type ReactNode } from "react";
import type { PublicPage } from "../components/PublicNav";
import { PublicHeader } from "../components/PublicHeader";
import "./service.css";

export function ServiceLayout({ current, children }: { current: PublicPage; children: ReactNode }) {
  return <div className="service-shell">
    <a className="service-skip" href="#service-main">Skip to content</a>
    <PublicHeader current={current} />
    <main id="service-main" className="service-main">{children}</main>
    <footer className="service-footer">
      <div><a className="service-brand" href="/">CashLoom</a><p>Clarity to decide. Tools to act. Control that stays with you.</p></div>
      <nav aria-label="About CashLoom"><a href="/wallet">Workspace guide</a><a href="/connections">Connection guide</a><a href="/atlas">How it works</a><a href="/v1/data-practices">Data practices</a><a href="/RIGHTS.md">Your rights</a></nav>
    </footer>
  </div>;
}

export function Arrow() { return <span aria-hidden="true">↗</span>; }

export function Icon({ name }: { name: "plan" | "records" | "insights" | "connections" }) {
  return <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "plan" && <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-12 4h3m-3 3h6" /></>}
    {name === "records" && <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18m-6 4h6M6 6V4h11" /><circle cx="16" cy="15" r=".5" /></>}
    {name === "insights" && <><path d="M4 4v16h17M8 16v-4m5 4V8m5 8V5" /></>}
    {name === "connections" && <><path d="m9 15 6-6M8 17l-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0m2 6a4 4 0 0 0 5 0l4-4a4 4 0 0 0-5-5l-1 1" /></>}
  </svg>;
}
