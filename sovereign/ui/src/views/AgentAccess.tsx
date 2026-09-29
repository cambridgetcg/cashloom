import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, currentSessionGuard, errorMessage } from "../api";
import { Amount, Badge, EmptyState, Field, LoadingThreads, SectionTitle } from "../components";
import { formatDate } from "../format";
import type { WalletNavigate } from "../navigation";
import type { Account, AssistAccess as Access, AssistAccessCreated, AssistAccessInput, AssistProposal, AssistProposalList } from "../types";
import "./agent-access.css";

const SETUP_GUIDE = "https://github.com/cambridgetcg/cashloom/blob/release/service-workspace-20260929/docs/agent-layer-2026-09-29.md";
const timeText = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable";
};
export const canApplySuggestion = (proposal: AssistProposal) => proposal.status === "pending" && proposal.review_state === "current";

export function AccessForm({ accounts, busy, onCreate }: { accounts: Account[]; busy: boolean; onCreate(input: AssistAccessInput): void }) {
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [propose, setPropose] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const active = accounts.filter(account => account.status === "ACTIVE");
  const valid = label.trim().length > 0 && selected.length > 0 && selected.length <= 20 && selected.every(id => active.some(account => account.id === id));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    onCreate({ label: label.trim(), account_ids: selected, allow_proposals: propose, ttl_minutes: minutes });
  }
  return <form className="card assist-create" onSubmit={submit} autoComplete="off" aria-label="Create agent access">
    <h3>Choose what to share</h3>
    <p className="journey-note">Access lets a client read the selected accounts’ names, currencies, saved balances and observation dates, plus latest activity including titles and categories. Selected Base wallets also share saved finalized ETH and native USDC holdings when evidence is available, with block dates and the last check outcome. These are dated observations; watching a wallet does not establish ownership or spending authority. It cannot refresh providers, change balances, manage keys or send money.</p>
    <fieldset disabled={busy}>
      <legend>Access settings</legend>
      <div className="field-row"><Field label="Access label" hint="Your label for this permission, not a verified agent identity."><input value={label} maxLength={80} required onChange={event => setLabel(event.target.value)} placeholder="e.g. My local money assistant" /></Field>
        <Field label="Requested duration" hint="Actual expiry may be earlier because access cannot outlast the issuing owner session."><select value={minutes} onChange={event => setMinutes(Number(event.target.value))}>{[5, 15, 30, 60].map(value => <option key={value} value={value}>{value} minutes</option>)}</select></Field></div>
      <fieldset className="assist-account-choices"><legend>Accounts to share · {selected.length} of 20 selected</legend>
        {active.length === 0 && <p>Add an active account in Accounts before creating access.</p>}
        {active.map(account => <label className="assist-check" key={account.id}><input type="checkbox" checked={selected.includes(account.id)} disabled={busy || (selected.length >= 20 && !selected.includes(account.id))} onChange={event => setSelected(current => event.target.checked ? [...current, account.id] : current.filter(id => id !== account.id))} /><span><strong>{account.display_name}</strong><small>{account.currency}{account.read_environment === "sandbox" ? " · Sandbox • test accounts" : ""}</small></span></label>)}
      </fieldset>
      <label className="assist-check assist-proposal-toggle"><input type="checkbox" checked={propose} onChange={event => setPropose(event.target.checked)} /><span><strong>Allow category suggestions</strong><small>The client can propose a category for an existing activity entry. Only the workspace owner can apply it.</small></span></label>
    </fieldset>
    <p className="journey-note">A client or model provider may retain records it reads. Expiry, revocation, restarting the node or locking the vault ends future access; it cannot retrieve copies already shared.</p>
    <button className="btn btn-primary" type="submit" disabled={busy || !valid}>Create access</button>
  </form>;
}

