import "./public-nav.css";

export type PublicPage = "home" | "plan" | "world" | "capital-flows" | "onchain" | "atlas" | "wallet" | "connections";

const PAGES: { id: PublicPage; href: string; label: string }[] = [
  { id: "home", href: "/", label: "Overview" },
  { id: "plan", href: "/plan", label: "Money plan" },
  { id: "wallet", href: "/wallet", label: "Your workspace" },
  { id: "connections", href: "/connections", label: "Connections" },
  { id: "world", href: "/world", label: "Money insights" },
  { id: "atlas", href: "/atlas", label: "How it works" },
];

const INSIGHTS: { id: PublicPage; href: string; label: string }[] = [
  { id: "capital-flows", href: "/capital-flows", label: "Capital flows" },
  { id: "onchain", href: "/onchain", label: "Network insights" },
];

/** Plain links preserve the separate route bundles and native browser navigation. */
export function PublicNav({ current }: { current?: PublicPage }) {
  const insightPage = INSIGHTS.some((page) => page.id === current);
  return <nav className="public-nav" aria-label="CashLoom">
    <ul className="public-nav__main">{PAGES.map((page) => <li key={page.id}>
      <a href={page.href} aria-current={current === page.id ? "page" : undefined}>{page.label}</a>
    </li>)}
      <li className="public-nav__more">
        <details open={insightPage}>
          <summary className={insightPage ? "is-current" : undefined}>More insights <span aria-hidden="true">⌄</span></summary>
          <ul className="public-nav__insights">{INSIGHTS.map((page) => <li key={page.id}>
            <a href={page.href} aria-current={current === page.id ? "page" : undefined}>{page.label}</a>
          </li>)}</ul>
        </details>
      </li>
    </ul>
  </nav>;
}
