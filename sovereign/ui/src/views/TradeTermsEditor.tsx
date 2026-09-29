import { useState, type ChangeEvent, type FormEvent } from "react";
import { Field } from "../components";
import { errorMessage } from "../api";
import type { AgreementTerms } from "../types";
import { draftTerms, previewTradeTotal, tradeAssetLabel, tradeDraft, newTradeItem, TRADE_QUOTE_ASSETS, type TradeDraft, type TradeItemDraft } from "../trades";

function Text({ label, value, onChange, max = 200, optional = false, multiline = false }: {
  label: string; value: string; onChange: (value: string) => void; max?: number; optional?: boolean; multiline?: boolean;
}) {
  const props = { value, onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value), maxLength: max, required: !optional };
  return <Field label={label}>{multiline ? <textarea {...props} rows={3} /> : <input {...props} />}</Field>;
}

export function TradeTermsEditor({ initial, busy, stale, onSave, onCancel }: {
  initial?: AgreementTerms; busy: boolean; stale: boolean;
  onSave: (terms: AgreementTerms) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => tradeDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const update = (value: Partial<TradeDraft>) => setDraft((d) => ({ ...d, ...value }));
  const itemUpdate = (index: number, value: Partial<TradeItemDraft>) => setDraft((d) => ({ ...d, items: d.items.map((item, i) => i === index ? { ...item, ...value } : item) }));
  let total: string | null = null;
  try { const terms = draftTerms(draft); total = `${previewTradeTotal(terms)} ${tradeAssetLabel(terms.quoteAsset)}`; } catch { /* incomplete form */ }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || stale) return;
    try { const terms = draftTerms(draft); setError(null); onSave(terms); }
    catch (e) { setError(errorMessage(e)); }
  }

  return <form className="card trade-editor" onSubmit={submit} autoComplete="off" aria-label={initial ? "Revise trade agreement" : "New trade agreement"}>
    <h3>{initial ? "Edit terms — creates a new revision" : "New shipped card sale"}</h3>
    <p>Local owner reports only. Party labels, condition, ownership and acceptance are not independently verified. Do not enter secrets or postal addresses.</p>
    {stale && <p className="trade-warning" role="alert">This draft is based on an older record version. Saving is blocked. Cancel to review the latest record before starting another edit; nothing has been overwritten.</p>}
    <fieldset disabled={busy}>
      <legend>Agreement</legend>
      <Text label="Title" value={draft.title} onChange={(title) => update({ title })} />
      <Text label="Origin channel" value={draft.originChannel} onChange={(originChannel) => update({ originChannel })} />
      <div className="field-row">
        <Text label="Buyer label" max={120} value={draft.buyerLabel} onChange={(buyerLabel) => update({ buyerLabel })} />
        <Text label="Seller label" max={120} value={draft.sellerLabel} onChange={(sellerLabel) => update({ sellerLabel })} />
        <Field label="Local owner's role"><select value={draft.ownerRole} onChange={(e) => update({ ownerRole: e.target.value as "buyer" | "seller" })}><option value="buyer">Buyer</option><option value="seller">Seller</option></select></Field>
      </div>
      <div className="field-row">
        <Field label="Quote asset type"><select value={draft.assetKind} onChange={(e) => {
          const assetKind = e.target.value as "fiat" | "crypto";
          const asset = TRADE_QUOTE_ASSETS.find((a) => assetKind === "fiat" ? !a.chain : !!a.chain)!;
          update({ assetKind, assetIdentifier: assetKind === "fiat" ? asset.symbol : asset.id, decimalsText: String(asset.decimals) });
        }}><option value="fiat">Fiat</option><option value="crypto">Crypto</option></select></Field>
        <Field label="Quote asset"><select value={draft.assetKind === "fiat" ? `iso4217:${draft.assetIdentifier}` : draft.assetIdentifier} onChange={(e) => {
          const asset = TRADE_QUOTE_ASSETS.find((a) => a.id === e.target.value)!;
          update({ assetIdentifier: draft.assetKind === "fiat" ? asset.symbol : asset.id, decimalsText: String(asset.decimals) });
        }}>{TRADE_QUOTE_ASSETS.filter((a) => draft.assetKind === "fiat" ? !a.chain : !!a.chain).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.symbol}{a.chain ? ` · ${a.chain.label}` : ""}</option>)}</select></Field>
      </div>
      <div className="field-row">
        <Field label={draft.assetKind === "fiat" ? "Currency code" : "Crypto asset ID (CAIP-19)"}><input value={draft.assetIdentifier} readOnly /></Field>
        <Field label="Decimals" hint="Fixed by the shared asset registry; never guessed from a ticker."><input value={draft.decimalsText} readOnly /></Field>
      </div>
      <p className="trade-muted">One asset for every item, shipping and charge. Changing denomination does not convert prices. Crypto IDs include the exact chain (for example eip155:8453/slip44:60); no wallet connection or funds movement.</p>
      <Field label="Planned payment method" hint="Separate from denomination. This is a plan, not payment or funding."><select value={draft.plannedPaymentMethod} onChange={(e) => update({ plannedPaymentMethod: e.target.value as AgreementTerms["plannedPaymentMethod"] })}><option value="cash">Cash</option><option value="bank">Bank</option><option value="card_processor">Card processor</option><option value="crypto">Crypto</option><option value="other">Other</option></select></Field>
    </fieldset>

    {draft.items.map((item, index) => <fieldset key={item.id} disabled={busy} className="trade-item-editor">
      <legend>Item {index + 1}</legend>
      <p className="trade-muted">Stable local item ID <code>{item.id}</code></p>
      <div className="field-row">
        <Text label="Game" max={100} value={item.game} onChange={(game) => itemUpdate(index, { game })} />
        <Text label="Card name" value={item.cardName} onChange={(cardName) => itemUpdate(index, { cardName })} />
      </div>
      <div className="field-row">
        <Field label="Represented item"><select value={item.representation} onChange={(e) => itemUpdate(index, { representation: e.target.value as TradeItemDraft["representation"] })}><option value="physical_copy">One physical copy</option><option value="homogeneous_lot">Homogeneous lot</option><option value="bundle">Bundle</option></select></Field>
        <Field label="Quantity"><input inputMode="numeric" required value={item.quantityText} onChange={(e) => itemUpdate(index, { quantityText: e.target.value })} /></Field>
        <Field label="Unit price" hint="Exact decimal amount in the selected quote asset."><input inputMode="decimal" required value={item.unitPriceText} onChange={(e) => itemUpdate(index, { unitPriceText: e.target.value })} /></Field>
      </div>
      <div className="field-row">
        <Text label="Set" max={120} value={item.set} onChange={(set) => itemUpdate(index, { set })} />
        <Text label="Collector number" max={100} value={item.collectorNumber} onChange={(collectorNumber) => itemUpdate(index, { collectorNumber })} />
        <Text label="Language" max={80} value={item.language} onChange={(language) => itemUpdate(index, { language })} />
        <Text label="Variant" max={120} value={item.variant} onChange={(variant) => itemUpdate(index, { variant })} />
      </div>
      <Text label="Condition description" max={1000} multiline value={item.condition.description} onChange={(description) => itemUpdate(index, { condition: { ...item.condition, description } })} />
      <Text label="Condition standard" max={120} value={item.condition.standard} onChange={(standard) => itemUpdate(index, { condition: { ...item.condition, standard } })} />
      <details><summary>Optional grading, catalog and game metadata</summary>
        <p>Manual claims only. A grade or certificate is not authentication. Catalog IDs remain source-qualified opaque text; no catalog, images, prices or legality are fetched.</p>
        {item.grading ? <>
          <div className="field-row">
            <Text label="Grading company claim" max={100} value={item.grading.company} onChange={(company) => itemUpdate(index, { grading: { ...item.grading!, company } })} />
            <Text label="Grade claim" max={80} value={item.grading.grade} onChange={(grade) => itemUpdate(index, { grading: { ...item.grading!, grade } })} />
            <Text label="Certificate claim" optional value={item.grading.certificate ?? ""} onChange={(certificate) => itemUpdate(index, { grading: { ...item.grading!, certificate: certificate || undefined } })} />
          </div>
          <button className="btn btn-ghost" type="button" onClick={() => itemUpdate(index, { grading: undefined })}>Remove grading claim</button>
        </> : <button className="btn btn-ghost" type="button" onClick={() => itemUpdate(index, { grading: { company: "", grade: "" } })}>Add grading claim</button>}
        {(["catalog", "metadata"] as const).map((kind) => <div key={kind} className="trade-metadata">
          <h4>{kind === "catalog" ? "Catalog identifiers" : "Game metadata"}</h4>
          {(item[kind] ?? []).map((entry, entryIndex) => {
            const change = (patch: Record<string, unknown>) => itemUpdate(index, { [kind]: (item[kind] ?? []).map((x, i) => i === entryIndex ? { ...x, ...patch } : x) });
            return <div key={entryIndex} className="trade-metadata-row">
              <div className="field-row">
                <Text label={kind === "catalog" ? "Catalog source" : "Metadata key"} max={kind === "catalog" ? 120 : 100} value={"identifier" in entry ? entry.source : entry.key} onChange={(value) => change(kind === "catalog" ? { source: value } : { key: value })} />
                <Text label={kind === "catalog" ? "Opaque catalog identifier" : "Metadata value"} max={kind === "catalog" ? 240 : 500} value={"identifier" in entry ? entry.identifier : entry.value} onChange={(value) => change(kind === "catalog" ? { identifier: value } : { value })} />
              </div>
              <Text label="Provenance source" max={240} value={entry.provenance.source} onChange={(source) => change({ provenance: { ...entry.provenance, source } })} />
              <div className="field-row">
                <Text label="Observed at (ISO time, optional)" optional max={40} value={entry.provenance.observedAt ?? ""} onChange={(observedAt) => change({ provenance: { ...entry.provenance, observedAt: observedAt || undefined } })} />
                <Field label="Source rights"><select value={entry.provenance.rights} onChange={(e) => change({ provenance: { ...entry.provenance, rights: e.target.value } })}><option value="unknown">Unknown</option><option value="permitted">Permitted (reported)</option><option value="restricted">Restricted (reported)</option></select></Field>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => itemUpdate(index, { [kind]: (item[kind] ?? []).filter((_, i) => i !== entryIndex) })}>Remove {kind === "catalog" ? "catalog identifier" : "metadata"} {entryIndex + 1}</button>
            </div>;
          })}
          <button type="button" className="btn btn-ghost" disabled={(item[kind]?.length ?? 0) >= (kind === "catalog" ? 10 : 20)} onClick={() => {
            const provenance = { source: "manual owner entry", rights: "unknown" as const };
            if (kind === "catalog") itemUpdate(index, { catalog: [...(item.catalog ?? []), { source: "", identifier: "", provenance }] });
            else itemUpdate(index, { metadata: [...(item.metadata ?? []), { key: "", value: "", provenance }] });
          }}>Add {kind === "catalog" ? "catalog identifier" : "game metadata"}</button>
        </div>)}
      </details>
      {draft.items.length > 1 && <button className="btn btn-ghost" type="button" onClick={() => update({ items: draft.items.filter((_, i) => i !== index) })}>Remove item {index + 1}</button>}
    </fieldset>)}
    <button className="btn btn-ghost" type="button" disabled={busy || draft.items.length >= 100} onClick={() => update({ items: [...draft.items, newTradeItem()] })}>Add card / bundle item</button>

    <fieldset disabled={busy}>
      <legend>Shipping, charges and inspection</legend>
      <div className="field-row">
        <Field label="Shipping amount"><input inputMode="decimal" required value={draft.shipping.amountText} onChange={(e) => update({ shipping: { ...draft.shipping, amountText: e.target.value } })} /></Field>
        <Field label="Shipping payer"><select value={draft.shipping.payer} onChange={(e) => update({ shipping: { ...draft.shipping, payer: e.target.value as "buyer" | "seller" } })}><option value="buyer">Buyer</option><option value="seller">Seller</option></select></Field>
      </div>
      <Text label="Shipping responsibility" max={1000} multiline value={draft.shipping.responsibility} onChange={(responsibility) => update({ shipping: { ...draft.shipping, responsibility } })} />
      {draft.charges.map((charge, i) => <div key={i} className="trade-metadata-row">
        <div className="field-row">
          <Text label={`Charge ${i + 1} label`} max={120} value={charge.label} onChange={(label) => update({ charges: draft.charges.map((c, n) => n === i ? { ...c, label } : c) })} />
          <Field label={`Charge ${i + 1} amount`}><input inputMode="decimal" required value={charge.amountText} onChange={(e) => update({ charges: draft.charges.map((c, n) => n === i ? { ...c, amountText: e.target.value } : c) })} /></Field>
          <Field label={`Charge ${i + 1} payer`}><select value={charge.payer} onChange={(e) => update({ charges: draft.charges.map((c, n) => n === i ? { ...c, payer: e.target.value as "buyer" | "seller" } : c) })}><option value="buyer">Buyer</option><option value="seller">Seller</option></select></Field>
        </div>
        <button className="btn btn-ghost" type="button" onClick={() => update({ charges: draft.charges.filter((_, n) => i !== n) })}>Remove charge {i + 1}</button>
      </div>)}
      <button className="btn btn-ghost" type="button" disabled={draft.charges.length >= 20} onClick={() => update({ charges: [...draft.charges, { label: "", payer: "buyer", amountText: "0" }] })}>Add disclosed charge</button>
      <div className="field-row">
        <Field label="Inspection window (hours)"><input inputMode="numeric" required value={draft.inspectionHoursText} onChange={(e) => update({ inspectionHoursText: e.target.value })} /></Field>
        <Text label="Proposal expiry (ISO time with timezone)" max={40} value={draft.expiresAt} onChange={(expiresAt) => update({ expiresAt })} />
      </div>
      <Text label="Dispute terms" max={2000} multiline value={draft.disputeTerms} onChange={(disputeTerms) => update({ disputeTerms })} />
      <Text label="Return terms" max={2000} multiline value={draft.returnTerms} onChange={(returnTerms) => update({ returnTerms })} />
      <p>No automatic release deadline. The simulator supports full release or full refund only.</p>
      {!!draft.referenceValuations?.length && <p>Existing reference valuations and their provenance are retained unchanged, outside the agreement total and wallet balances.</p>}
    </fieldset>
    <p className="trade-total">Exact buyer total preview: <strong>{total ?? "Complete valid amounts to preview"}</strong><br />Cashloom fee: 0. Seller-paid costs are disclosed separately, not added to the buyer total.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="btn-row">
      <button className="btn btn-primary" type="submit" disabled={busy || stale}>{initial ? "Save new revision" : "Save agreement"}</button>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={onCancel}>Cancel edit</button>
    </div>
  </form>;
}
