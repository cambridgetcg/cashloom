import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../api";
import { Field, LoadingThreads, SectionTitle } from "../components";
import type { WalletNavigate } from "../navigation";
import type { AgreementRevision, AgreementTerms, EvidenceInput, SimulationCommand, SimulationRun, TradeEventPage, TradeRecord } from "../types";
import { appendTradePage, createTradeAttempt, RECORD_NOTICE, SIMULATION_NOTICE, staleAcceptances, tradeAssetLabel, tradeDecimal, tradeReferences, tradeTimestamp } from "../trades";
import { TradeTermsEditor } from "./TradeTermsEditor";
import "./trades.css";

export function TradeNotice({ simulation = false }: { simulation?: boolean }) {
  return <p className={`trade-notice${simulation ? " is-simulation" : ""}`} role="note"><strong>{simulation ? SIMULATION_NOTICE : RECORD_NOTICE}</strong></p>;
}

export function TradeTerms({ revision }: { revision: Pick<AgreementRevision, "terms" | "totals" | "revision" | "hash"> }) {
  const { terms, totals } = revision;
  const amount = (atomic: string) => tradeDecimal(atomic, terms.quoteDecimals);
  return <section className="trade-terms" aria-label={`Agreement revision ${revision.revision}`}>
    <h3>{terms.title}</h3>
    <p>Revision {revision.revision} · <code>{revision.hash}</code></p>
    <p className="trade-muted">The hash binds terms, not identity, authenticity or consent.</p>
    <dl className="trade-details">
      <dt>Origin channel</dt><dd>{terms.originChannel}</dd>
      <dt>Reported buyer / seller</dt><dd>{terms.buyerLabel} / {terms.sellerLabel} · local owner is {terms.ownerRole}</dd>
      <dt>Quote asset</dt><dd>{terms.quoteAsset.kind} · <code>{tradeAssetLabel(terms.quoteAsset)}</code> · {terms.quoteDecimals} decimals (registry scale)</dd>
      <dt>Planned payment method</dt><dd>{terms.plannedPaymentMethod.replaceAll("_", " ")} — not a payment confirmation</dd>
      <dt>Proposal expiry</dt><dd><time dateTime={terms.expiresAt}>{terms.expiresAt}</time></dd>
    </dl>
    <ol className="trade-items">
      {terms.items.map((item) => <li key={item.id}>
        <h4>{item.cardName} · {item.game}</h4>
        <p>{item.representation.replaceAll("_", " ")} · quantity {item.quantity} · local ID <code>{item.id}</code></p>
        <p>Set {item.set} · collector {item.collectorNumber} · language {item.language} · variant {item.variant}</p>
        <p>Condition ({item.condition.standard}): {item.condition.description}</p>
        <p>Unit price {amount(item.unitPrice.atomic)} · line total {amount((BigInt(item.unitPrice.atomic) * BigInt(item.quantity)).toString())}</p>
        {item.grading && <p>Grading claim: {item.grading.company} · {item.grading.grade}{item.grading.certificate ? ` · certificate ${item.grading.certificate}` : ""}. Not authentication.</p>}
        {item.catalog?.map((entry, i) => <p key={`catalog-${i}`}>Catalog claim: {entry.source} · opaque ID <code>{entry.identifier}</code> · provenance {entry.provenance.source} · rights {entry.provenance.rights}{entry.provenance.observedAt ? ` · observed ${entry.provenance.observedAt}` : " · observation time unknown"}</p>)}
        {item.metadata?.map((entry, i) => <p key={`metadata-${i}`}>Metadata claim: {entry.key} = {entry.value} · provenance {entry.provenance.source} · rights {entry.provenance.rights}{entry.provenance.observedAt ? ` · observed ${entry.provenance.observedAt}` : " · observation time unknown"}</p>)}
      </li>)}
    </ol>
    <dl className="trade-details">
      <dt>Items</dt><dd>{amount(totals.items.atomic)}</dd>
      <dt>Shipping</dt><dd>{amount(terms.shipping.amount.atomic)} · paid by {terms.shipping.payer}. {terms.shipping.responsibility}</dd>
      <dt>Disclosed charges</dt><dd>{terms.charges.length ? <ul>{terms.charges.map((charge, i) => <li key={i}>{charge.label}: {amount(charge.amount.atomic)} · paid by {charge.payer}</li>)}</ul> : "None"}</dd>
      <dt>Seller-paid costs</dt><dd>{amount(totals.sellerCosts.atomic)} · outside buyer total</dd>
      <dt>Cashloom fee</dt><dd>{amount(totals.cashloomFee.atomic)}</dd>
      <dt>Exact buyer total</dt><dd><strong>{amount(totals.total.atomic)} {tradeAssetLabel(terms.quoteAsset)}</strong><br /><code>{totals.total.atomic} atomic</code></dd>
      <dt>Inspection window</dt><dd>{terms.inspectionWindowHours} hours; no automatic release deadline</dd>
      <dt>Dispute terms</dt><dd>{terms.disputeTerms}</dd>
      <dt>Return terms</dt><dd>{terms.returnTerms}</dd>
    </dl>
    {!!terms.referenceValuations?.length && <details><summary>Reference valuations — outside totals and wallet balances</summary><ul>{terms.referenceValuations.map((value, i) => <li key={i}>{value.amount.atomic} atomic · {tradeAssetLabel(value.amount.asset)} · source {value.source} · observed <time dateTime={value.observedAt}>{value.observedAt}</time> · rights {value.rights}</li>)}</ul></details>}
  </section>;
}

