import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, currentSessionGuard, errorMessage } from "../api";
import {
  Amount,
  Badge,
  EmptyState,
  Field,
  LoadingThreads,
  SectionTitle,
} from "../components";
import { formatDate, parseToMinor, todayISO } from "../format";
import { toast } from "../toast";
import type { Account, Tx } from "../types";
import type { WalletNavigate } from "../navigation";
import { ActivityImport } from "./ActivityImport";
import { TransferReview } from "./TransferReview";
import { downloadFile } from "../money-data";

const LIMIT = 200;

/** Imported statements contain calendar dates; preserve that day in every timezone. */
export function activityDate(transaction: Pick<Tx, "date" | "source">): string {
  if (transaction.source?.toUpperCase() !== "CSV") return formatDate(transaction.date);
  const date = new Date(transaction.date);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : transaction.date;
}

export function LedgerAccountOptions({ accounts, history = false }: { accounts: Account[]; history?: boolean }) {
  return <>{accounts.filter((account) => history || account.status.toUpperCase() === "ACTIVE").map((account) => (
    <option key={account.id} value={account.id}>{account.display_name} ({account.currency}){account.read_environment === "sandbox" ? " · sandbox" : ""}{account.status.toUpperCase() === "ARCHIVED" ? " · archived" : ""}</option>
  ))}</>;
}

