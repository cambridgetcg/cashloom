import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, currentSessionGuard, errorMessage } from "../api";
import { Badge, SectionTitle } from "../components";
import { AccountBalances } from "../components/AccountBalances";
import { isObservableBaseAccount } from "../components/BasePositionPanel";
import { formatDateTime } from "../format";
import { loadPlaidLink, type PlaidLinkHandler } from "../integrations/plaid-link";
import type { WalletNavigate } from "../navigation";
import type {
  WalletIntegrationCatalog,
  WalletIntegrationCatalogItem,
  Account, ConnectionsResponse, PlaidItem, ReadConnectionView,
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
  if (value === "owner_device") return "You approve on your device";
  if (value === "owner_redirect") return "You approve with the provider";
  return "You approve in your browser";
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
        <div><dt>Authorization</dt><dd>{interactionLabel(item.interaction)}</dd></div>
        <div><dt>Saved connections</dt><dd>{item.persisted_connections}</dd></div>
      </dl>
      <p className="integration-action-note">{presentation.actionLabel}</p>
      <details className="integration-details"><summary>Capabilities and limits</summary>
      <div className="integration-columns">
        <div>
          <h4>What is built</h4>
          <ul>{item.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>
        </div>
        <div>
          <h4>Current limits</h4>
          <ul>{item.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </div>
      </div>
      </details>
    </article>
  );
}

export function MoneySource({ source, onGoto, management }: { source: ReadConnectionView; onGoto?: WalletNavigate; management?: ReactNode }) {
  return <article className="card money-source">
    <div className="money-source-head"><div><p className="integration-family">{source.provider}</p><h3>{source.display_name}</h3></div>
      <div className="source-badges"><Badge>{source.environment === "sandbox" ? "Sandbox • test accounts" : source.environment}</Badge><Badge tone={source.status === "active" ? "gold" : "dim"}>{source.status.replaceAll("_", " ")}</Badge></div>
    </div>
    <p className="journey-note">{source.status === "active" ? "Can read" : "Saved data"}: {Object.entries(source.capabilities).filter(([key, enabled]) => enabled && key !== "payments").map(([key]) => key).join(", ") || "no enabled capabilities"}. {source.status === "disconnected" ? "This connection is disconnected; these are the last saved observations." : "Payments are not enabled by this connection."}</p>
    <p className="source-check">Last successful check: {source.last_success_at ? formatDateTime(source.last_success_at) : "Not checked"}{source.last_attempt_at && source.last_attempt_at !== source.last_success_at ? ` · Last attempt: ${formatDateTime(source.last_attempt_at)}` : ""}</p>
    {source.last_error_code && <p className="form-error">Check needs attention: {source.last_error_code.replaceAll("_", " ")}</p>}
    {management}
    {source.accounts.map((account) => <div className="source-account" key={account.id}>
      <h4>{account.display_name}{account.account_mask ? ` · ending ${account.account_mask}` : ""}</h4>
      {account.status.toUpperCase() !== "ACTIVE" && <Badge tone="dim">{account.status.toLowerCase()}</Badge>}
      <AccountBalances account={account} />
      {onGoto && <button className="link-btn" onClick={() => onGoto("ledger", { accountId: account.id })}>View activity</button>}
    </div>)}
    {source.accounts.length === 0 && <p className="journey-note">No accounts have been read from this source yet.</p>}
  </article>;
}

export function SavedMoneySource({ account, onGoto }: { account: Account; onGoto?: WalletNavigate }) {
  const kind = account.rail === "CRYPTO" ? "Crypto" : account.connector_type ? "Processor / connector" : "Manual record";
  return <article className="card money-source">
    <div className="money-source-head"><div><p className="integration-family">{kind}</p><h3>{account.display_name}</h3></div><Badge tone="dim">{account.connector_type || "Updated by you"}</Badge></div>
    <p className="journey-note">{account.rail === "CRYPTO" ? "Use Accounts to check supported chain balances and review available wallet actions. A saved wallet record alone does not authorize payments." : account.connector_type ? "Use Accounts to check this configured connector. Saved settings alone do not confirm provider access." : "Record balances and activity yourself or import a statement. No provider is connected."}</p>
    {isObservableBaseAccount(account) ? <p className="journey-note">Review finalized Base balances and their evidence in Accounts.</p> : <AccountBalances account={account} />}
    {onGoto && <div className="btn-row"><button className="btn btn-ghost" onClick={() => onGoto("accounts", { accountId: account.id })}>Manage account</button><button className="link-btn" onClick={() => onGoto("ledger", { accountId: account.id })}>Activity / import</button></div>}
  </article>;
}

export function PlaidItemCard({ item, busy, canManage, onSync, onDisconnect, embedded = false }: { item: PlaidItem; busy: boolean; canManage: boolean; onSync(): void; onDisconnect(): void; embedded?: boolean }) {
  const [review, setReview] = useState(false);
  const disconnected = item.state === "disconnected";
  const Container = embedded ? "div" : "article";
  return <Container className={embedded ? "bank-item bank-controls" : "card bank-item"}>
    {!embedded && <><div className="money-source-head"><h3>{item.label}</h3><Badge tone="dim">{item.state.replaceAll("_", " ")}</Badge></div>
    <p>{item.account_count} test account{item.account_count === 1 ? "" : "s"} · Last sync: {item.last_synced_at ? formatDateTime(item.last_synced_at) : "Not synced"}</p></>}
    {item.state === "reconnect_required" && <p className="notice">This test connection needs authorization again. Disconnect it, then choose Connect a test bank to link again.</p>}
    {item.state === "disconnect_pending" && <p className="notice">Local syncing is disabled. Provider removal still needs to complete; retry disconnect to finish.</p>}
    {disconnected && <p className="journey-note">Disconnected. Saved history remains available.</p>}
    {canManage && !disconnected && <div className="btn-row">
      <button className="btn btn-ghost" disabled={busy || !["connected", "setup_pending"].includes(item.state)} onClick={onSync}>{busy ? "Working…" : "Sync test accounts"}</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setReview(true)}>Review disconnect</button>
    </div>}
    {review && <div className="connection-review" role="region" aria-label={`Disconnect ${item.label}`}>
      <h4>Disconnect this test bank?</h4><p>This stops new syncing and requests provider access removal. Your imported activity stays in CashLoom. It does not close a bank account.</p>
      <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={() => { setReview(false); onDisconnect(); }}>Confirm disconnect</button><button className="btn btn-ghost" disabled={busy} onClick={() => setReview(false)}>Keep connected</button></div>
    </div>}
  </Container>;
}

