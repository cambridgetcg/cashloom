import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, currentSessionGuard, errorMessage, type ActivityPage } from "../api";
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
import "./ledger.css";

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
  query: string;
  transactions: Tx[] | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  requestId: number;
}

export function emptyLedgerRead(filter = "", query = ""): LedgerReadState {
  return { filter, query, transactions: null, loading: true, loadingMore: false, error: null, moreError: null,
    hasMore: false, nextCursor: null, requestId: 0 };
}

/** Only the exact criteria that produced a snapshot may retain its rows/cursor. */
export function beginLedgerRead(previous: LedgerReadState, filter: string, query = "", requestId = previous.requestId + 1, append = false): LedgerReadState {
  const same = previous.filter === filter && previous.query === query;
  return { filter, query, requestId, transactions: same ? previous.transactions : null,
    loading: !append, loadingMore: append, error: null, moreError: null,
    hasMore: same ? previous.hasMore : false, nextCursor: same ? previous.nextCursor : null };
}

export function finishLedgerRead(previous: LedgerReadState, requestId: number, page: ActivityPage, append: boolean): LedgerReadState {
  if (previous.requestId !== requestId) return previous;
  // A provider may move a record across a page boundary between reads. Keep
  // one row per ID and use the newly read version without fabricating totals.
  const rows = new Map<string, Tx>((append ? previous.transactions ?? [] : []).map(row => [row.id, row]));
  for (const row of page.transactions) rows.set(row.id, row);
  return { ...previous, transactions: [...rows.values()], loading: false, loadingMore: false, error: null, moreError: null,
    hasMore: page.has_more, nextCursor: page.has_more ? page.next_cursor : null };
}

export function failLedgerRead(previous: LedgerReadState, requestId: number, message: string, append: boolean): LedgerReadState {
  if (previous.requestId !== requestId) return previous;
  return { ...previous, loading: false, loadingMore: false, error: append ? null : message, moreError: append ? message : null };
}

/** An archived/missing filter never silently selects a different account. */
export function freshLedgerAccount(accounts: Account[], filter: string): string {
  const eligible = (account: Account) => account.status.toUpperCase() === "ACTIVE";
  return (filter ? accounts.find(account => account.id === filter && eligible(account)) : accounts.find(eligible))?.id ?? "";
}

