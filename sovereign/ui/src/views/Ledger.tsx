import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
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

const LIMIT = 200;

export function Ledger() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // manual entry
  const [showEntry, setShowEntry] = useState(false);
  const [entryAccount, setEntryAccount] = useState("");
  const [entryDir, setEntryDir] = useState<"in" | "out">("out");
  const [entryTitle, setEntryTitle] = useState("");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryDate, setEntryDate] = useState(todayISO());
  const [entryCategory, setEntryCategory] = useState("");
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await api.accounts();
        if (!live) return;
        setAccounts(r.accounts);
        const first = r.accounts.find((a) => a.status !== "archived");
        if (first) setEntryAccount((cur) => cur || first.id);
      } catch (ex) {
        if (live) setErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setTxs(null);
    void (async () => {
      try {
        const r = await api.transactions({
          accountId: filter || undefined,
          limit: LIMIT,
        });
        if (live) setTxs(r.transactions);
      } catch (ex) {
        if (live) setErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, [filter, reloadTick]);

  const byId = new Map((accounts ?? []).map((a) => [a.id, a]));

  async function submitEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEntryErr(null);
    const acct = byId.get(entryAccount);
    if (!acct) {
      setEntryErr("Pick an account for this entry.");
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
        date: entryDate || undefined,
        category: entryCategory.trim() || undefined,
      });
      toast("Recorded in the ledger.", "ok");
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

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!accounts) return <LoadingThreads />;

  return (
    <div className="stagger">
      <SectionTitle
        aside={
          <button className="link-btn" onClick={() => setShowEntry((s) => !s)}>
            {showEntry ? "close entry form" : "+ record an entry"}
          </button>
        }
      >
        Ledger
      </SectionTitle>

      {showEntry && (
        <form className="card entry-form" onSubmit={(e) => void submitEntry(e)}>
          <div className="field-row">
            <Field label="Account">
              <select value={entryAccount} onChange={(e) => setEntryAccount(e.target.value)}>
                {accounts
                  .filter((a) => a.status !== "archived")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name} ({a.currency})
                    </option>
                  ))}
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
            <button className="btn btn-primary" type="submit" disabled={entryBusy}>
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
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
            </option>
          ))}
        </select>
        {txs && txs.length >= LIMIT && (
          <span className="ledger-cap">showing the latest {LIMIT}</span>
        )}
      </div>

      {!txs ? (
        <LoadingThreads />
      ) : txs.length === 0 ? (
        <EmptyState>
          No entries {filter ? "for this account " : ""}yet. The ledger fills as
          money moves — or record one by hand above.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Title</th>
                <th className="th-amt">Amount</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => {
                const acct = byId.get(t.account_id);
                const decimals = acct?.decimals ?? 2;
                return (
                  <tr key={t.id}>
                    <td className="td-date">{formatDate(t.date)}</td>
                    <td className="td-title">
                      {t.title}
                      {t.category && <span className="tx-category">{t.category}</span>}
                      {!filter && acct && (
                        <span className="tx-account">{acct.display_name}</span>
                      )}
                    </td>
                    <td className="td-amt">
                      <Amount
                        minor={t.amount_minor}
                        decimals={decimals}
                        currency={acct?.currency}
                        signed
                      />
                    </td>
                    <td>
                      <Badge tone="dim">{t.source}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
