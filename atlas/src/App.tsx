import { lazy, Suspense, useEffect, type ReactNode } from "react";

const World = lazy(() => import("./world/World"));
const Onchain = lazy(() => import("./onchain/Onchain"));
const Atlas = lazy(() => import("./Atlas"));

function RouteBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={(
        <main className="route-loading" aria-label="Opening CashLoom">
          <a className="route-miss__brand" href="/">CashLoom</a>
          <p className="eyebrow">Opening the public read door</p>
          <p>Loading the interface. Saved public snapshots appear as soon as their route is ready.</p>
        </main>
      )}
    >
      {children}
    </Suspense>
  );
}

function NotFound() {
  useEffect(() => {
    document.title = "Not found — CashLoom";
  }, []);
  return (
    <main className="route-miss">
      <a className="route-miss__brand" href="/">CashLoom</a>
      <p className="eyebrow">An unthreaded path</p>
      <h1 className="display">Nothing is woven here.</h1>
      <p>The address does not point to CashLoom World, Onchain, or the Atlas.</p>
      <div><a className="btn btn--ember" href="/world">Enter World</a><a className="btn btn--ghost" href="/onchain">Open Onchain</a><a className="btn btn--ghost" href="/atlas">Read the Atlas</a></div>
    </main>
  );
}

export default function App() {
  const route = window.location.pathname.replace(/\/+$/, "") || "/";
  if (route === "/" || route === "/world") return <RouteBoundary><World /></RouteBoundary>;
  if (route === "/onchain" || route === "/blockchain") return <RouteBoundary><Onchain /></RouteBoundary>;
  if (route === "/atlas") return <RouteBoundary><Atlas /></RouteBoundary>;
  return <NotFound />;
}