export function SuggestionCard({ proposal, account, busy, onAccept, onReject, onGoto }: {
  proposal: AssistProposal; account?: Account; busy: boolean;
  onAccept(): void; onReject(): void; onGoto?: WalletNavigate;
}) {
  const pending = proposal.status === "pending";
  const status = proposal.status === "accepted" ? "Category applied" : proposal.status === "rejected" ? "Rejected" : proposal.status === "stale" ? "Stale · not applied" : "Needs your review";
  return <article className="card assist-suggestion" aria-label={`Category suggestion for ${proposal.before.title}`}>
    <div className="assist-card-head"><div><p className="assist-attribution">Access label: <strong>{proposal.access_label}</strong></p><h4>{proposal.before.title}</h4></div><Badge tone={pending ? "gold" : "dim"}>{status}</Badge></div>
    <p className="assist-meta">{account?.display_name ?? "Account unavailable"} · {proposal.before.source === "CSV" ? proposal.before.date.slice(0, 10) : formatDate(proposal.before.date)} · {proposal.before.currency}{account?.read_environment === "sandbox" && <> · <Badge tone="dim">Sandbox • test accounts</Badge></>}</p>
    <Amount minor={proposal.before.amount_minor} decimals={proposal.before.decimals} currency={proposal.before.currency} signed />
    <dl className="assist-category-change"><div><dt>Category when proposed</dt><dd>{proposal.before.category || "Uncategorised"}</dd></div><div><dt>Suggested category</dt><dd>{proposal.category}</dd></div></dl>
    <div className="assist-reason"><strong>Submitted reason</strong><p>{proposal.reason}</p></div>
    <p className="assist-meta">Submitted {timeText(proposal.created_at)}. The access label does not verify who or what produced this suggestion.</p>
    {pending && proposal.review_state !== "current" && <p className="notice" role="status">{proposal.review_state === "changed" ? "The activity changed after this suggestion was made. Applying it is blocked; review the current entry and request a new suggestion." : "The activity is unavailable. Applying this suggestion is blocked."}</p>}
    {pending ? <><p className="journey-note">Applying changes only this entry’s category. It does not change a balance or move money. Suggestions remain for review after access ends.</p><div className="btn-row"><button className="btn btn-primary" disabled={busy || !canApplySuggestion(proposal)} onClick={onAccept}>Apply category</button><button className="btn btn-ghost" disabled={busy} onClick={onReject}>Reject suggestion</button>{onGoto && account && <button className="link-btn" disabled={busy} onClick={() => onGoto("ledger", { accountId: proposal.account_id })}>View account activity</button>}</div></> : <p className="assist-meta">{proposal.decided_at ? `Recorded ${timeText(proposal.decided_at)}.` : "No category change was applied."} {proposal.status === "accepted" && "The owner applied this category; no money moved."}</p>}
  </article>;
}