export function LedgerHistory({ transactions, accounts, filter }: { transactions: Tx[]; accounts: Account[]; filter: string }) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return (
    <div className="table-wrap">
      <table className="ledger-table">
        <thead><tr><th>Date</th><th>Title</th><th className="th-amt">Amount</th><th>Source</th></tr></thead>
        <tbody>{transactions.map((transaction) => {
          const account = byId.get(transaction.account_id);
          const knownAmount = account && Number.isInteger(account.decimals) && account.decimals >= 0 &&
            account.decimals <= 18 && account.currency.trim() !== "";
          return <tr key={transaction.id}>
            <td className="td-date">{activityDate(transaction)}</td>
            <td className="td-title">
              {transaction.title}
              {transaction.category && <span className="tx-category">{transaction.category}</span>}
              {account?.read_environment === "sandbox" && <span className="tx-account">Sandbox • test accounts</span>}
              {account && (!filter || account.status.toUpperCase() === "ARCHIVED") &&
                <span className="tx-account">{account.display_name}{account.status.toUpperCase() === "ARCHIVED" ? " · archived" : ""}</span>}
              {!account && <span className="tx-account">Account details unavailable</span>}
            </td>
            <td className="td-amt">
              {knownAmount ? <Amount minor={transaction.amount_minor} decimals={account.decimals} currency={account.currency} signed />
                : <span><code>{transaction.amount_minor}</code> atomic units<span className="tx-account">Currency and precision unavailable</span></span>}
            </td>
            <td><Badge tone="dim">{transaction.source}</Badge>{transaction.status && <Badge tone={transaction.status === "posted" ? "neutral" : "dim"}>{transaction.status}</Badge>}{transaction.transfer_link_id && <Badge tone="gold">Internal transfer</Badge>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

export interface LedgerReadState {
  filter: string;
  transactions: Tx[] | null;
  loading: boolean;
  error: string | null;
}

/** Keep a readable snapshot only for the filter that produced it. */
export function beginLedgerRead(previous: LedgerReadState, filter: string): LedgerReadState {
  return { filter, transactions: previous.filter === filter ? previous.transactions : null, loading: true, error: null };
}

export function LedgerReadNotice({ error, loading, retained, onRetry }: {
  error: string | null; loading: boolean; retained: boolean; onRetry(): void;
}) {
  if (!error && !loading) return null;
  return <div className="journey-note" role="status">
    {error ? <>{error} {retained ? "Showing the last loaded entries. " : ""}<button className="link-btn" onClick={onRetry}>Retry history</button></>
      : retained ? "Reloading saved history…" : "Loading saved history…"}
  </div>;
}

/** Preserve the owner's selected local calendar day in the API's instant format. */
export function ledgerDateToIso(day: string): string | undefined {
  if (!day) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a valid date for this entry.");
  const date = new Date(`${day}T00:00:00`);
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== dayOfMonth) {
    throw new Error("Choose a valid date for this entry.");
  }
  return date.toISOString();
}

export function Ledger({ initialAccountId, onGoto }: { initialAccountId?: string; onGoto?: WalletNavigate } = {}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [history, setHistory] = useState<LedgerReadState>({ filter: initialAccountId ?? "", transactions: null, loading: true, error: null });
  const [filter, setFilter] = useState(initialAccountId ?? "");
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const selectedInitially = useRef(false);
  const [canManage, setCanManage] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const live = useRef(true);
  const exporting = useRef(false);

  useEffect(() => {
    live.current = true;
    void api.connections().then((result) => { if (live.current) setCanManage(result.can_manage === true); }, () => { if (live.current) setCanManage(false); });
    return () => { live.current = false; };
  }, []);

  async function exportActivity() {
    if (exporting.current) return;
    exporting.current = true; setExportBusy(true); setExportError(null);
    const current = currentSessionGuard();
    try {
      const data = await api.exportTransactions(filter || undefined);
      if (live.current && current()) downloadFile("cashloom-activity.json", JSON.stringify(data, null, 2), "application/json");
    } catch (reason) { if (live.current && current()) setExportError(errorMessage(reason)); }
    finally { exporting.current = false; if (live.current && current()) setExportBusy(false); }
  }

  // manual entry
  const [showEntry, setShowEntry] = useState(false);
  const [entryAccount, setEntryAccount] = useState(initialAccountId ?? "");
  const [entryDir, setEntryDir] = useState<"in" | "out">("out");
  const [entryTitle, setEntryTitle] = useState("");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryDate, setEntryDate] = useState(todayISO());
  const [entryCategory, setEntryCategory] = useState("");
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setAccountsError(null);
    setAccountsLoading(true);
    void (async () => {
      try {
        const r = await api.accounts({ includeArchived: true });
        if (!live) return;
        setAccounts(r.accounts);
        if (selectedInitially.current) return;
        selectedInitially.current = true;
        const selected = initialAccountId ? r.accounts.find((a) => a.id === initialAccountId) : undefined;
        const first = r.accounts.find((a) => a.status.toUpperCase() === "ACTIVE");
        if (initialAccountId && (!selected || selected.status.toUpperCase() !== "ACTIVE")) {
          setEntryAccount("");
          setSelectionNotice("The selected account is no longer active. Choose an active account before adding an entry.");
          if (!selected) setFilter("");
        } else setEntryAccount(selected?.id ?? first?.id ?? "");
      } catch (ex) {
        if (live) setAccountsError(errorMessage(ex));
      } finally {
        if (live) setAccountsLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadTick]);

  useEffect(() => {
    let live = true;
    setHistory((current) => beginLedgerRead(current, filter));
    void (async () => {
      try {
        const r = await api.transactions({
          accountId: filter || undefined,
          limit: LIMIT,
        });
        if (live) setHistory({ filter, transactions: r.transactions, loading: false, error: null });
      } catch (ex) {
        if (live) setHistory((current) => ({ ...current, loading: false, error: errorMessage(ex) }));
      }
    })();
    return () => {
      live = false;
    };
  }, [filter, reloadTick]);

  const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
  const txs = history.filter === filter ? history.transactions : null;
  const retryReads = () => setReloadTick((tick) => tick + 1);

  async function submitEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEntryErr(null);
    const acct = byId.get(entryAccount);
    if (!acct || acct.status.toUpperCase() !== "ACTIVE") {
      setEntryErr("Pick an active account for this entry.");
      return;
    }
    if (!entryTitle.trim()) {
      setEntryErr("Every entry deserves a name.");
      return;
    }
    const minor = parseToMinor(entryAmount, acct.decimals);
    if (!minor || minor === "0") {
      setEntryErr(`Amount doesn't parse at ${acct.decimals} decimals.`);
      return;
    }
    setEntryBusy(true);
    try {
      await api.createTransaction({
        account_id: acct.id,
        title: entryTitle.trim(),
        amount_minor: entryDir === "out" ? `-${minor}` : minor,
        date: ledgerDateToIso(entryDate),
        category: entryCategory.trim() || undefined,
      });
      toast("Entry saved in Activity.", "ok");
      setEntryTitle("");
      setEntryAmount("");
      setEntryCategory("");
      setReloadTick((t) => t + 1);
    } catch (ex) {
      setEntryErr(errorMessage(ex));
    } finally {
      setEntryBusy(false);
    }
  }

  return (
    <div className="stagger">
      <SectionTitle
        aside={
          <button className="link-btn" onClick={() => setShowEntry((s) => !s)}>
            {showEntry ? "close entry form" : "+ record an entry"}
          </button>
        }
      >
        Activity
      </SectionTitle>

      <p className="journey-note">Recorded activity is separate from a balance check. Adding an entry does not move money or change a saved account balance.</p>
      {accountsError && <p className="journey-note" role="status">Account details could not be loaded. {accountsError}{" "}<button className="link-btn" onClick={retryReads}>Retry account details</button></p>}
      {accountsLoading && !accounts && <p className="journey-note" role="status">Loading account details…</p>}
      {selectionNotice && <p role="status">{selectionNotice}</p>}
      {onGoto && <div className="btn-row journey-actions">
        <button className="link-btn" onClick={() => onGoto("accounts", filter ? { accountId: filter } : undefined)}>View accounts and balances</button>
        <button className="link-btn" onClick={() => onGoto("trades")}>Open agreements</button>
      </div>}
      <div className="activity-tools btn-row">
        {canManage && <button className="btn btn-ghost" onClick={() => setShowImport((value) => !value)}>{showImport ? "Close import" : "Import CSV"}</button>}
        <button className="btn btn-ghost" onClick={() => setShowTransfers((value) => !value)}>{showTransfers ? "Close transfer review" : "Review internal transfers"}</button>
        <button className="btn btn-ghost" disabled={exportBusy} onClick={() => void exportActivity()}>{exportBusy ? "Preparing export…" : filter ? "Export this account (JSON)" : "Export all activity (JSON)"}</button>
      </div>
      {exportError && <p className="form-error" role="alert">{exportError}</p>}
      {showImport && canManage && accounts && <ActivityImport accounts={accounts} initialAccountId={filter || undefined} onImported={retryReads} />}
      {showTransfers && <TransferReview onChanged={retryReads} />}

      {showEntry && (
        <form className="card entry-form" onSubmit={(e) => void submitEntry(e)}>
          <div className="field-row">
            <Field label="Account">
              <select value={entryAccount} onChange={(e) => setEntryAccount(e.target.value)}>
                <option value="">choose an active account…</option>
                <LedgerAccountOptions accounts={accounts ?? []} />
              </select>
            </Field>
            <Field label="Direction">
              <div className="segmented" role="radiogroup" aria-label="Direction">
                <button
                  type="button"
                  className={entryDir === "in" ? "is-active seg-in" : ""}
                  onClick={() => setEntryDir("in")}
                >
                  money in
                </button>
                <button
                  type="button"
                  className={entryDir === "out" ? "is-active seg-out" : ""}
                  onClick={() => setEntryDir("out")}
                >
                  money out
                </button>
              </div>
            </Field>
          </div>
          <div className="field-row">
            <Field label="Title">
              <input
                value={entryTitle}
                onChange={(e) => setEntryTitle(e.target.value)}
                placeholder="what was it?"
              />
            </Field>
            <Field label="Amount">
              <input
                className="mono-input"
                value={entryAmount}
                onChange={(e) => setEntryAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
              />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Date">
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </Field>
            <Field label="Category (optional)">
              <input
                value={entryCategory}
                onChange={(e) => setEntryCategory(e.target.value)}
                placeholder="groceries, rent…"
              />
            </Field>
          </div>
          {entryErr && <p className="form-error">{entryErr}</p>}
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={entryBusy || accountsLoading || accountsError !== null}>
              {entryBusy ? "Recording…" : "Record"}
            </button>
          </div>
        </form>
      )}

      <div className="ledger-toolbar">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by account"
        >
          <option value="">All accounts</option>
          <LedgerAccountOptions accounts={accounts ?? []} history />
        </select>
        {txs && txs.length >= LIMIT && (
          <span className="ledger-cap">showing the latest {LIMIT}</span>
        )}
        <button className="link-btn" onClick={retryReads} disabled={accountsLoading || history.loading}>Reload saved history</button>
      </div>

      <LedgerReadNotice error={history.error} loading={history.loading} retained={txs !== null} onRetry={retryReads} />
      {!txs ? (
        history.loading ? <LoadingThreads /> : null
      ) : txs.length === 0 ? (
        <EmptyState>
          No entries {filter ? "for this account " : ""}yet. Record an entry above,
          or sync a supported account to read its activity.
        </EmptyState>
      ) : (
        <LedgerHistory transactions={txs} accounts={accounts ?? []} filter={filter} />
      )}
    </div>
  );
}
