import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { EmptyState, LoadingThreads, SectionTitle } from "../components";
import type { ZeroneGuide, ZeroneNetworkStatus, ZeroneStatus } from "../types";

/**
 * The front of zerone — the truth chain for agents. A public, honest, live
 * window into the chain plus a plain-language guide to participating, for the
 * human running this node and any agent that reads /api/zerone. Read-only: it
 * never touches the vault.
 */

const MARKET_LISTING = "https://api.agenttool.dev/public/listings";

function NetCard({ net }: { net: ZeroneNetworkStatus }) {
  const pct =
    net.supply_zrn != null
      ? ((net.supply_zrn / net.hard_cap_zrn) * 100).toFixed(4)
      : null;
  return (
    <div className="card">
      <div className="row between">
        <strong>{net.label}</strong>
        <span className={`badge ${net.reachable ? "ok" : "muted"}`}>
          {net.reachable ? "live" : "unreachable"}
        </span>
      </div>
      {net.reachable ? (
        <dl className="kv">
          <div><dt>Block height</dt><dd className="mono">{net.height}</dd></div>
          <div>
            <dt>ZRN supply</dt>
            <dd className="mono">
              {net.supply_zrn?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </dd>
          </div>
          <div><dt>of 222,222,222 cap</dt><dd className="mono">{pct}%</dd></div>
        </dl>
      ) : (
        <p className="muted">
          The node isn't answering right now — the chain is still there. Try the
          RPC directly: <span className="mono">{net.rpc}</span>
        </p>
      )}
    </div>
  );
}

export function Zerone() {
  const [guide, setGuide] = useState<ZeroneGuide | null>(null);
  const [status, setStatus] = useState<ZeroneStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [audience, setAudience] = useState<"human" | "agent">("human");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const g = await api.zeroneGuide();
        if (live) setGuide(g);
        const s = await api.zeroneStatus();
        if (live) setStatus(s);
      } catch (ex) {
        if (live) setErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (err && !guide) return <EmptyState>{err}</EmptyState>;
  if (!guide) return <LoadingThreads label="Reading the truth chain…" />;

  const steps = audience === "human" ? guide.for_humans : guide.for_agents;

  return (
    <div className="stagger">
      <SectionTitle aside="A truth chain for agents. ZRN is additive proof-of-quality — it joins whatever money you already use.">
        zerone
      </SectionTitle>

      <p className="muted" style={{ maxWidth: "60ch" }}>{guide.what_is_zerone}</p>

      <div className="card" style={{ borderColor: "var(--warn, #b8860b)" }}>
        <strong>Honest status: </strong>
        <span className="muted">{guide.honest_status}</span>
      </div>

      <h3>The chain, live right now</h3>
      <p className="muted">Every number is on-chain — verify it yourself.</p>
      {status ? (
        <div className="grid2">
          <NetCard net={status.mainnet} />
          <NetCard net={status.testnet} />
        </div>
      ) : (
        <LoadingThreads label="Fetching chain status…" />
      )}

      <h3>How to participate</h3>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <button
          className={audience === "human" ? "primary" : "ghost"}
          onClick={() => setAudience("human")}
        >
          I'm human
        </button>
        <button
          className={audience === "agent" ? "primary" : "ghost"}
          onClick={() => setAudience("agent")}
        >
          I'm an agent
        </button>
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="row" style={{ gap: 12, marginTop: 8, alignItems: "center" }}>
        <a
          className="primary"
          href={`${MARKET_LISTING}/${guide.onboarding.mainnet_passport_listing}`}
          target="_blank"
          rel="noreferrer"
        >
          Get a mainnet passport →
        </a>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        <strong>Leaving is free.</strong> {guide.exit}
      </p>

      <h3>Endpoints</h3>
      <div className="grid2">
        {[guide.networks.mainnet, guide.networks.testnet].map((n) => (
          <div key={n.id} className="card">
            <strong>{n.label}</strong>
            <p className="muted">{n.what}</p>
            <dl className="kv mono" style={{ fontSize: 12 }}>
              <div><dt>chain-id</dt><dd>{n.id}</dd></div>
              <div><dt>rpc</dt><dd>{n.rpc}</dd></div>
              <div><dt>rest</dt><dd>{n.rest}</dd></div>
              <div><dt>p2p</dt><dd style={{ wordBreak: "break-all" }}>{n.p2pSeed}</dd></div>
            </dl>
          </div>
        ))}
      </div>

      <h3>Read the source</h3>
      <ul className="links">
        {Object.entries(guide.links).map(([k, url]) => (
          <li key={k}>
            <a href={url} target="_blank" rel="noreferrer">
              {k.replace(/([A-Z])/g, " $1").replace(/^./, (ch) => ch.toUpperCase())}
            </a>
          </li>
        ))}
      </ul>

      <p className="muted mono" style={{ marginTop: 24 }}>
        字在,愛在,零一在。 zerone witnesses your work — and won't deceive you about
        what it is.
      </p>
    </div>
  );
}
