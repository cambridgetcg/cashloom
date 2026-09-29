import { useEffect, useState } from "react";
import { api } from "../api";
import { Amount, Badge, EmptyState, LoadingThreads, RailBadge, SectionTitle } from "../components";
import { formatDateTime, formatMinor, shortAddress } from "../format";
import { beginOverviewLoad, buildOverview } from "../overview";
import { PUBLIC_PLAN_URL, type WalletNavigate } from "../navigation";
import { isCreditAccount } from "../components/AccountBalances";
import type { Account, BaseAccountPositionView, SummaryRow } from "../types";

interface OverviewContentProps {
  accounts: Account[];
  summary: SummaryRow[];
  positions: BaseAccountPositionView[] | null;
  positionsError?: string | null;
  summaryError?: string | null;
  onGoto: WalletNavigate;
}

export function WorkspaceActions({ empty, onGoto }: { empty: boolean; onGoto: WalletNavigate }) {
  return <section className="workspace-start" aria-labelledby="next-actions-title">
    <div className="workspace-start-heading">
      <p className="eyebrow">{empty ? "Start here" : "Make your next move"}</p>
      <h2 id="next-actions-title">{empty ? "Build a clear picture of your money" : "What would you like to do?"}</h2>
      <p>{empty ? "Start with one account. You can record cash or a bank balance without connecting a provider." : "Keep track of what happened, review a payment, or prepare an agreement."}</p>
    </div>
    <div className="workspace-actions">
      <button className="workspace-action" onClick={() => onGoto("accounts")}>
        <span className="action-number">01</span><strong>{empty ? "Add your first account" : "Update your accounts"}</strong>
        <span>{empty ? "Name it, choose its currency and record a balance." : "Record a balance or review a connected source."}</span><b aria-hidden="true">↗</b>
      </button>
      <button className="workspace-action" onClick={() => onGoto("ledger")}>
        <span className="action-number">02</span><strong>Track money in and out</strong>
        <span>Record and review activity for each account.</span><b aria-hidden="true">↗</b>
      </button>
      <button className="workspace-action" onClick={() => onGoto(empty ? "connections" : "pay")}>
        <span className="action-number">03</span><strong>{empty ? "Explore connections" : "Prepare a payment"}</strong>
        <span>{empty ? "See what is available and what still needs setup." : "Choose an eligible account, then review the quote."}</span><b aria-hidden="true">↗</b>
      </button>
    </div>
  </section>;
}

