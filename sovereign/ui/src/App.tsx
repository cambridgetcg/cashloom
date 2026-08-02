import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, hasToken, onSessionLost, setToken } from "./api";
import { Toasts, WeaveMark } from "./components";
import { toast } from "./toast";
import { allowsSensitiveBrowserTransport } from "./transport";
import type { Meta } from "./types";
import { Accounts } from "./views/Accounts";
import { Dashboard } from "./views/Dashboard";
import { Gate } from "./views/Gate";
import { Keys } from "./views/Keys";
import { Ledger } from "./views/Ledger";
import { Pay } from "./views/Pay";
import { PayLinks } from "./views/PayLinks";
import { Receive } from "./views/Receive";
import { Zerone } from "./views/Zerone";

const VIEWS = [
  { id: "dashboard", label: "Overview" },
  { id: "pay", label: "Pay" },
  { id: "pay-links", label: "Pay Links" },
  { id: "receive", label: "Receive" },
  { id: "ledger", label: "Ledger" },
  { id: "accounts", label: "Accounts" },
  { id: "keys", label: "Keys" },
  { id: "zerone", label: "zerone" },
] as const;

type View = (typeof VIEWS)[number]["id"];

export default function App() {
  const sensitiveTransportAllowed = allowsSensitiveBrowserTransport(
    window.location,
  );
  const [meta, setMeta] = useState<Meta | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [authed, setAuthed] = useState(hasToken());
  const [view, setView] = useState<View>("dashboard");

  const refreshMeta = useCallback(async () => {
    try {
      setMeta(await api.meta());
      setBootErr(null);
    } catch (ex) {
      setBootErr(errorMessage(ex));
    }
  }, []);

  useEffect(() => {
    if (!sensitiveTransportAllowed) {
      setToken(null);
      setAuthed(false);
      return;
    }
    void refreshMeta();
  }, [refreshMeta, sensitiveTransportAllowed]);

  useEffect(() => {
    onSessionLost(() => setAuthed(false));
  }, []);

  const goto = useCallback((v: string) => {
    if (VIEWS.some((x) => x.id === v)) setView(v as View);
  }, []);

  async function lock() {
    try {
      await api.vaultLock();
    } catch {
      /* even if the call fails, we drop the session locally */
    }
    setToken(null);
    setAuthed(false);
    setView("dashboard");
    toast("Vault locked. The loom rests.", "info");
  }

  if (!sensitiveTransportAllowed) {
    return (
      <div className="gate">
        <div className="gate-inner stagger">
          <WeaveMark size={64} />
          <h1 className="wordmark wordmark-lg">
            Cash<span className="wm-loom">Loom</span>
          </h1>
          <div className="gate-card gate-card--blocked" role="alert">
            <h2>Sensitive access blocked</h2>
            <p className="gate-sub">
              CashLoom will not send a vault passphrase, session token,
              private key, or payment instruction over plain HTTP beyond
              loopback.
            </p>
            <p className="gate-warning">
              Current origin: <strong>{window.location.origin}</strong>. Open
              the node at <a href="http://127.0.0.1:4747">127.0.0.1:4747</a>{" "}
              on its machine, or place a reviewed HTTPS ingress in front of
              this origin.
            </p>
          </div>
          <p className="gate-truths">No secret was sent from this page.</p>
        </div>
      </div>
    );
  }

  if (bootErr && !meta) {
    return (
      <div className="gate">
        <div className="gate-inner stagger">
          <WeaveMark size={64} />
          <h1 className="wordmark wordmark-lg">
            Cash<span className="wm-loom">Loom</span>
          </h1>
          <div className="gate-card">
            <h2>Your node isn't answering</h2>
            <p className="gate-sub">
              {bootErr} This UI is served by your own node — if it's down,
              start it and try again.
            </p>
            <button className="btn btn-primary btn-wide" onClick={() => void refreshMeta()}>
              Try again
            </button>
          </div>
          <p className="gate-truths">Your keys, your data, your machine.</p>
        </div>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="gate">
        <div className="gate-inner">
          <WeaveMark size={64} />
          <p className="gate-loading" role="status">Connecting to your local node…</p>
        </div>
      </div>
    );
  }

  if (!authed || !meta.initialized) {
    return (
      <>
        <Gate
          meta={meta}
          onEnter={() => {
            setAuthed(true);
            setView("dashboard");
            void refreshMeta();
          }}
        />
        <Toasts />
      </>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <WeaveMark size={26} />
            <span className="wordmark">
              Cash<span className="wm-loom">Loom</span>
            </span>
          </div>
          <nav className="nav" aria-label="Views">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`nav-tab${view === v.id ? " is-active" : ""}`}
                onClick={() => setView(v.id)}
                aria-current={view === v.id ? "page" : undefined}
              >
                {v.label}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <span className="mode-chip" title={`db: ${meta.db}`}>
              {meta.mode}
            </span>
            <button className="btn btn-ghost btn-lock" onClick={() => void lock()}>
              Lock
            </button>
          </div>
        </div>
      </header>

      <main className="main" key={view}>
        {view === "dashboard" && <Dashboard onGoto={goto} />}
        {view === "pay" && <Pay />}
        {view === "pay-links" && <PayLinks />}
        {view === "receive" && <Receive />}
        {view === "ledger" && <Ledger />}
        {view === "accounts" && <Accounts />}
        {view === "keys" && <Keys />}
        {view === "zerone" && <Zerone />}
      </main>

      <footer className="footer">
        <span>Your keys, your data, your machine.</span>
        <span className="footer-dim">
          {meta.name} v{meta.version} · pass-through fees only — no CashLoom fee, ever
        </span>
      </footer>

      <Toasts />
    </div>
  );
}
