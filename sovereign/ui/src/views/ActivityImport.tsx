import { useEffect, useRef, useState } from "react";
import { api, currentSessionGuard, errorMessage } from "../api";
import { Amount, Field } from "../components";
import type { Account, DistinctImportRow, ImportPreview } from "../types";

export const MAX_IMPORT_BYTES = 1_000_000;
export const canImportActivity = (account: Account): boolean => account.status.toUpperCase() === "ACTIVE" && !account.connector_type && !account.read_connection_id;
export function importSizeProblem(csv: string): string | null {
  if (!csv.trim()) return "Choose a CSV file or paste its contents first.";
  return new TextEncoder().encode(csv).byteLength > MAX_IMPORT_BYTES ? "Use a CSV file no larger than 1 MB." : null;
}

export function ImportPreviewTable({ preview, choices = preview.distinct_rows, changed = false, busy = false, onChoice }: {
  preview: ImportPreview; choices?: DistinctImportRow[]; changed?: boolean; busy?: boolean;
  onChoice?(rowId: string, reference: string | null): void;
}) {
  return <div className="import-preview">
    <p role="status"><strong>{preview.row_count} {preview.row_count === 1 ? "row" : "rows"}</strong> · {changed ? "Update the preview to review what will be added or skipped." : `${preview.row_count - preview.duplicate_count} will be added; ${preview.duplicate_count} already recorded will be skipped.`}</p>
    <p className="journey-note">Matches use date, title, amount and currency. If a match is a different real transaction, choose “Keep as a separate transaction” and give it a unique, reusable reference, such as a statement ID and line number. Use that same reference for that entry in later imports. References are case-sensitive and specific to this account.</p>
    <p className="journey-note">Repeated rows within this file are preserved. Skipped entries keep their existing categories.</p>
    <p className="journey-note">Importing adds activity only. It does not change balances or move money.</p>
    <div className="table-wrap"><table className="ledger-table"><thead><tr><th>Date</th><th>Title</th><th className="th-amt">Amount</th><th>Category</th><th>Review</th></tr></thead><tbody>{preview.rows.map((row, index) => {
      const choice = choices.find((value) => value.row_id === row.row_id);
      return <tr key={row.row_id}><td data-label="Date">{row.date.slice(0, 10)}</td><td data-label="Title">{row.title}</td><td data-label="Amount" className="td-amt"><Amount minor={row.amount_minor} decimals={preview.decimals} currency={row.currency} signed /></td><td data-label="Category">{row.category || "—"}</td><td data-label="Review" className="import-row-review">
        <span>{changed ? "Needs updated preview" : row.already_recorded ? "Will skip · already recorded" : row.distinct_reference ? "Will add · separate transaction" : "Will add"}</span>
        {row.matched_existing && onChoice && <label className="import-distinct-choice"><input type="checkbox" checked={!!choice} disabled={busy} aria-label={`Keep as a separate transaction: row ${index + 1}, ${row.title}`} onChange={(event) => onChoice(row.row_id, event.target.checked ? "" : null)} />Keep as a separate transaction</label>}
        {choice && (onChoice ? <Field label={`Reusable reference for row ${index + 1}`}><input value={choice.reference} disabled={busy} maxLength={120} autoComplete="off" spellCheck={false} placeholder="e.g. Sep statement, line 18" onChange={(event) => onChoice(row.row_id, event.target.value)} /></Field> : <span>Reference: {choice.reference}</span>)}
      </td></tr>;
    })}</tbody></table></div>
  </div>;
}

