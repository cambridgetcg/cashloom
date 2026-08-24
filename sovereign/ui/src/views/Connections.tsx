import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { SectionTitle } from "../components";
import type {
  WalletIntegrationCatalog,
  WalletIntegrationCatalogItem,
} from "../types";

export interface IntegrationPresentation {
  readonly stateLabel: string;
  readonly stateClass: "is-ready" | "is-waiting" | "is-blocked";
  readonly actionLabel: string;
}

export function integrationPresentation(
  item: WalletIntegrationCatalogItem,
): IntegrationPresentation {
  if (item.execution_enabled) {
    return { stateLabel: "Enabled", stateClass: "is-ready", actionLabel: "Connected" };
  }
  if (item.configuration_state === "credentials_required") {
    return {
      stateLabel: "Configuration needed",
      stateClass: "is-waiting",
      actionLabel: "Add local provider credentials to continue",
    };
  }
  if (item.configuration_state === "ready") {
    return {
      stateLabel: "Read-only ready",
      stateClass: "is-ready",
      actionLabel: "Owner connection journey is not exposed yet",
    };
  }
  return {
    stateLabel: "Safety gate",
    stateClass: "is-blocked",
    actionLabel: "Held until the named policy/deployment prerequisite is pinned",
  };
}

const interactionLabel = (value: string): string => {
  if (value === "owner_device") return "Owner + physical device";
  if (value === "owner_redirect") return "Owner + regulated provider journey";
  return "Owner + browser ceremony";
};

function ConnectionCard({ item }: { readonly item: WalletIntegrationCatalogItem }) {
  const presentation = integrationPresentation(item);
  return (
    <article className="integration-card">
      <div className="integration-card-head">
        <div>
          <p className="integration-family">{item.family.replaceAll("-", " ")}</p>
          <h3>{item.label}</h3>
        </div>
        <span className={`integration-state ${presentation.stateClass}`}>
          {presentation.stateLabel}
        </span>
      </div>
      <dl className="integration-facts">
        <div><dt>Interaction</dt><dd>{interactionLabel(item.interaction)}</dd></div>
        <div><dt>Saved connections</dt><dd>{item.persisted_connections}</dd></div>
        <div><dt>Adapter</dt><dd>Verified foundation</dd></div>
      </dl>
      <div className="integration-columns">
        <div>
          <h4>What is built</h4>
          <ul>{item.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>
        </div>
        <div>
          <h4>Release boundary</h4>
          <ul>{item.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </div>
      </div>
      <p className="integration-action-note">{presentation.actionLabel}</p>
    </article>
  );
}

export function Connections() {
  const [catalog, setCatalog] = useState<WalletIntegrationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.walletIntegrations().then(
      (result) => {
        if (!live) return;
        setCatalog(result);
        setError(null);
      },
      (reason) => {
        if (!live) return;
        setError(errorMessage(reason));
      },
    );
    return () => { live = false; };
  }, []);

  return (
    <section className="connections-view" aria-labelledby="connections-title">
      <SectionTitle>Connections</SectionTitle>
      <div className="integration-intro">
        <div>
          <h2 id="connections-title">Wallet and bank integration architecture</h2>
          <p>
            Every external signer or provider stays behind an owner ceremony,
            an exact durable request, and local verification. Reading this page
            starts no device, relay, bank, bundler, or chain request.
          </p>
        </div>
        <span className="integration-local-chip">local · networkless read</span>
      </div>

      {error && <div className="notice notice-error">{error}</div>}
      {!catalog && !error && <div className="empty">Reading the local integration ledger…</div>}

      {catalog && (
        <>
          <div className="integration-safety" role="note">
            <strong>Safety invariant</strong>
            <span>Agents may propose and inspect, but cannot complete passkey, device, WalletConnect, or bank authorization ceremonies.</span>
          </div>
          <div className="integration-grid">
            {catalog.integrations.map((item) => <ConnectionCard key={item.id} item={item} />)}
          </div>
          <p className="integration-generated">
            Local projection generated {new Date(catalog.generated_at).toLocaleString()} ·
            pairing material, OAuth tokens, provider URLs and device identifiers are excluded.
          </p>
        </>
      )}
    </section>
  );
}