export function TradeRecordPanel({ trade, revisionNumber, onRevision }: { trade: TradeRecord; revisionNumber: number; onRevision: (revision: number) => void }) {
  const revision = trade.revisions.find((r) => r.revision === revisionNumber) ?? trade.current;
  const stale = staleAcceptances(trade);
  return <section className="card" aria-label="Saved owner record">
    <TradeNotice />
    <p>Record version {trade.version} · <code>{trade.id}</code></p>
    {stale.length > 0 && <p role="status" className="trade-warning">Stale acceptance: {stale.length} owner-reported acceptance record(s) refer to earlier revisions. They do not carry forward to revision {trade.currentRevision}.</p>}
    <Field label="Agreement revision"><select value={revision.revision} onChange={(e) => onRevision(Number(e.target.value))}>{trade.revisions.map((r) => <option key={r.revision} value={r.revision}>Revision {r.revision}{r.revision === trade.currentRevision ? " — current" : " — historical"}</option>)}</select></Field>
    {revision.revision !== trade.currentRevision && <p className="trade-warning">Historical terms. Evidence and any new simulation attach to this selected revision, not the current one.</p>}
    <TradeTerms revision={revision} />
    <h3>Owner-reported evidence</h3>
    <p>Reports are not independently verified consent, payment, delivery or settlement. Corrections append; historical evidence is never moved to new terms. References below are inert text, never fetched.</p>
    {trade.evidence.length === 0 ? <p>No evidence recorded.</p> : <ol className="trade-evidence">{trade.evidence.map((e) => <li key={e.id}>
      <p><strong>{e.kind}</strong> · owner-reported · revision {e.revision}{e.revision !== trade.currentRevision ? " — earlier revision" : " — current revision"}</p>
      <p className="trade-plain">{e.text}</p>
      <p>Reported occurrence: {e.occurredAt ? <time dateTime={e.occurredAt}>{e.occurredAt}</time> : "not supplied"}<br />Recorded by node: <time dateTime={e.recordedAt}>{e.recordedAt}</time></p>
      <p><code>{e.id}</code>{e.correctsEvidenceId && <> · corrects <code>{e.correctsEvidenceId}</code></>}</p>
      <p className="trade-muted">Bound hash <code>{e.agreementHash}</code></p>
      {!!e.references?.length && <ul>{e.references.map((ref, i) => <li key={i}><code>{ref}</code></li>)}</ul>}
    </li>)}</ol>}
  </section>;
}