export function Connections({ onGoto }: { onGoto?: WalletNavigate } = {}) {
  const [catalog, setCatalog] = useState<WalletIntegrationCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const live = useRef(true);
  const handler = useRef<PlaidLinkHandler | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const read = ++generation.current;
    setReading(true);
    try {
      const [connections, saved] = await Promise.all([api.connections(), api.accounts()]);
      if (!live.current || read !== generation.current) return;
      setData(connections); setAccounts(saved.accounts); setError(null);
    } catch (reason) {
      if (live.current && read === generation.current) setError(errorMessage(reason));
    } finally {
      if (live.current && read === generation.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    void api.walletIntegrations().then(
      (result) => {
        if (!live.current) return;
        setCatalog(result);
      },
      (reason) => {
        if (!live.current) return;
        setCatalogError(errorMessage(reason));
      },
    );
    return () => { live.current = false; generation.current++; handler.current?.destroy(); handler.current = null; };
  }, [load]);

  async function connectBank() {
    if (pending.current || !data?.can_manage || !data.plaid.configured) return;
    pending.current = true; setBusy("link"); setError(null); setNotice(null);
    const sessionCurrent = currentSessionGuard();
    const current = () => live.current && sessionCurrent();
    const finish = () => { handler.current?.destroy(); handler.current = null; pending.current = false; if (current()) setBusy(null); };
    try {
      const start = await api.plaidLink();
      if (!current()) return finish();
      if (start.environment !== "sandbox") throw new Error("Only sandbox bank connections are supported here.");
      const sdk = await loadPlaidLink();
      if (!current()) return finish();
      handler.current = sdk.create({ token: start.link_token,
        onSuccess: (publicToken) => {
          if (!current()) return finish();
          if (!publicToken) { setError("The test bank returned no connection token. Start again."); return finish(); }
          void api.plaidExchange(start.attempt_id, publicToken).then(async () => {
            if (!current()) return;
            setNotice("Test bank linked. Sync its accounts to read test balances and activity.");
            await load();
          }, (reason) => { if (current()) setError(errorMessage(reason)); }).finally(finish);
        },
        onExit: (reason) => { if (current()) setNotice(reason ? "The bank connection did not complete. Start again when ready." : "Bank linking closed. No new connection was confirmed."); finish(); },
      });
      handler.current.open();
    } catch (reason) { if (current()) setError(errorMessage(reason)); finish(); }
  }

  async function manageItem(item: PlaidItem, action: "sync" | "disconnect") {
    if (pending.current || !data?.can_manage) return;
    pending.current = true; setBusy(item.id); setError(null); setNotice(null);
    const sessionCurrent = currentSessionGuard();
    try {
      if (action === "sync") {
        await api.plaidSync(item.id);
        if (live.current && sessionCurrent()) setNotice("Test account sync finished. Review the latest balances and activity below.");
      } else {
        const result = await api.plaidDisconnect(item.id);
        if (live.current && sessionCurrent()) setNotice(result.provider_revoked ? "Test bank disconnected. Saved history is retained." : "Local syncing stopped. Provider access removal is pending; retry disconnect to finish.");
      }
      if (live.current && sessionCurrent()) await load();
    } catch (reason) { if (live.current && sessionCurrent()) setError(errorMessage(reason)); }
    finally { pending.current = false; if (live.current && sessionCurrent()) setBusy(null); }
  }

  const represented = new Set(data?.sources.flatMap((source) => source.accounts.map((account) => account.id)) ?? []);
  const standalone = accounts.filter((account) => !represented.has(account.id) && account.status.toUpperCase() === "ACTIVE");
  const orphanItems = data?.plaid.items.filter((item) => !data.sources.some((source) => source.id === item.id)) ?? [];
  const itemControls = (item: PlaidItem, embedded = false) => <PlaidItemCard key={item.id} item={item} embedded={embedded} busy={busy !== null} canManage={data?.can_manage === true} onSync={() => void manageItem(item, "sync")} onDisconnect={() => void manageItem(item, "disconnect")} />;

  return (
    <section className="connections-view" aria-labelledby="connections-title">
      <SectionTitle aside={<button className="link-btn" disabled={reading || busy !== null} onClick={() => void load()}>Reload saved status</button>}>Connections</SectionTitle>
      <div className="integration-intro">
        <div>
          <h2 id="connections-title">Where your money lives</h2>
          <p>Bring bank, processor, crypto and manual records into one view. See what each source can read and when its money was last checked.</p>
        </div>
        <span className="integration-local-chip">US first · local workspace</span>
      </div>

      {error && <div className="notice notice-error">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {!data && !error && <p className="journey-note">Reading your saved sources…</p>}
      {data && <>
        <div className="card connection-start">
          <div><h3>Connect a test bank</h3><Badge tone="gold">Sandbox • test accounts</Badge></div>
          <p>Try reading US bank balances and transactions with Plaid test accounts. Bank linking does not enable payments. Opening this page does not contact Plaid; the button opens its connection window.</p>
          {data.can_manage && data.plaid.configured ? <button className="btn btn-primary" disabled={busy !== null} onClick={() => void connectBank()}>{busy === "link" ? "Connecting…" : "Connect a test bank"}</button>
            : <p className="journey-note">{!data.can_manage ? "The workspace owner can manage connections." : "Plaid sandbox is not configured on this node. Add its sandbox configuration on the server to enable test linking."}</p>}
        </div>
        {onGoto && <div className="btn-row journey-actions"><button className="btn btn-ghost" onClick={() => onGoto("accounts")}>Add Stripe, crypto or a manual account</button><button className="link-btn" onClick={() => onGoto("ledger")}>Import or review activity</button></div>}
        {orphanItems.length > 0 && <section className="bank-items" aria-label="Banks waiting for account data"><h3>Banks waiting for account data</h3>{orphanItems.map((item) => itemControls(item))}</section>}
        <div className="money-source-grid">{data.sources.map((source) => { const item = data.plaid.items.find((candidate) => candidate.id === source.id); return <MoneySource key={source.id} source={source} onGoto={onGoto} management={item ? itemControls(item, true) : undefined} />; })}{standalone.map((account) => <SavedMoneySource key={account.id} account={account} onGoto={onGoto} />)}</div>
        {data.sources.length === 0 && standalone.length === 0 && <p className="empty-state">No money sources yet. Add a manual account to start, or connect a configured test bank.</p>}
        <p className="journey-note">PayPal and Cash App connections are not implemented here. Record or import their activity manually for now.</p>
      </>}

      <details className="advanced-connections"><summary>Advanced connection readiness</summary>
      <p className="journey-note">Engineering readiness and current limits for other wallet, device and bank integrations. These entries are separate from your connected money sources.</p>
      {catalogError && <p className="form-error">{catalogError}</p>}
      {catalog && <>
          <div className="integration-safety" role="note">
            <strong>You authorize access</strong>
            <span>An agent can help prepare a request. Passkey, device, wallet and bank approval steps require you.</span>
          </div>
          <div className="integration-grid">
            {catalog.integrations.map((item) => <ConnectionCard key={item.id} item={item} />)}
          </div>
          <p className="integration-generated">
            Local projection generated {new Date(catalog.generated_at).toLocaleString()} ·
            pairing material, OAuth tokens, provider URLs and device identifiers are excluded.
          </p>
        </>}
      </details>
    </section>
  );
}