export function ActivityImport({ accounts, initialAccountId, onImported }: { accounts: Account[]; initialAccountId?: string; onImported(): void }) {
  const active = accounts.filter(canImportActivity);
  const [accountId, setAccountId] = useState(active.find((account) => account.id === initialAccountId)?.id ?? active[0]?.id ?? "");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<DistinctImportRow[]>([]);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const live = useRef(true);
  const revision = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; revision.current++; }; }, []);
  const invalidate = () => { revision.current++; setPreview(null); setChoices([]); setReviewChanged(false); setError(null); setNotice(null); };
  const changeChoice = (rowId: string, reference: string | null) => {
    revision.current++; setError(null); setNotice(null); setReviewChanged(true);
    setChoices((old) => reference === null ? old.filter((choice) => choice.row_id !== rowId)
      : [...old.filter((choice) => choice.row_id !== rowId), { row_id: rowId, reference }]);
  };

  async function readFile(file: File | undefined) {
    invalidate();
    setCsv("");
    const version = revision.current;
    const current = currentSessionGuard();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setError("Use a CSV file no larger than 1 MB."); return; }
    try { const contents = await file.text(); if (live.current && current() && version === revision.current) setCsv(contents); }
    catch { if (live.current && current() && version === revision.current) setError("This file could not be read. Try another CSV file."); }
  }

  async function perform(confirm: boolean) {
    if (pending.current) return;
    setError(null); setNotice(null);
    const problem = importSizeProblem(csv);
    if (problem) { setError(problem); return; }
    if (!active.some((account) => account.id === accountId)) { setError("Choose an active manual account for these entries."); return; }
    if (choices.some((choice) => !choice.reference.trim())) { setError("Give every separate transaction a reusable reference before updating the preview."); return; }
    if (confirm && (!preview || preview.account_id !== accountId || reviewChanged)) return;
    const version = revision.current;
    const current = currentSessionGuard();
    pending.current = true; setBusy(true);
    try {
      if (confirm && preview) {
        const result = await api.importTransactions(accountId, csv, preview.preview_hash, choices);
        if (!live.current || !current() || version !== revision.current) return;
        setPreview(null); setCsv(""); setChoices([]); setReviewChanged(false);
        setNotice(`${result.imported} entries imported; ${result.skipped} already recorded entries skipped. Balances are unchanged.`);
        onImported();
      } else {
        const result = await api.previewImport(accountId, csv, choices);
        if (live.current && current() && version === revision.current) { setPreview(result); setChoices(result.distinct_rows); setReviewChanged(false); }
      }
    } catch (reason) { if (live.current && current() && version === revision.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (live.current && current()) setBusy(false); }
  }

  return <section className="card activity-import" aria-label="Import activity from CSV"><h3>Import a statement</h3>
    <p className="journey-note">Choose a manual account. Importing a provider statement into an already connected account can duplicate its activity.</p>
    <p className="journey-note">Use the columns <code>date,title,amount,currency,category</code>. Category is optional. Dates use YYYY-MM-DD; positive amounts are money in and negative amounts are money out. Up to 2,000 rows and 1 MB.</p>
    <Field label="Import into account"><select value={accountId} disabled={busy} onChange={(event) => { invalidate(); setAccountId(event.target.value); }}><option value="">Choose an active manual account…</option>{active.map((account) => <option key={account.id} value={account.id}>{account.display_name} ({account.currency}){account.read_environment === "sandbox" ? " · sandbox" : ""}</option>)}</select></Field>
    {active.length === 0 && <p className="notice">Add a manual account in Accounts before importing a statement.</p>}
    <Field label="CSV file"><input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => void readFile(event.target.files?.[0])} /></Field>
    <Field label="Or paste CSV"><textarea value={csv} disabled={busy} rows={5} spellCheck={false} onChange={(event) => { invalidate(); setCsv(event.target.value); }} placeholder={'date,title,amount,currency,category\n2026-09-01,Groceries,-42.50,USD,Food'} /></Field>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {preview && <ImportPreviewTable preview={preview} choices={choices} changed={reviewChanged} busy={busy} onChoice={changeChoice} />}
    <div className="btn-row">{preview ? <>{reviewChanged && <button className="btn btn-primary" disabled={busy} onClick={() => void perform(false)}>{busy ? "Checking CSV…" : "Update preview"}</button>}<button className={`btn ${reviewChanged ? "btn-ghost" : "btn-primary"}`} disabled={busy || reviewChanged} onClick={() => void perform(true)}>{busy && !reviewChanged ? "Importing…" : `Confirm import into ${active.find((account) => account.id === accountId)?.display_name ?? "account"}`}</button><button className="btn btn-ghost" disabled={busy} onClick={invalidate}>Back to editing</button></> : <button className="btn btn-primary" disabled={busy || !accountId} onClick={() => void perform(false)}>{busy ? "Checking CSV…" : "Preview import"}</button>}</div>
  </section>;
}