function EvidenceEditor({ trade, revision, disabled, onSave }: { trade: TradeRecord; revision: number; disabled: boolean; onSave: (input: EvidenceInput) => void }) {
  const [kind, setKind] = useState<EvidenceInput["kind"]>("note");
  const [text, setText] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [references, setReferences] = useState("");
  const [correctsEvidenceId, setCorrects] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (disabled) return;
    try {
      const evidence: EvidenceInput = { kind, text: text.trim(), references: tradeReferences(references), ...(occurredAt ? { occurredAt: tradeTimestamp(occurredAt) } : {}), ...(kind === "correction" ? { correctsEvidenceId } : {}) };
      if (!evidence.text) throw new Error("Describe what you are reporting.");
      if (kind === "correction" && !correctsEvidenceId) throw new Error("Choose the original evidence to correct.");
      setError(null); onSave(evidence);
    } catch (e) { setError(errorMessage(e)); }
  }
  return <form className="card" onSubmit={submit} autoComplete="off" aria-label="Record owner-reported evidence">
    <h3>Add owner-reported evidence · revision {revision}</h3>
    <fieldset disabled={disabled}>
      <legend>Reported evidence</legend>
      <Field label="Evidence kind"><select value={kind} onChange={(e) => setKind(e.target.value as EvidenceInput["kind"])}>{(["note", "acceptance", "payment", "dispatch", "delivery", "inspection", "dispute", "return", "correction"] as const).map((value) => <option key={value} value={value}>{value} — owner-reported</option>)}</select></Field>
      {kind === "correction" && <Field label="Original evidence to correct"><select required value={correctsEvidenceId} onChange={(e) => setCorrects(e.target.value)}><option value="">Choose original evidence from this revision</option>{trade.evidence.filter((e) => e.revision === revision).map((e) => <option key={e.id} value={e.id}>{e.kind} · {e.id}</option>)}</select></Field>}
      <Field label="Evidence text" hint="Plain text only. Avoid unnecessary personal data; no uploads or HTML."><textarea required maxLength={4000} rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Reported occurrence (ISO time, optional)"><input maxLength={40} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} placeholder="2026-09-14T12:00:00.000Z" /></Field>
      <Field label="Source references (optional)" hint="One HTTP(S) URL per line, at most 10. No credentials. Stored as text, not opened or fetched."><textarea rows={2} maxLength={20490} value={references} onChange={(e) => setReferences(e.target.value)} /></Field>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="btn btn-primary" type="submit">Record evidence</button>
    </fieldset>
  </form>;
}

