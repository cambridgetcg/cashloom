import { Component, type ReactNode } from "react";
import { PublicHeader } from "./PublicHeader";

export function PageLoadFailure() {
  return <><PublicHeader /><main className="route-miss" role="alert">
    <p className="eyebrow">Page unavailable</p>
    <h1 className="display">Let’s get you back on track.</h1>
    <p>This page could not open. Check your connection, then reload to try again.</p>
    <p>If you were editing an unsaved plan, reloading can lose those changes.</p>
    <div><button className="btn btn--ember" type="button" onClick={() => window.location.reload()}>Reload page</button><a className="btn btn--ghost" href="/">Back to overview</a></div>
  </main></>;
}

export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PageLoadFailure /> : this.props.children; }
}