export function hasLedgerDraft(draft: { title: string; amount: string; category: string; date: string; initialDate: string; direction: "in" | "out"; accountChosen: boolean }): boolean {
  return draft.title !== "" || draft.amount !== "" || draft.category !== "" || draft.date !== draft.initialDate || draft.direction !== "out" || draft.accountChosen;
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

export interface LedgerCriteria { accountId?: string; query: string }

export function Ledger({ initialAccountId, initialQuery = "", onCriteriaChange, onGoto }: {
  initialAccountId?: string; initialQuery?: string; onCriteriaChange?(criteria: LedgerCriteria): void; onGoto?: WalletNavigate;
} = {}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [history, setHistory] = useState<LedgerReadState>(() => emptyLedgerRead(initialAccountId ?? "", initialQuery.trim()));
  const [filter, setFilter] = useState(initialAccountId ?? "");
  const [query, setQuery] = useState(initialQuery.trim());
  const [searchDraft, setSearchDraft] = useState(initialQuery.trim());
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showTransfers, setShowTransfers] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const live = useRef(true);
  const exporting = useRef(false);
  const readGeneration = useRef(0);
  const reading = useRef(false);
  const entrySubmitting = useRef(false);
  const activeCriteria = useRef({ filter, query });
  activeCriteria.current = { filter, query };

  useEffect(() => {
    live.current = true;
    const session = currentSessionGuard();
    void api.connections().then((result) => { if (live.current && session()) setCanManage(result.can_manage === true); }, () => { if (live.current && session()) setCanManage(false); });
    return () => { live.current = false; readGeneration.current++; };
  }, []);

  async function exportActivity() {
    if (exporting.current) return;
    exporting.current = true; setExportBusy(true); setExportError(null);
    const current = currentSessionGuard();
    const accountScope = filter;
    try {
      const data = await api.exportTransactions(filter || undefined);
      if (live.current && current()) {
        if (activeCriteria.current.filter !== accountScope) setExportError("The selected account changed. Export again for your current selection.");
        else downloadFile("cashloom-activity.json", JSON.stringify(data, null, 2), "application/json");
      }
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
  const entryInitialDate = useRef(entryDate);
  const [entryAccountChosen, setEntryAccountChosen] = useState(false);
  const [entryCategory, setEntryCategory] = useState("");
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);
  const [entryNotice, setEntryNotice] = useState<string | null>(null);
  const entryHasDraft = hasLedgerDraft({ title: entryTitle, amount: entryAmount, category: entryCategory,
    date: entryDate, initialDate: entryInitialDate.current, direction: entryDir, accountChosen: entryAccountChosen });

  useEffect(() => {
    let active = true;
    const session = currentSessionGuard();
    setAccountsError(null);
    setAccountsLoading(true);
    void (async () => {
      try {
        const r = await api.accounts({ includeArchived: true });
        if (!active || !live.current || !session()) return;
        setAccounts(r.accounts);
      } catch (ex) {
        if (active && live.current && session()) setAccountsError(errorMessage(ex));
      } finally {
        if (active && live.current && session()) setAccountsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadTick]);

  async function readHistory(append: boolean, cursor?: string) {
    if (append && reading.current) return;
    const requestId = ++readGeneration.current;
    const session = currentSessionGuard();
    reading.current = true;
    setHistory(previous => beginLedgerRead(previous, filter, query, requestId, append));
    try {
      const page = await api.transactions({ accountId: filter || undefined, limit: LIMIT, q: query || undefined, cursor });
      if (!Array.isArray(page.transactions) || typeof page.has_more !== "boolean" ||
        (page.has_more && (typeof page.next_cursor !== "string" || !page.next_cursor || page.next_cursor === cursor))) {
        throw new Error("Saved history could not be continued. Reload saved history to try again.");
      }
      if (live.current && session() && readGeneration.current === requestId) {
        setHistory(previous => finishLedgerRead(previous, requestId, page, append));
      }
    } catch (reason) {
      if (live.current && session() && readGeneration.current === requestId) {
        setHistory(previous => failLedgerRead(previous, requestId, errorMessage(reason), append));
      }
    } finally { if (readGeneration.current === requestId) reading.current = false; }
  }

  useEffect(() => {
    void readHistory(false);
    return () => { readGeneration.current++; reading.current = false; };
  }, [filter, query, reloadTick]);

  useEffect(() => {
    if (showEntry && !entryHasDraft && !entryBusy) setEntryAccount(freshLedgerAccount(accounts ?? [], filter));
  }, [accounts, filter, showEntry, entryHasDraft, entryBusy]);

  const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
  const txs = history.filter === filter && history.query === query ? history.transactions : null;
  const retryReads = () => { readGeneration.current++; reading.current = false; setReloadTick((tick) => tick + 1); };
  function changeCriteria(nextFilter: string, nextQuery: string) {
    readGeneration.current++; reading.current = false;
    setFilter(nextFilter); setQuery(nextQuery);
    onCriteriaChange?.({ accountId: nextFilter || undefined, query: nextQuery });
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = searchDraft.trim();
    setSearchDraft(next);
    if (next === query) retryReads(); else changeCriteria(filter, next);
  }
  function clearSearch() {
    setSearchDraft("");
    if (query) changeCriteria(filter, "");
  }
  function toggleEntry() {
    if (!showEntry && !entryHasDraft) {
      setEntryAccount(freshLedgerAccount(accounts ?? [], filter));
      const today = todayISO(); entryInitialDate.current = today; setEntryDate(today);
      setEntryAccountChosen(false); setEntryErr(null);
    }
    setShowEntry(value => !value);
  }

  async function submitEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (entrySubmitting.current) return;
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
    const session = currentSessionGuard();
    if (!session()) return;
    entrySubmitting.current = true; setEntryBusy(true); setEntryNotice(null);
    try {
      await api.createTransaction({
        account_id: acct.id,
        title: entryTitle.trim(),
        amount_minor: entryDir === "out" ? `-${minor}` : minor,
        date: ledgerDateToIso(entryDate),
        category: entryCategory.trim() || undefined,
      });
      if (!live.current || !session()) return;
      toast("Entry saved in Activity.", "ok");
      setEntryTitle("");
      setEntryAmount("");
      setEntryCategory("");
      setEntryDir("out"); setEntryAccountChosen(false);
      const today = todayISO(); entryInitialDate.current = today; setEntryDate(today);
      const selection = activeCriteria.current;
      setEntryNotice(`Entry saved for ${acct.display_name}.${selection.query || selection.filter && selection.filter !== acct.id ? " Your current Activity filters may hide it." : ""}`);
      retryReads();
    } catch (ex) {
      if (live.current && session()) setEntryErr(`${errorMessage(ex)} Reload saved history before trying again if the outcome is uncertain.`);
    } finally {
      entrySubmitting.current = false;
      if (live.current && session()) setEntryBusy(false);
    }
  }

  return (
    <div className="stagger ledger-view">
      <SectionTitle
        aside={
          <button className="link-btn" disabled={entryBusy} onClick={toggleEntry}>
            {showEntry ? "close entry form" : "+ record an entry"}
          </button>
        }
      >
        Activity
      </SectionTitle>

      <p className="journey-note">Recorded activity is separate from a balance check. Adding an entry does not move money or change a saved account balance.</p>
      {accountsError && <p className="journey-note" role="status">Account details could not be loaded. {accountsError}{" "}<button className="link-btn" onClick={retryReads}>Retry account details</button></p>}
      {accountsLoading && !accounts && <p className="journey-note" role="status">Loading account details…</p>}
      {entryNotice && <p className="journey-note" role="status">{entryNotice}</p>}
      {!showEntry && entryHasDraft && filter && entryAccount !== filter && <p className="journey-note" role="status">Your draft is still for <strong>{byId.get(entryAccount)?.display_name ?? "its selected account"}</strong>. <button className="link-btn" onClick={toggleEntry}>Continue draft</button></p>}
      {onGoto && <div className="btn-row journey-actions">
        <button className="link-btn" onClick={() => onGoto("accounts", filter ? { accountId: filter } : undefined)}>View accounts and balances</button>
        <button className="link-btn" onClick={() => onGoto("trades")}>Open agreements</button>
      </div>}
      <div className="activity-tools btn-row">
        {canManage && <button className="btn btn-ghost" onClick={() => setShowImport((value) => !value)}>{showImport ? "Close import" : "Import CSV"}</button>}
        <button className="btn btn-ghost" onClick={() => setShowTransfers((value) => !value)}>{showTransfers ? "Close transfer review" : "Review internal transfers"}</button>
        <button className="btn btn-ghost" disabled={exportBusy} onClick={() => void exportActivity()}>{exportBusy ? "Preparing export…" : filter ? "Export this account (JSON)" : "Export all activity (JSON)"}</button>
      </div>
      <p className="ledger-export-note">JSON export includes all saved entries {filter ? "for the selected account" : "across all accounts"}, regardless of the search or loaded pages.</p>
      {exportError && <p className="form-error" role="alert">{exportError}</p>}
      {showImport && canManage && accounts && <ActivityImport accounts={accounts} initialAccountId={filter || undefined} onImported={retryReads} />}
      {showTransfers && <TransferReview onChanged={retryReads} />}

      {showEntry && (
        <form className="card entry-form" aria-label="Record activity" onSubmit={(e) => void submitEntry(e)}>
          {entryHasDraft && filter && entryAccount !== filter && <p className="notice" role="status">Your draft is still for <strong>{byId.get(entryAccount)?.display_name ?? "the account selected below"}</strong>. The Activity account filter does not change this draft’s destination.</p>}
          {filter && accounts && byId.get(filter)?.status.toUpperCase() !== "ACTIVE" && <p className="journey-note">The selected Activity account is no longer active. Choose an active account below before adding an entry.</p>}
          <fieldset className="ledger-entry-fields" disabled={entryBusy}>
          <div className="field-row">
            <Field label="Account">
              <select value={entryAccount} onChange={(e) => { setEntryAccount(e.target.value); setEntryAccountChosen(true); }}>
                <option value="">choose an active account…</option>
                {entryAccount && byId.get(entryAccount)?.status.toUpperCase() !== "ACTIVE" && <option value={entryAccount} disabled>{byId.get(entryAccount)?.display_name ?? "Account unavailable"} · unavailable for new entries</option>}
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
                maxLength={200}
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
                maxLength={60}
                onChange={(e) => setEntryCategory(e.target.value)}
                placeholder="groceries, rent…"
              />
            </Field>
          </div>
          {entryErr && <p className="form-error" role="alert">{entryErr}</p>}
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={entryBusy || accountsLoading || accountsError !== null}>
              {entryBusy ? "Recording…" : "Record"}
            </button>
          </div>
          </fieldset>
        </form>
      )}

      <div className="ledger-toolbar">
        <select
          value={filter}
          onChange={(e) => changeCriteria(e.target.value, query)}
          aria-label="Filter by account"
        >
          <option value="">All accounts</option>
          {filter && accounts && !byId.has(filter) && <option value={filter}>Selected account unavailable</option>}
          <LedgerAccountOptions accounts={accounts ?? []} history />
        </select>
        <button className="link-btn" onClick={retryReads} disabled={accountsLoading || history.loading || history.loadingMore}>Reload saved history</button>
      </div>
      <form className="ledger-search" aria-label="Search activity" onSubmit={search}>
        <label htmlFor="activity-search">Search titles and categories</label>
        <div className="ledger-search-controls"><input id="activity-search" aria-label="Search titles and categories" type="search" value={searchDraft} maxLength={120} autoComplete="off" spellCheck={false} placeholder="Search saved activity…" onChange={event => setSearchDraft(event.target.value)} />
          <button className="btn btn-primary" type="submit">Search</button>
          <button className="btn btn-ghost" type="button" disabled={!searchDraft && !query} onClick={clearSearch}>Clear search</button>
        </div>
        <p>Search all saved history for the selected accounts. Press Search to apply your text.</p>
      </form>
      <p className="ledger-results-summary" role="status">{filter ? byId.get(filter)?.display_name ?? "Selected account" : "All accounts"}{query ? <> · Matching “{query}”</> : " · All titles and categories"}{txs && <> · {txs.length} {query ? "matching " : ""}{txs.length === 1 ? "entry" : "entries"} loaded</>}</p>

      <LedgerReadNotice error={history.error} loading={history.loading} retained={txs !== null} onRetry={retryReads} />
      {!txs ? (
        history.loading ? <LoadingThreads /> : null
      ) : txs.length === 0 ? (
        <EmptyState>
          {query ? <>No matching entries {filter ? "for this account" : "across your saved accounts"}. Try different text or <button className="link-btn" onClick={clearSearch}>clear the search</button>.</>
            : <>No entries {filter ? "for this account " : ""}yet. Record an entry above, or sync a supported account to read its activity.</>}
        </EmptyState>
      ) : (
        <LedgerHistory transactions={txs} accounts={accounts ?? []} filter={filter} />
      )}
      {txs && txs.length > 0 && <div className="ledger-pagination">
        {history.moreError && <p className="form-error" role="alert">{history.moreError} Your loaded entries are still shown.</p>}
        {history.hasMore && history.nextCursor ? <button className="btn btn-ghost" disabled={history.loading || history.loadingMore} onClick={() => { if (history.nextCursor) void readHistory(true, history.nextCursor); }}>{history.loadingMore ? "Loading older entries…" : history.moreError ? "Retry older entries" : "Load older"}</button>
          : !history.loading && <p>No older matches in saved history.</p>}
      </div>}
    </div>
  );
}
