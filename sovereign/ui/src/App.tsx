import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, hasToken, inspectVaultSession, onSessionLost, setToken } from "./api";
import { Toasts, WeaveMark } from "./components";
import { toast } from "./toast";
import type { Meta } from "./types";
import { Accounts } from "./views/Accounts";
import { Connections } from "./views/Connections";
import { Dashboard } from "./views/Dashboard";
import { Gate } from "./views/Gate";
import { Keys } from "./views/Keys";
import { Ledger } from "./views/Ledger";
import { Pay } from "./views/Pay";
import { Receive } from "./views/Receive";
import { Zerone } from "./views/Zerone";
import { Trades } from "./views/Trades";
import { PUBLIC_WORLD_URL, WALLET_NAV_GROUPS, WALLET_VIEWS, readWalletRoute, walletViewHash, type WalletNavigate, type WalletRoute, type WalletView } from "./navigation";
import { createSessionLifecycle, type SessionStatus } from "./session-lifecycle";

export function WalletNavigation({ view, onGoto }: { view: WalletView; onGoto: WalletNavigate }) {
  return <nav className="nav" aria-label="Views">
    {WALLET_NAV_GROUPS.map((group) => <div className="nav-group" key={group}>
      <p className="nav-group-label">{group}</p>
      <div className="nav-group-links">
        {WALLET_VIEWS.filter((item) => item.group === group).map((item) => <button
          key={item.id}
          className={`nav-tab${view === item.id ? " is-active" : ""}`}
          aria-current={view === item.id ? "page" : undefined}
          onClick={() => onGoto(item.id)}
        >{item.label}</button>)}
      </div>
    </div>)}
  </nav>;
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [authed, setAuthed] = useState(hasToken());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("checking");
  const [privateReady, setPrivateReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(document.visibilityState === "visible");
  const sessionLifecycle = useRef<ReturnType<typeof createSessionLifecycle> | null>(null);
  const [route, setRoute] = useState<WalletRoute>(readWalletRoute);
  const historyContext = useRef(new Map<string, WalletRoute>());
  const { view, context } = route;

  const refreshMeta = useCallback(async () => {
    try {
      setMeta(await api.meta());
      setBootErr(null);
    } catch (ex) {
      setBootErr(errorMessage(ex));
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  const forgetSession = useCallback(() => {
    sessionLifecycle.current?.dispose();
    sessionLifecycle.current = null;
    setToken(null);
    setAuthed(false);
    setPrivateReady(false);
    setSessionStatus("checking");
    historyContext.current.clear();
    window.history.replaceState(null, "", walletViewHash("dashboard"));
    setRoute({ view: "dashboard" });
  }, []);

  useEffect(() => {
    if (!authed) return;
    const lifecycle = createSessionLifecycle({
      inspect: inspectVaultSession,
      onStatus: (status) => {
        if (status === "invalid") { forgetSession(); return; }
        setSessionStatus(status);
        if (status === "valid") setPrivateReady(true);
      },
    });
    sessionLifecycle.current = lifecycle;
    const check = () => {
      setPageVisible(document.visibilityState === "visible");
      void lifecycle.check();
    };
    const followVisibility = () => {
      const visible = document.visibilityState === "visible";
      setPageVisible(visible);
      if (visible) check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", followVisibility);
    check();
    return () => {
      lifecycle.dispose();
      if (sessionLifecycle.current === lifecycle) sessionLifecycle.current = null;
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", followVisibility);
    };
  }, [authed, forgetSession]);

  useEffect(() => {
    onSessionLost(forgetSession);
    const followHistory = () => {
      const next = readWalletRoute();
      const saved = historyContext.current.get(window.history.state?.cashloomViewEntry);
      setRoute(saved?.view === next.view ? saved : next);
    };
    window.addEventListener("popstate", followHistory);
    window.addEventListener("hashchange", followHistory);
    return () => {
      window.removeEventListener("popstate", followHistory);
      window.removeEventListener("hashchange", followHistory);
      onSessionLost(() => undefined);
    };
  }, [forgetSession]);

  const goto = useCallback<WalletNavigate>((next, nextContext) => {
    const hash = walletViewHash(next);
    const nextRoute = { view: next, context: nextContext };
    const entry = crypto.randomUUID();
    historyContext.current.set(entry, nextRoute);
    if (historyContext.current.size > 50) historyContext.current.delete(historyContext.current.keys().next().value!);
    // Only an opaque local entry marker enters browser history; private IDs
    // remain in this bounded in-memory map, erased on lock/session loss.
    const marker = { cashloomViewEntry: entry };
    if (window.location.hash !== hash) window.history.pushState(marker, "", hash);
    else window.history.replaceState(marker, "", hash);
    setRoute(nextRoute);
  }, []);

  async function lock() {
    // Start with the current credential, then immediately unmount private views.
    // A slow node must not keep trade evidence or drafts visible while locking.
    const locking = api.vaultLock();
    forgetSession();
    try {
      await locking;
      toast("Vault locked. Your private workspace is closed.", "info");
    } catch {
      toast("Session cleared in this tab. Your node did not confirm a vault lock.", "info");
    }
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
            setSessionStatus("checking");
            setPrivateReady(false);
            setPageVisible(document.visibilityState === "visible");
            setAuthed(true);
            setRoute(readWalletRoute());
            void refreshMeta();
          }}
        />
        <Toasts />
      </>
    );
  }

  const privateVisible = sessionStatus === "valid" && pageVisible;
  return (
    <>
      {!privateVisible && (
        <div className="gate">
          <div className="gate-inner">
            <WeaveMark size={64} />
            <div className="gate-card" role="status" aria-live="polite">
              <h1>{sessionStatus === "unknown" ? "Session status is unknown" : "Checking your session"}</h1>
              <p className="gate-sub">
                {sessionStatus === "unknown"
                  ? "Your node hasn't confirmed this session. Private views are hidden; this tab keeps your draft while you retry. This does not confirm the vault is locked."
                  : "Private views stay hidden until your node confirms access."}
              </p>
              {sessionStatus === "unknown" && (
                <button className="btn btn-primary btn-wide" onClick={() => void sessionLifecycle.current?.check()}>
                  Check session again
                </button>
              )}
              <button className="btn btn-ghost btn-wide" onClick={forgetSession}>Forget this tab's session</button>
            </div>
          </div>
        </div>
      )}
      {/* Keep drafts during a bounded check or an unknown response. Only a
          confirmed invalid session, expiry, or explicit lock unmounts them. */}
      {privateReady && <div hidden={!privateVisible} inert={!privateVisible}>
    <div className="shell">
      <a className="skip-link" href="#workspace-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById("workspace-content")?.focus();
      }}>Skip to workspace</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <WeaveMark size={32} />
            <span className="wordmark">
              Cash<span className="wm-loom">Loom</span>
            </span>
            <span className="workspace-label">Your money workspace</span>
          </div>
          <div className="topbar-right">
            <a className="link-btn" href={PUBLIC_WORLD_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Cashloom guide ↗</a>
            <span className="mode-chip" title={`Local node mode: ${meta.mode}`}>
              Private · local
            </span>
            <button className="btn btn-ghost btn-lock" onClick={() => void lock()}>
              Lock
            </button>
          </div>
        </div>
      </header>

      <div className="workspace-layout">
      <aside className="workspace-sidebar"><WalletNavigation view={view} onGoto={goto} /></aside>
      <main id="workspace-content" tabIndex={-1} className="main" key={`${view}:${context?.accountId ?? ""}:${context?.keyId ?? ""}`}>
        {view === "dashboard" && <Dashboard onGoto={goto} />}
        {view === "pay" && <Pay initialAccountId={context?.accountId} onGoto={goto} />}
        {view === "receive" && <Receive initialAccountId={context?.accountId} initialKeyId={context?.keyId} onGoto={goto} />}
        {view === "trades" && <Trades onGoto={goto} />}
        {view === "ledger" && <Ledger initialAccountId={context?.accountId} onGoto={goto} />}
        {view === "accounts" && <Accounts initialAccountId={context?.accountId} initialKeyId={context?.keyId} onGoto={goto} />}
        {view === "connections" && <Connections onGoto={goto} />}
        {view === "keys" && <Keys onGoto={goto} />}
        {view === "zerone" && <Zerone />}
      </main>
      </div>

      <footer className="footer">
        <span>Your records and keys stay with your local node.</span>
        <span className="footer-dim">
          {meta.name} v{meta.version} · Review costs before sending money
        </span>
      </footer>

      <Toasts />
    </div>
      </div>}
    </>
  );
}