export function TradeSimulationPanel({ simulation, disabled, onCommand }: { simulation: SimulationRun; disabled: boolean; onCommand: (command: SimulationCommand, label: string) => void }) {
  const { state, snapshot } = simulation;
  return <section className="card trade-simulation" aria-label="Escrow simulation">
    <TradeNotice simulation />
    <h3>{snapshot.terms.title} — escrow rehearsal</h3>
    <p>One local owner is playing every simulated role (buyer, seller, adjudicator and system). These controls are not independent identities, credentials or authority.</p>
    <p>Run <code>{simulation.id}</code> · version {simulation.version} · source revision {snapshot.revision} · <code>{snapshot.hash}</code></p>
    {simulation.staleRevision && <p className="trade-warning" role="status">Source-revision mismatch: this run remains bound to revision {snapshot.revision}; the source is now revision {simulation.sourceCurrentRevision ?? "unknown"}. Nothing has been rebound or reaccepted.</p>}
    {simulation.sourceCurrentRevision === null && <p className="trade-warning">The current source revision could not be established. The simulation retains its original snapshot.</p>}
    <dl className="trade-details">
      <dt>Simulated agreement</dt><dd>Buyer {state.agreement.buyerAccepted ? "accepted" : "not accepted"}; seller {state.agreement.sellerAccepted ? "accepted" : "not accepted"}</dd>
      <dt>Simulated funding</dt><dd>{state.funding}</dd>
      <dt>Simulated fulfilment</dt><dd>{state.fulfilment.replaceAll("_", " ")}</dd>
      <dt>Simulated inspection</dt><dd>{state.inspection.replaceAll("_", " ")}</dd>
      <dt>Simulated dispute</dt><dd>{state.dispute.replaceAll("_", " ")}</dd>
      <dt>Simulated return</dt><dd>{state.return}</dd>
      <dt>Simulated settlement</dt><dd>{state.settlement.replaceAll("_", " ")}</dd>
      <dt>Simulated cancellation</dt><dd>{state.cancellation.replaceAll("_", " ")}</dd>
    </dl>
    {state.dispute !== "none" && !["released", "refunded"].includes(state.settlement) && <p className="trade-warning">Dispute hold: ordinary release is blocked. A simulated resolution is required; return authorization, dispatch, receipt and refund completion are separate steps.</p>}
    {state.fulfilment === "dispatched" && <p className="trade-warning">Dispatch is not delivery, inspection acceptance or permission to release. Tracking and elapsed time do not release funds.</p>}
    {state.operation && <div className="trade-operation" role="status">
      <h4>Simulated {state.operation.kind} operation — {state.operation.status}</h4>
      <p>Stable operation ID <code>{state.operation.id}</code></p>
      {state.operation.status === "pending" && <p>Pending is not completed. Explicitly simulate completion, failure or a lost response below.</p>}
      {state.operation.status === "unknown" && <p>Unknown outcome — do not start another operation. Reconcile this same operation ID using the permitted action below. This is simulator uncertainty, never real money.</p>}
    </div>}
    <h4>Simulated balances only</h4>
    <p><code>{tradeAssetLabel(snapshot.terms.quoteAsset)}</code> · {snapshot.terms.quoteDecimals} decimals. Never included in wallet balances.</p>
    <dl className="trade-details">{(["funded", "held", "released", "refunded", "fee"] as const).map((name) => <div className="trade-detail-pair" key={name}><dt>Simulated {name}</dt><dd>{tradeDecimal(state.balances[name].atomic, snapshot.terms.quoteDecimals)} <span className="trade-muted">({state.balances[name].atomic} atomic)</span></dd></div>)}</dl>
    <p>Conservation: funded = held + released + refunded. Zero Cashloom fee. Full release or full refund only.</p>
    <h4>Server-permitted next actions</h4>
    <div className="trade-actions" aria-busy={disabled}>{simulation.permittedActions.map((action) => <div key={JSON.stringify(action.command)}>
      <button className="btn btn-primary" type="button" disabled={disabled} onClick={() => onCommand(action.command, action.label)}>{action.label.startsWith("Simulate ") ? action.label : `Simulate ${action.label}`}</button>
      <span>Simulated role: {action.simulatedRole} · same local owner</span>
    </div>)}</div>
    {simulation.permittedActions.length === 0 && <p>No next actions permitted. This run is terminal or unavailable; refresh to check current server state.</p>}
    <details><summary>Frozen source agreement</summary><TradeTerms revision={snapshot} /></details>
    <TradeNotice simulation />
  </section>;
}

function History({ id, version, simulation = false }: { id: string; version: number; simulation?: boolean }) {
  const [page, setPage] = useState<TradeEventPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const read = (after: number) => simulation ? api.tradeSimulationHistory(id, after) : api.tradeHistory(id, after);
  useEffect(() => {
    const run = ++generation.current;
    setPage(null); setError(null); setBusy(true); inFlight.current = true;
    void read(0).then((value) => { if (generation.current === run) setPage(value); }, (e: unknown) => { if (generation.current === run) setError(errorMessage(e)); }).finally(() => { if (generation.current === run) { setBusy(false); inFlight.current = false; } });
    return () => { generation.current++; };
  }, [id, version, simulation]);
  async function more() {
    if (inFlight.current) return;
    const run = generation.current; inFlight.current = true; setBusy(true); setError(null);
    try {
      const next = await read(page?.nextCursor ?? 0);
      if (run === generation.current) setPage((old) => ({ events: [...(old?.events ?? []), ...next.events], nextCursor: next.nextCursor }));
    } catch (e) { if (run === generation.current) setError(errorMessage(e)); }
    finally { if (run === generation.current) { setBusy(false); inFlight.current = false; } }
  }
  return <section className="card" aria-label={simulation ? "Simulation history" : "Record history"}>
    <h3>{simulation ? "Simulation history" : "Record history"}</h3>
    <TradeNotice simulation={simulation} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {page && <ol className="trade-history">{page.events.map((event) => <li key={event.id}>
      <p>{event.type.replaceAll("_", " ")} · revision {event.revision} · recorded <time dateTime={event.recordedAt}>{event.recordedAt}</time></p>
      <p>Actor: local owner · {event.mode === "simulation" ? "simulation only" : "owner-reported record"}</p>
      <details><summary>Event details</summary><p><code>{event.agreementHash}</code></p><pre>{JSON.stringify(event.data, null, 2)}</pre></details>
    </li>)}</ol>}
    {busy && <p role="status">Loading history…</p>}
    {(page?.nextCursor != null || error) && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void more()}>{error ? "Retry history" : "Load more history"}</button>}
  </section>;
}