export function OverviewContent({
  accounts, summary, positions, positionsError, summaryError, onGoto,
}: OverviewContentProps) {
  const overview = buildOverview(accounts, summary, positions ?? []);
  return (
    <div className="stagger">
      <header className="workspace-intro">
        <p className="eyebrow">Overview</p>
        <h1>Your money, in view.</h1>
        <p>See where your money lives, keep useful records and decide what happens next.</p>
      </header>
      {overview.accountCount === 0 && <WorkspaceActions empty onGoto={onGoto} />}
      <SectionTitle aside={`${overview.accountCount} active account${overview.accountCount === 1 ? "" : "s"}`}>
        Saved balances
      </SectionTitle>
      {overview.accountCount === 0 ? (
        <EmptyState>
          No accounts yet.{" "}
          <button className="link-btn" onClick={() => onGoto("accounts")}>Add an account</button>
          {" "}to keep its balance and activity in one place. A missing balance stays unknown until you record or check it.
        </EmptyState>
      ) : (
        <>
          <p className="section-note">
            Each balance includes its source and time. Currencies and assets are kept separate, so you can see what each figure means.
          </p>
          {summaryError && <p className="notice notice-error" role="status">Activity totals could not be loaded. {summaryError}</p>}
          <div className="card-grid">
            {overview.baseWallets.map((wallet) => (
              <article className="card account-card" key={wallet.id}>
                <header className="card-head">
                  <h3>{wallet.accounts[0].display_name}</h3>
                  <Badge tone={wallet.state === "conflicted" || wallet.state === "identity_invalid" ? "ember" : "gold"}>Base</Badge>
                </header>
                <p className="card-asof" title={wallet.id}>{shortAddress(wallet.id.replace(/^eip155:8453:/, ""))}</p>
                {wallet.accounts.every((account) => !account.vault_key_id) && <p className="section-note">Watched address · Base ETH and native USDC. Watching does not establish ownership or permit spending.</p>}
                {wallet.accounts.length > 1 && (
                  <p className="section-note">One wallet · {wallet.accounts.length} account records: {wallet.accounts.map((account) => account.display_name).join(", ")}</p>
                )}
                {positions === null ? (
                  <p className="card-balance">{positionsError ? "Saved Base balance unavailable" : "Loading saved Base balances…"}</p>
                ) : wallet.view ? (
                  <div className="base-position-values" style={{ gridTemplateColumns: "1fr" }}>
                    {wallet.view.positions.map((position) => (
                      <div key={position.asset_id} style={{ overflowX: "auto", minWidth: 0 }}>
                        <span>{position.name || position.symbol}</span>
                        <Amount minor={position.observed_atomic} decimals={position.decimals} currency={position.symbol} size="lg" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="card-balance">{wallet.state === "conflicted" ? "Evidence needs review" : "Balance not established"}</p>
                )}
                <p className="section-note">
                  {positionsError ? `${positionsError} Open Accounts to retry loading saved evidence.` : positions === null ? "Reading saved evidence from your node." : wallet.message}
                </p>
                {wallet.view?.snapshot && (
                  <p className="card-asof">
                    2-provider finalized · block {wallet.view.snapshot.block.number}<br />
                    Observed <time dateTime={wallet.view.snapshot.observed_at}>{formatDateTime(wallet.view.snapshot.observed_at)}</time><br />
                    Block time <time dateTime={wallet.view.snapshot.block.timestamp}>{formatDateTime(wallet.view.snapshot.block.timestamp)}</time>
                  </p>
                )}
                <footer className="card-foot">
                  <button className="btn btn-ghost" onClick={() => onGoto("accounts", { accountId: wallet.view?.account_id ?? wallet.accounts[0].id })}>
                    {wallet.state === "conflicted" || wallet.state === "identity_invalid" ? "Review in Accounts" : "View or refresh in Accounts"}
                  </button>
                </footer>
              </article>
            ))}
            {overview.accounts.map(({ account, balance, summary: history }) => (
              <article className="card account-card" key={account.id}>
                <header className="card-head"><h3>{account.display_name}</h3><RailBadge rail={account.rail} /></header>
                {account.read_environment === "sandbox" && <Badge tone="gold">Sandbox • test accounts</Badge>}
                {isCreditAccount(account) && <p className="card-asof">Amount owed · credit account</p>}
                {account.chain_id && <p className="card-asof" style={{ overflowWrap: "anywhere" }} title={account.asset_id ?? undefined}>{account.asset_id ?? account.chain_id}</p>}
                <div className="card-balance" style={{ overflowX: "auto" }}>
                  {balance !== null
                    ? <Amount minor={balance} decimals={account.decimals} currency={account.currency} size="xl" />
                    : <span>Balance not recorded</span>}
                </div>
                <p className="card-asof">
                  {balance !== null && account.balance_as_of
                    ? <>{account.connector_type ? `${account.connector_type} observation` : "Recorded balance"} · <time dateTime={account.balance_as_of}>{formatDateTime(account.balance_as_of)}</time></>
                    : account.connector_type ? "Sync this account to observe its balance." : "Activity entries track money in and out; they do not establish this account’s balance."}
                </p>
                {history && (
                  <p className="card-flows" style={{ flexWrap: "wrap" }}>
                    <span className="flow-in">In {formatMinor(history.in_minor, account.decimals)} {account.currency}</span>
                    <span className="flow-out">Out {formatMinor(history.out_minor, account.decimals)} {account.currency}</span>
                    <span className="card-txcount">{history.tx_count} activity {history.tx_count === 1 ? "entry" : "entries"}</span>
                  </p>
                )}
                <footer className="card-foot">
                  <button className="btn btn-ghost" onClick={() => onGoto(account.read_connection_id ? "connections" : account.connector_type || (balance === null && account.rail !== "CRYPTO") ? "accounts" : "ledger", { accountId: account.id })}>
                    {account.read_connection_id ? "Manage connection / sync" : account.connector_type ? "View or sync in Accounts" : balance === null && account.rail !== "CRYPTO" ? "Record balance in Accounts" : "Open Activity"}
                  </button>
                  {!account.connector_type && balance === null && account.rail !== "CRYPTO" && <button className="link-btn" onClick={() => onGoto("ledger", { accountId: account.id })}>Open Activity</button>}
                </footer>
              </article>
            ))}
          </div>
        </>
      )}
      {overview.accountCount > 0 && <WorkspaceActions empty={false} onGoto={onGoto} />}
      <aside className="workspace-guidance">
        <h2>You decide what to connect</h2>
        <p>Manual accounts work on their own. Connections and signing keys are optional setup steps for supported services. Sending money always follows a separate review.</p>
        {PUBLIC_PLAN_URL ? <>
          <a className="link-btn" href={PUBLIC_PLAN_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open the separate money planner ↗</a>
          <p>The planner opens separately. Your workspace records are not sent to it.</p>
        </> : <p>The money planner is available in the separate CashLoom service preview.</p>}
      </aside>
    </div>
  );
}

export function Dashboard({ onGoto }: { onGoto: WalletNavigate }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [positions, setPositions] = useState<BaseAccountPositionView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    beginOverviewLoad(api, {
      accountsLoaded: (result) => { if (live) setAccounts(result); },
      accountsFailed: (message) => { if (live) setErr(message); },
      summaryLoaded: (result) => { if (live) setSummary(result); },
      summaryFailed: (message) => { if (live) setSummaryError(message); },
      positionsLoaded: (result) => { if (live) setPositions(result); },
      positionsFailed: (message) => { if (live) setPositionsError(message); },
    });
    return () => { live = false; };
  }, []);

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!accounts) return <LoadingThreads />;
  return <OverviewContent accounts={accounts} summary={summary} positions={positions}
    positionsError={positionsError} summaryError={summaryError} onGoto={onGoto} />;
}
