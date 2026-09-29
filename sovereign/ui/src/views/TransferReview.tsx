import { useCallback, useEffect, useRef, useState } from "react";
import { api, currentSessionGuard, errorMessage } from "../api";
import { Amount, Badge } from "../components";
import { formatDate } from "../format";
import type { TransferCandidate, TransferLink, TransferRecord } from "../types";

function TransferSide({ record, direction }: { record: TransferRecord; direction: string }) {
  return <div className="transfer-side"><span>{direction} · {record.account_name}</span>{record.read_environment === "sandbox" && <Badge tone="dim">Sandbox • test accounts</Badge>}<strong>{record.title}</strong><Amount minor={record.amount_minor} decimals={record.decimals} currency={record.currency} signed /><small>{formatDate(record.date)}</small></div>;
}

export function TransferPair({ candidate }: { candidate: TransferCandidate | TransferLink }) {
  return <div className="transfer-pair"><TransferSide record={candidate.outgoing} direction="Money out" /><span className="transfer-arrow" aria-hidden="true">→</span><TransferSide record={candidate.incoming} direction="Money in" /></div>;
}

export function TransferReview({ onChanged }: { onChanged(): void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.transferReview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const live = useRef(true);
  const pending = useRef(false);
  const load = useCallback(async () => {
    try { const result = await api.transferReview(); if (live.current) { setData(result); setError(null); } }
    catch (reason) { if (live.current) setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [load]);

  async function act(candidate: TransferCandidate | TransferLink) {
    if (pending.current || !data?.can_manage || !confirmed) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const current = currentSessionGuard();
    try {
      const unlink = "id" in candidate;
      if (unlink) await api.unlinkTransfer(candidate.id);
      else await api.linkTransfer(candidate.outgoing.id, candidate.incoming.id);
      if (!live.current || !current()) return;
      setSelected(null); setConfirmed(false);
      setNotice(unlink ? "Transfer link removed. Both original entries remain." : "Entries linked as an internal transfer. No money moved.");
      onChanged(); await load();
    } catch (reason) { if (live.current && current()) setError(errorMessage(reason)); }
    finally { pending.current = false; if (live.current && current()) setBusy(false); }
  }

  const select = (id: string) => { setSelected(id); setConfirmed(false); };
  return <section className="transfer-review" aria-label="Review internal transfers">
    <h3>Transfers between your accounts</h3>
    <p className="journey-note">These suggestions match equal amounts without fee or currency differences. Link only entries that describe the same movement between accounts you own. Linking keeps both records and does not send money.</p>
    {error && <div className="notice notice-error" role="alert">{error} <button className="link-btn" onClick={() => void load()}>Retry transfer review</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!data && !error && <p className="journey-note">Looking for matching entries…</p>}
    {data && <>
      <h4>Suggested matches · {data.candidates.length}</h4>
      {data.candidates.length === 0 && <p className="journey-note">No matching outgoing and incoming records to review.</p>}
      {data.candidates.map((candidate) => {
        const id = `${candidate.outgoing.id}:${candidate.incoming.id}`;
        return <article className="card transfer-card" key={id}><Badge tone="dim">Suggested · {candidate.day_gap} day{candidate.day_gap === 1 ? "" : "s"} apart</Badge><TransferPair candidate={candidate} />
          {data.can_manage && (selected === id ? <div className="connection-review"><label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Both accounts belong to me, and these entries are the same transfer.</label><div className="btn-row"><button className="btn btn-primary" disabled={busy || !confirmed} onClick={() => void act(candidate)}>Confirm transfer link</button><button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(null)}>Cancel</button></div></div> : <button className="btn btn-ghost" disabled={busy} onClick={() => select(id)}>Review match</button>)}
        </article>;
      })}
      <h4>Linked transfers · {data.links.length}</h4>
      {data.links.map((link) => <article className="card transfer-card" key={link.id}><Badge tone="gold">Confirmed by owner</Badge><TransferPair candidate={link} />
        {data.can_manage && (selected === link.id ? <div className="connection-review"><label className="check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Remove this transfer label. Keep both activity entries.</label><div className="btn-row"><button className="btn btn-primary" disabled={busy || !confirmed} onClick={() => void act(link)}>Confirm unlink</button><button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(null)}>Keep link</button></div></div> : <button className="btn btn-ghost" disabled={busy} onClick={() => select(link.id)}>Review unlink</button>)}
      </article>)}
    </>}
  </section>;
}