type Pending = { label: string; run: () => Promise<unknown>; complete: (value: unknown) => void };

export function Trades({ onGoto }: { onGoto?: WalletNavigate } = {}) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [simulations, setSimulations] = useState<SimulationRun[]>([]);
  const [tradeCursor, setTradeCursor] = useState<number | null>(null);
  const [simulationCursor, setSimulationCursor] = useState<number | null>(null);
  const [screen, setScreen] = useState<"list" | "record" | "simulation" | "new">("list");
  const [trade, setTrade] = useState<TradeRecord | null>(null);
  const [simulation, setSimulation] = useState<SimulationRun | null>(null);
  const [revision, setRevision] = useState(1);
  const [editing, setEditing] = useState<{ terms: AgreementTerms; version: number } | null>(null);
  const [evidenceGeneration, setEvidenceGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const [conflict, setConflict] = useState(false);
  const active = useRef(true);
  const busyNow = useRef(false);
  const loadGeneration = useRef(0);
  const pending = useRef<Pending | null>(null);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; ++loadGeneration.current; pending.current = null; };
  }, []);

  function savedTrade(value: TradeRecord) {
    setTrade(value); setTrades((old) => [value, ...old.filter((x) => x.id !== value.id)]);
  }
  function savedSimulation(value: SimulationRun) {
    setSimulation(value); setSimulations((old) => [value, ...old.filter((x) => x.id !== value.id)]);
  }

  async function refresh(target = screen) {
    if (busyNow.current) return;
    const generation = ++loadGeneration.current;
    setLoading(true); setError(null);
    try {
      if (target === "record" && trade) {
        const value = await api.trade(trade.id);
        if (!active.current || loadGeneration.current !== generation) return;
        savedTrade(value.trade);
      } else if (target === "simulation" && simulation) {
        const value = await api.tradeSimulation(simulation.id);
        if (!active.current || loadGeneration.current !== generation) return;
        savedSimulation(value.simulation);
      } else {
        const [records, runs] = await Promise.all([api.trades(), api.tradeSimulations()]);
        if (!active.current || loadGeneration.current !== generation) return;
        setTrades(records.trades); setSimulations(runs.simulations);
        setTradeCursor(records.nextCursor ?? null); setSimulationCursor(runs.nextCursor ?? null);
      }
      setConflict(false);
    } catch (e) { if (active.current && loadGeneration.current === generation) setError(errorMessage(e)); }
    finally { if (active.current && loadGeneration.current === generation) setLoading(false); }
  }

  async function loadMore(kind: "record" | "simulation") {
    const cursor = kind === "record" ? tradeCursor : simulationCursor;
    if (cursor === null || loading || busyNow.current || pending.current) return;
    const generation = ++loadGeneration.current;
    setLoading(true); setError(null);
    try {
      if (kind === "record") {
        const page = await api.trades(cursor);
        if (!active.current || loadGeneration.current !== generation) return;
        setTrades((old) => appendTradePage(old, page.trades)); setTradeCursor(page.nextCursor);
      } else {
        const page = await api.tradeSimulations(cursor);
        if (!active.current || loadGeneration.current !== generation) return;
        setSimulations((old) => appendTradePage(old, page.simulations)); setSimulationCursor(page.nextCursor);
      }
    } catch (e) { if (active.current && loadGeneration.current === generation) setError(errorMessage(e)); }
    finally { if (active.current && loadGeneration.current === generation) setLoading(false); }
  }

  async function execute() {
    if (busyNow.current || !pending.current) return;
    busyNow.current = true; setBusy(true); setError(null); setNotice(null);
    const attempt = pending.current;
    try {
      const value = await attempt.run();
      if (!active.current) return;
      attempt.complete(value); pending.current = null; setRetry(false); setConflict(false);
      setNotice(`${attempt.label} saved by your node. ${screen === "simulation" || attempt.label === "Simulation created" ? SIMULATION_NOTICE : RECORD_NOTICE}`);
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && e.status && e.status >= 400 && e.status < 500) {
        pending.current = null; setRetry(false);
        setConflict(e.status === 409);
        setError(`${errorMessage(e)}${e.status === 409 ? " Reload latest before another change. Your draft has not been overwritten." : ""}`);
      } else {
        // Network failure, malformed success or 5xx may follow a committed write.
        // Freeze new writes and keep both payload and expectedVersion unchanged.
        setRetry(true);
        setError(`${errorMessage(e)} Outcome unknown. Retry the exact request below; do not create a replacement.`);
      }
    } finally { busyNow.current = false; if (active.current) setBusy(false); }
  }

  function mutate<B extends { expectedVersion: number }, T>(label: string, body: B, send: (body: B & { idempotencyKey: string }) => Promise<T>, complete: (value: T) => void) {
    if (pending.current || busyNow.current || loading || conflict) return;
    const attempt = createTradeAttempt(body, send);
    pending.current = { label, run: attempt.run, complete: (value) => complete(value as T) };
    void execute();
  }
  const blocked = busy || loading || retry || conflict;
  async function open(kind: "record" | "simulation", id: string) {
    if (busyNow.current || retry || loading) return;
    const generation = ++loadGeneration.current;
    setLoading(true); setError(null); setNotice(null); setEditing(null);
    try {
      if (kind === "record") {
        const { trade: value } = await api.trade(id);
        if (!active.current || loadGeneration.current !== generation) return;
        savedTrade(value); setRevision(value.currentRevision);
      } else {
        const { simulation: value } = await api.tradeSimulation(id);
        if (!active.current || loadGeneration.current !== generation) return;
        savedSimulation(value);
      }
      setScreen(kind); setConflict(false);
    } catch (e) { if (active.current && loadGeneration.current === generation) setError(errorMessage(e)); }
    finally { if (active.current && loadGeneration.current === generation) setLoading(false); }
  }

  return <div className="trades-view stagger">
    <SectionTitle>Agreements</SectionTitle>
    {screen === "list" && onGoto && <div className="journey-note">
      <p>Keep buyer and seller terms, costs and reported evidence together. The current agreement form supports shipped card and bundle sales. Your records do not send money or confirm another person’s consent.</p>
      <button className="link-btn" onClick={() => onGoto("ledger")}>Open account activity</button>
    </div>}
    <TradeNotice simulation={screen === "simulation"} />
    <div className="btn-row trade-toolbar">
      {screen !== "list" && <button className="btn btn-ghost" type="button" disabled={busy || retry || loading} onClick={() => { setScreen("list"); setEditing(null); setNotice(null); setError(null); setConflict(false); void refresh("list"); }}>All agreements and simulations</button>}
      <button className="btn btn-ghost" type="button" disabled={busy || loading} onClick={() => void refresh()}>Reload latest</button>
      {screen === "list" && <button className="btn btn-primary" type="button" disabled={blocked} onClick={() => { setScreen("new"); setError(null); setNotice(null); }}>New agreement</button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p role="status" className="trade-warning">{notice}</p>}
    {retry && <div className="trade-warning" role="status"><p>The exact payload, version and retry key are retained in this view only. Leaving or locking clears this memory; after reopening, inspect saved records/runs before starting another request. No evidence is stored in browser storage.</p><button className="btn btn-primary" type="button" disabled={busy} onClick={() => void execute()}>Retry exact request</button></div>}
    {(busy || loading) && <LoadingThreads label={busy ? "Saving to your local node…" : "Loading saved trades…"} />}
    {screen === "list" && <>
      <section aria-label="Saved agreements"><h3>Your saved agreements</h3><p>Local records of shipped card and bundle sales. These records are separate from payments.</p>
        {!loading && trades.length === 0 && <p>No agreements yet. Create an agreement to record terms and evidence.</p>}
        <ul className="trade-list">{trades.map((record) => <li className="card" key={record.id}>
          <TradeNotice /><h4>{record.current.terms.title}</h4><p>{record.current.terms.buyerLabel} / {record.current.terms.sellerLabel} · revision {record.currentRevision}</p>
          <p>{tradeDecimal(record.current.totals.total.atomic, record.current.terms.quoteDecimals)} <code>{tradeAssetLabel(record.current.terms.quoteAsset)}</code></p>
          {staleAcceptances(record).length > 0 && <p className="trade-warning">Earlier acceptance is stale for current terms.</p>}
          <button className="btn btn-ghost" type="button" disabled={busy || retry || loading} onClick={() => void open("record", record.id)}>Open agreement: {record.current.terms.title}</button>
        </li>)}</ul>
        {tradeCursor !== null && <button className="btn btn-ghost" type="button" disabled={blocked} onClick={() => void loadMore("record")}>Load more agreements</button>}
      </section>
      <section aria-label="Saved simulations"><h3>Separate no-money simulations</h3><TradeNotice simulation />
        {!loading && simulations.length === 0 && <p>No simulations yet. Open a saved agreement and choose Try escrow simulation.</p>}
        <ul className="trade-list">{simulations.map((run) => <li className="card" key={run.id}>
          <TradeNotice simulation /><h4>{run.snapshot.terms.title}</h4><p>Source revision {run.snapshot.revision} · simulated settlement {run.state.settlement.replaceAll("_", " ")}</p>
          <p><code>{run.id}</code></p>{run.staleRevision && <p className="trade-warning">Source-revision mismatch; original snapshot retained.</p>}
          {run.state.operation?.status === "unknown" && <p className="trade-warning">Unknown operation outcome — reconciliation required.</p>}
          <button className="btn btn-ghost" type="button" disabled={busy || retry || loading} onClick={() => void open("simulation", run.id)}>Open simulation: {run.snapshot.terms.title}</button>
        </li>)}</ul>
        {simulationCursor !== null && <button className="btn btn-ghost" type="button" disabled={blocked} onClick={() => void loadMore("simulation")}>Load more simulations</button>}
      </section>
    </>}
    {screen === "new" && <TradeTermsEditor busy={blocked} stale={false} onCancel={() => setScreen("list")} onSave={(terms) => mutate("Trade", { expectedVersion: 0 as const, terms }, api.createTrade, (value) => { savedTrade(value.trade); setRevision(value.trade.currentRevision); setScreen("record"); })} />}
    {screen === "record" && trade && <>
      <TradeRecordPanel trade={trade} revisionNumber={revision} onRevision={(value) => { if (!blocked) setRevision(value); }} />
      <div className="btn-row">
        <button className="btn btn-ghost" type="button" disabled={blocked || !!editing || revision !== trade.currentRevision} onClick={() => setEditing({ terms: trade.current.terms, version: trade.version })}>Edit current terms</button>
        <button className="btn btn-primary" type="button" disabled={blocked || !!editing} onClick={() => mutate("Simulation created", { expectedVersion: 0 as const, tradeId: trade.id, revision }, api.createTradeSimulation, (value) => { savedSimulation(value.simulation); setScreen("simulation"); })}>Try escrow simulation</button>
      </div>
      {editing ? <TradeTermsEditor initial={editing.terms} busy={busy || retry || loading} stale={conflict || trade.version !== editing.version} onCancel={() => setEditing(null)} onSave={(terms) => mutate("New revision", { expectedVersion: editing.version, terms }, (body) => api.reviseTrade(trade.id, body), (value) => { savedTrade(value.trade); setRevision(value.trade.currentRevision); setEditing(null); })} /> : <EvidenceEditor key={`${trade.id}:${revision}:${evidenceGeneration}`} trade={trade} revision={revision} disabled={blocked} onSave={(evidence) => mutate("Owner-reported evidence", { expectedVersion: trade.version, revision, evidence }, (body) => api.tradeEvidence(trade.id, body), (value) => { savedTrade(value.trade); setEvidenceGeneration((n) => n + 1); })} />}
      <History id={trade.id} version={trade.version} />
    </>}
    {screen === "simulation" && simulation && <>
      <TradeSimulationPanel simulation={simulation} disabled={blocked} onCommand={(command, label) => mutate(label, { expectedVersion: simulation.version, command }, (body) => api.tradeSimulationCommand(simulation.id, body), (value) => savedSimulation(value.simulation))} />
      <History id={simulation.id} version={simulation.version} simulation />
    </>}
  </div>;
}
