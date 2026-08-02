import { useState } from "react";
import {
  CASHLOOM_CAPABILITIES,
  CASHLOOM_CAPABILITY_FINGERPRINT,
} from "../../../sovereign/src/info/capabilities.ts";
import { useReveal } from "../lib/hooks";

const source = CASHLOOM_CAPABILITIES.doors.find(({ id }) => id === "source")!;
const dashboard = CASHLOOM_CAPABILITIES.doors.find(
  ({ id }) => id === "dashboard",
)!;
const command = CASHLOOM_CAPABILITIES.participant_node.run.join("\n");
const capabilitiesUrl = `${CASHLOOM_CAPABILITIES.hosted_surface.canonical_api}/v1/capabilities`;

function CopyCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button className="start-copy" type="button" onClick={() => void copy()}>
      {copied ? "Copied" : "Copy commands"}
    </button>
  );
}

export default function StartHere() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section id="start" className="section start-section">
      <div className="section__head">
        <p className="eyebrow">02 · Choose your door</p>
        <h2 className="display">The website is the map. Your node is the place.</h2>
        <p className="lede">
          No CashLoom login, company account, hosted wallet, or domain is your
          authority. Learn here, run the open node, then operate it through a
          dashboard served by your own machine.
        </p>
      </div>

      <div ref={ref} className={`start-grid ${shown ? "is-in" : ""}`}>
        <article className="start-card start-card--map">
          <span className="start-card__number">01</span>
          <p className="start-card__kind">Hosted · no authority</p>
          <h3>Inspect the map</h3>
          <p>
            cashloom.io explains the code and its limits. It holds no keys,
            payment records, funds, or participant identity.
          </p>
          <a className="start-link" href="#truth">
            See exactly what works →
          </a>
        </article>

        <article className="start-card start-card--node">
          <span className="start-card__number">02</span>
          <p className="start-card__kind">Source · your authority</p>
          <h3>Run your node</h3>
          <p>
            The technical preview runs as one loopback process with a local
            encrypted vault, append-only signed v2 records, and separate
            mutable operational state in local SQLite.
          </p>
          <div className="start-terminal" aria-label="Commands to run CashLoom from source">
            <pre>{command}</pre>
            <CopyCommand />
          </div>
          <a
            className="start-link"
            href={source.href}
            target="_blank"
            rel="noreferrer"
          >
            Read or fork the source ↗
          </a>
        </article>

        <article className="start-card start-card--dashboard">
          <span className="start-card__number">03</span>
          <p className="start-card__kind">Loopback app · your machine</p>
          <h3>Open the dashboard</h3>
          <p>
            Once the node is running, its dashboard opens on 127.0.0.1. The
            public site never proxies or embeds it.
          </p>
          <a
            className="start-link"
            href={dashboard.href}
            target="_blank"
            rel="noreferrer"
          >
            Open my local dashboard ↗
          </a>
          <p className="start-card__aside">
            If nothing opens, start your node first. That failure is the
            boundary working—not an invitation to upload your wallet.
          </p>
        </article>
      </div>

      <div className="machine-door">
        <div>
          <p className="machine-door__label">Machine-readable truth</p>
          <p>
            The separately deployed info process serves this capability schema
            as cacheable JSON and has no payment routes. Check its reported
            fingerprint against this page when exact deployment parity matters.
          </p>
          <code className="machine-door__fingerprint">
            this page · {CASHLOOM_CAPABILITY_FINGERPRINT}
          </code>
        </div>
        <a href={capabilitiesUrl} target="_blank" rel="noreferrer">
          /v1/capabilities ↗
        </a>
      </div>
    </section>
  );
}
