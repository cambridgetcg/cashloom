import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { PublicHeader } from "./components/PublicHeader";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { updatePageMetadata } from "./page-metadata";

const World = lazy(() => import("./world/World"));
const Onchain = lazy(() => import("./onchain/Onchain"));
const CapitalFlows = lazy(() => import("./capital-flows/CapitalFlows"));
const Atlas = lazy(() => import("./Atlas"));
const WalletGuide = lazy(() => import("./wallet/WalletGuide"));
const Home = lazy(() => import("./service/Home"));
const MoneyPlan = lazy(() => import("./plan/MoneyPlan"));
const Connections = lazy(() => import("./service/Connections"));

function RouteBoundary({ children }: { children: ReactNode }) {
  return (
    <PageErrorBoundary><Suspense
      fallback={(
        <main className="route-loading" aria-label="Opening CashLoom">
          <a className="cashloom-brand route-miss__brand" href="/"><span className="cashloom-brand-mark" aria-hidden="true">c</span>CashLoom</a>
          <p className="eyebrow">Opening CashLoom</p>
          <p>Loading your next step.</p>
        </main>
      )}
    >
      {children}
    </Suspense></PageErrorBoundary>
  );
}

function NotFound() {
  return (
    <><PublicHeader /><main className="route-miss">
      <p className="eyebrow">Page not found</p>
      <h1 className="display">Find your next step.</h1>
      <p>This address does not match a CashLoom page. Start with a money plan, your workspace, or money insights.</p>
      <div><a className="btn btn--ember" href="/">Back to overview</a><a className="btn btn--ghost" href="/plan">Money plan</a><a className="btn btn--ghost" href="/wallet">Your workspace</a><a className="btn btn--ghost" href="/world">Money insights</a></div>
    </main></>
  );
}

export default function App() {
  const route = window.location.pathname.replace(/\/+$/, "") || "/";
  useEffect(() => { updatePageMetadata(route, document); }, [route]);
  if (route === "/") return <RouteBoundary><Home /></RouteBoundary>;
  if (route === "/plan") return <RouteBoundary><MoneyPlan /></RouteBoundary>;
  if (route === "/connections") return <RouteBoundary><Connections /></RouteBoundary>;
  if (route === "/world") return <RouteBoundary><World /></RouteBoundary>;
  if (route === "/onchain" || route === "/blockchain") return <RouteBoundary><Onchain /></RouteBoundary>;
  if (route === "/capital-flows") return <RouteBoundary><CapitalFlows /></RouteBoundary>;
  if (route === "/atlas") return <RouteBoundary><Atlas /></RouteBoundary>;
  if (route === "/wallet") return <RouteBoundary><WalletGuide /></RouteBoundary>;
  return <NotFound />;
}