export function AgentAccess({ visible = true, onGoto }: { visible?: boolean; onGoto?: WalletNavigate } = {}) {
  const [access, setAccess] = useState<Access[] | null>(null);
  const [proposals, setProposals] = useState<AssistProposalList | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credential, setCredential] = useState<AssistAccessCreated | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const live = useRef(true), visibleNow = useRef(visible), pending = useRef(false), generation = useRef(0), credentialGeneration = useRef(0);
  visibleNow.current = visible;
  const forgetCredential = useCallback(() => { credentialGeneration.current++; setCredential(null); setRevealed(false); setCopyNotice(null); }, []);
  const activeView = useCallback(() => live.current && visibleNow.current && document.visibilityState !== "hidden", []);
  const load = useCallback(async () => {
    if (!activeView() || pending.current) return;
    const read = ++generation.current, session = currentSessionGuard();
    setReading(true);
    try {
      const grants = await api.assistAccess();
      if (!activeView() || !session() || read !== generation.current) return;
      const [suggestions, records] = await Promise.all([api.assistProposals(), api.accounts({ includeArchived: true })]);
      if (!activeView() || !session() || read !== generation.current) return;
      setAccess(grants.access); setProposals(suggestions); setAccounts(records.accounts); setError(null);
    } catch (reason) {
      if (activeView() && session() && read === generation.current) setError(reason instanceof ApiError && reason.status === 403 ? "Only the workspace owner can manage agent access and review suggestions with the required permissions." : errorMessage(reason));
    } finally { if (activeView() && session() && read === generation.current) setReading(false); }
  }, [activeView]);
  useEffect(() => {
    live.current = true;
    const visibility = () => { if (document.visibilityState === "hidden") forgetCredential(); else { setNow(Date.now()); void load(); } };
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => { if (activeView()) setNow(Date.now()); }, 1000);
    return () => { live.current = false; generation.current++; credentialGeneration.current++; document.removeEventListener("visibilitychange", visibility); window.clearInterval(timer); };
  }, [load, forgetCredential, activeView]);
  useEffect(() => { if (!visible) forgetCredential(); else void load(); }, [visible, forgetCredential, load]);
  useEffect(() => { if (credential && Date.parse(credential.access.expires_at) <= now) forgetCredential(); }, [credential, now, forgetCredential]);

  const ready = access !== null && proposals !== null && !error && !reading;
  async function create(input: AssistAccessInput) {
    const session = currentSessionGuard();
    if (!activeView() || !session() || pending.current || !ready) return;
    forgetCredential(); const credentialRevision = credentialGeneration.current;
    pending.current = true; setBusy("create"); setError(null); setNotice(null);
    try {
      const result = await api.createAssistAccess(input);
      if (!activeView() || !session()) return;
      setAccess(current => [result.access, ...(current ?? []).filter(item => item.id !== result.access.id)]);
      if (credentialGeneration.current === credentialRevision) { setCredential(result); setRevealed(false); }
      setNotice("Access issued. This grants permission; it does not connect or start an agent.");
    } catch (reason) {
      if (activeView() && session()) setError(`${errorMessage(reason)} Reload access before creating another grant; the first request may have reached the node.`);
    } finally { pending.current = false; if (live.current && session()) setBusy(null); }
  }
  async function revoke(grant: Access) {
    const session = currentSessionGuard();
    if (!activeView() || !session() || pending.current || !ready) return;
    if (credential?.access.id === grant.id) forgetCredential();
    pending.current = true; setBusy(grant.id); setError(null); setNotice(null);
    try {
      await api.revokeAssistAccess(grant.id);
      if (!activeView() || !session()) return;
      setAccess(current => current?.filter(item => item.id !== grant.id) ?? []);
      setNotice("Access revoked. Future requests are blocked. Existing suggestions remain for owner review.");
    } catch (reason) { if (activeView() && session()) setError(`${errorMessage(reason)} Reload access to check whether revocation completed.`); }
    finally { pending.current = false; if (live.current && session()) setBusy(null); }
  }
  async function decide(proposal: AssistProposal, accept: boolean) {
    const session = currentSessionGuard();
    if (!activeView() || !session() || pending.current || !ready || proposal.status !== "pending" || (accept && !canApplySuggestion(proposal))) return;
    pending.current = true; setBusy(proposal.id); setError(null); setNotice(null);
    try {
      const result = accept ? await api.acceptAssistProposal(proposal.id, proposal.before.record_version) : await api.rejectAssistProposal(proposal.id);
      if (!activeView() || !session()) return;
      setProposals(current => current ? { ...current, proposals: current.proposals.map(item => item.id === result.proposal.id ? result.proposal : result.proposal.status === "accepted" && item.transaction_id === result.proposal.transaction_id && item.status === "pending" ? { ...item, review_state: "changed" } : item) } : current);
      setNotice(result.proposal.status === "accepted" ? "Category applied. Balances are unchanged and no money moved." : result.proposal.status === "rejected" ? "Suggestion rejected. The activity entry is unchanged." : "The activity changed. No category was applied; reload suggestions to review the latest state.");
    } catch (reason) {
      if (activeView() && session()) setError(reason instanceof ApiError && reason.status === 409 ? "The suggestion or activity changed. Reload suggestions before another decision." : `${errorMessage(reason)} Reload suggestions to check the recorded outcome before trying again.`);
    } finally { pending.current = false; if (live.current && session()) setBusy(null); }
  }
  async function copyCredential() {
    const session = currentSessionGuard(), revision = credentialGeneration.current;
    if (!credential || !revealed || !activeView() || !session() || Date.parse(credential.access.expires_at) <= Date.now()) return;
    try { await navigator.clipboard.writeText(credential.token); if (activeView() && session() && revision === credentialGeneration.current) setCopyNotice("Credential copied. Your clipboard may retain it after you hide this screen."); }
    catch { if (activeView() && session() && revision === credentialGeneration.current) setCopyNotice("Clipboard access failed. You can select and copy the revealed credential yourself."); }
  }
  const blocked = !ready || busy !== null;
  return <div className="stagger assist-view">
    <SectionTitle aside={<button className="link-btn" disabled={reading || busy !== null} onClick={() => void load()}>Reload access and suggestions</button>}>Agent access</SectionTitle>
    <p className="journey-note">Choose which saved records an external client may read, and review its category suggestions yourself. CashLoom does not start a model or verify the identity behind your access label.</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {reading && access === null && <LoadingThreads label="Reading agent access from your node…" />}
    {credential && <section className="card assist-credential" aria-label="New access credential"><h3>Keep this credential private</h3><p>Issued for <strong>{credential.access.label}</strong>. Expires {timeText(credential.access.expires_at)}. Supply it only to the client you chose, using the setup guide’s process environment instructions.</p><p>The credential is available here only now. Hiding this section, leaving the view, hiding the tab or locking clears it from this screen. This does not revoke access.</p>
      {revealed ? <Field label="One-time access credential"><textarea value={credential.token} readOnly autoComplete="off" spellCheck={false} rows={3} /></Field> : <p className="assist-secret-hidden">Credential hidden until you choose to reveal it.</p>}
      <div className="btn-row">{!revealed && <button className="btn btn-primary" onClick={() => { if (activeView() && currentSessionGuard()()) setRevealed(true); }}>Reveal credential</button>}<button className="btn btn-ghost" disabled={!revealed} onClick={() => void copyCredential()}>Copy credential</button><button className="btn btn-ghost" onClick={forgetCredential}>Hide and forget credential</button></div>{copyNotice && <p role="status">{copyNotice}</p>}
    </section>}
    <section aria-labelledby="assist-access-title"><div className="assist-section-head"><h3 id="assist-access-title">Access</h3><p>Issued permissions, not connected-model status.</p></div>
      {access !== null && <AccessForm accounts={accounts} busy={blocked || access.filter(grant => Date.parse(grant.expires_at) > now).length >= 20} onCreate={input => void create(input)} />}
      {access !== null && access.filter(grant => Date.parse(grant.expires_at) > now).length >= 20 && <p className="notice">The node allows up to 20 active grants. Revoke an existing grant before creating another.</p>}
      {access?.length === 0 && <EmptyState>No active access has been issued. Choose accounts above when you are ready to share records with a client.</EmptyState>}
      <div className="assist-access-list">{access?.map(grant => <article className="card" key={grant.id} aria-label={grant.label}><div className="assist-card-head"><h4>{grant.label}</h4><Badge tone="dim">{Date.parse(grant.expires_at) <= now ? "Expired" : "Access issued"}</Badge></div><p>{grant.permissions.includes("propose_categories") ? "Read selected records and propose categories" : "Read selected records only"}</p><ul>{grant.account_ids.map(id => <li key={id}>{accounts.find(account => account.id === id)?.display_name ?? "Account unavailable"}{accounts.find(account => account.id === id)?.read_environment === "sandbox" ? " · Sandbox • test accounts" : ""}</li>)}</ul><p className="assist-meta">Issued {timeText(grant.created_at)} · expires {timeText(grant.expires_at)}</p><button className="btn btn-ghost" disabled={blocked || Date.parse(grant.expires_at) <= now} onClick={() => void revoke(grant)}>Revoke access</button></article>)}</div>
      <p className="assist-setup"><a href={SETUP_GUIDE} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Local client / MCP setup guide ↗</a><span>Private repository access required. Follow the guide to run a client; creating access alone does not install or connect one. Keep credentials out of chat, URLs and saved configuration files.</span></p>
    </section>
    <section aria-labelledby="assist-suggestions-title"><div className="assist-section-head"><h3 id="assist-suggestions-title">Suggestions</h3><p>Review proposed category changes and their recorded outcomes.</p></div>
      {proposals?.proposals.length === 0 && <EmptyState>No category suggestions yet. Access must include category suggestions for a client to submit one.</EmptyState>}
      <div className="assist-suggestions">{proposals?.proposals.map(proposal => <SuggestionCard key={proposal.id} proposal={proposal} account={accounts.find(account => account.id === proposal.account_id)} busy={blocked} onAccept={() => void decide(proposal, true)} onReject={() => void decide(proposal, false)} onGoto={onGoto} />)}</div>
      {proposals?.has_more && <p className="notice">Showing up to 100 suggestions, pending first. Review these and reload to reach more pending suggestions; older decisions may not be shown.</p>}
    </section>
  </div>;
}
