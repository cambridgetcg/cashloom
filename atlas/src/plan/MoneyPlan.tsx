import { useEffect, useRef, useState } from "react";
import { PublicHeader } from "../components/PublicHeader";
import {
  CATEGORIES, CURRENCIES, MAX_IMPORT_BYTES, MAX_ITEMS, STORAGE_KEY, PlanStorageConflict, calculatePlan, clearSavedPlan,
  exportPlan, formatMoney, importPlan, parseAmount, planForAudience, planIssue, readSavedPlan, savePlan,
  type Category, type Currency, type MoneyPlan as PlanData, type Purpose, type SavedPlanResult,
} from "./model";
import "./money-plan.css";

const CATEGORIES_COPY: Record<Category, { title: string; description: string; add: string; example: Record<Purpose, string> }> = {
  income: { title: "Money coming in", description: "What you expect to receive after deductions, each month.", add: "Add income", example: { personal: "Take-home pay", household: "First household income", independent: "Client income received", group: "Member contributions" } },
  commitments: { title: "Regular commitments", description: "The payments you need to make, including minimum debt payments.", add: "Add a commitment", example: { personal: "Rent or mortgage", household: "Rent or mortgage", independent: "Workspace or software", group: "Venue or equipment hire" } },
  spending: { title: "Everyday spending", description: "A realistic monthly allowance for costs that vary.", add: "Add spending", example: { personal: "Food and groceries", household: "Household groceries", independent: "Supplies and travel", group: "Event supplies" } },
  setAsides: { title: "Money set aside", description: "What you want to keep for future costs, savings or extra debt payments.", add: "Add a set-aside", example: { personal: "Emergency fund", household: "Annual bills or a shared goal", independent: "Tax or a quieter month", group: "Next group project" } },
};

const PURPOSE_COPY: Record<Purpose, { label: string; description: string }> = {
  personal: { label: "Just me", description: "Make room for your essentials, your plans and the things you enjoy." },
  household: { label: "Our household", description: "Put shared income and costs in one picture to talk through together. This plan does not sync between people." },
  independent: { label: "Independent work", description: "Plan expected cash received and costs paid. Include tax and quieter months in your set-asides; this is not a tax calculator." },
  group: { label: "Our group", description: "Bring contributions, shared costs and future projects together. One person edits this plan; export a copy to share. It does not sync between members." },
};

function initialSavedPlan(): SavedPlanResult {
  if (typeof window === "undefined") return { status: "empty", plan: null, snapshot: null };
  try { return readSavedPlan(window.localStorage); }
  catch { return { status: "error", plan: null, snapshot: undefined, message: "This browser blocked access to saved plans. You can still plan and export a file." }; }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function MoneyPlan() {
  const [initial] = useState(initialSavedPlan);
  const [plan, setPlan] = useState<PlanData>(() => initial.plan ?? planForAudience(typeof window === "undefined" ? "" : window.location.search));
  const [saveEnabled, setSaveEnabled] = useState(initial.status === "loaded");
  const [saveMessage, setSaveMessage] = useState(initial.status === "loaded" ? "Your saved plan is open." : "");
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState(initial.plan ? JSON.stringify(initial.plan) : "");
  const [storageConflict, setStorageConflict] = useState("");
  const [pendingSave, setPendingSave] = useState<{ snapshot: string | null; description: string } | null>(null);
  const [error, setError] = useState(initial.status === "error" ? initial.message : "");
  const [notice, setNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingImport, setPendingImport] = useState<PlanData | null>(null);
  const [importing, setImporting] = useState(false);
  const nextFocus = useRef<string | null>(null);
  const storageSnapshot = useRef(initial.snapshot);
  const confirmationCancel = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const summary = calculatePlan(plan);
  const issue = planIssue(plan);
  const hasEntries = plan.items.length > 0;
  const snapshot = JSON.stringify(plan);
  const hasUnkeptChanges = hasEntries && (!saveEnabled || snapshot !== lastSavedSnapshot);
  const ready = hasEntries && summary.invalidAmounts === 0;
  const shortfall = summary.remainder < 0;
  const money = (minor: number) => formatMoney(minor, plan.currency);

  useEffect(() => {
    const savedElsewhere = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      let latest: string | null;
      try { latest = window.localStorage.getItem(STORAGE_KEY); }
      catch { return; }
      if (latest === storageSnapshot.current) return;
      setSaveEnabled(false);
      setSaveMessage("");
      setPendingSave(null);
      setStorageConflict(latest === null ? "The saved browser copy was removed in another tab. Your current entries are still here, and automatic saving is paused." : "The saved plan changed in another tab. Your current entries are still here, and automatic saving is paused.");
    };
    window.addEventListener("storage", savedElsewhere);
    return () => window.removeEventListener("storage", savedElsewhere);
  }, []);
  useEffect(() => {
    if (!hasUnkeptChanges) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnkeptChanges]);
  useEffect(() => {
    if (nextFocus.current) {
      document.getElementById(nextFocus.current)?.focus();
      nextFocus.current = null;
    }
  }, [plan.items]);
  useEffect(() => {
    if (confirmClear || pendingImport || pendingSave) confirmationCancel.current?.focus();
  }, [confirmClear, pendingImport, pendingSave]);
  useEffect(() => {
    if (!saveEnabled || storageConflict) return;
    if (issue) { setSaveMessage("Finish each entry to save these changes. Your last complete saved plan is kept."); return; }
    try {
      storageSnapshot.current = savePlan(window.localStorage, plan, storageSnapshot.current);
      setSaveMessage("Saved in this browser.");
      setLastSavedSnapshot(JSON.stringify(plan));
    } catch (failure) {
      if (failure instanceof PlanStorageConflict) {
        setSaveEnabled(false);
        setSaveMessage("");
        setStorageConflict(failure.message);
      } else setSaveMessage("Changes could not be saved in this browser. Export a file to keep this plan.");
    }
  }, [plan, saveEnabled, issue, storageConflict]);

  function updateEntry(id: string, field: "label" | "amount", value: string) {
    setPlan((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, [field]: value } : item) }));
    setNotice("");
  }

  function addEntry(category: Category) {
    if (plan.items.length >= MAX_ITEMS) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    nextFocus.current = `plan-name-${id}`;
    setPlan((current) => ({ ...current, items: [...current.items, { id, category, label: "", amount: "" }] }));
    setNotice("");
  }

  function removeEntry(id: string, category: Category) {
    const peers = plan.items.filter((item) => item.category === category && item.id !== id);
    nextFocus.current = peers.length ? `plan-name-${peers[peers.length - 1].id}` : `plan-add-${category}`;
    setPlan((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
    setNotice("Entry removed.");
  }

  function toggleSaving(enabled: boolean) {
    setError("");
    if (enabled && (storageConflict || storageSnapshot.current === undefined)) { reviewSaving(); return; }
    if (!enabled) {
      try {
        clearSavedPlan(window.localStorage, storageSnapshot.current);
        storageSnapshot.current = null;
        setNotice("Browser copy removed. Your open plan is still here.");
      } catch (failure) {
        if (failure instanceof PlanStorageConflict) {
          setStorageConflict("Another tab changed the saved plan. Its copy was left untouched. Your current draft is still here.");
          setError("Saving is off. The other tab’s saved copy was left untouched.");
        } else setError("Saving is off, but this browser blocked removal of the saved plan. The saved copy may still be present.");
        setNotice("");
      }
      setSaveMessage("");
    }
    setSaveEnabled(enabled);
  }

  function clearPlan() {
    let removalError = "";
    try { clearSavedPlan(window.localStorage, storageSnapshot.current); storageSnapshot.current = null; setStorageConflict(""); }
    catch (failure) { removalError = failure instanceof PlanStorageConflict ? "Your open plan is cleared. Another tab changed the saved copy, so that copy was left untouched." : "Your open plan is cleared, but this browser blocked removal of the saved copy. A saved copy may still be present in this browser."; }
    setSaveEnabled(false);
    setPlan((current) => ({ ...current, items: [] }));
    setSaveMessage("");
    setError(removalError);
    setConfirmClear(false);
    setNotice(removalError ? "Browser saving is off." : "Entries cleared. Your currency and plan type are kept in this tab. Browser saving is off.");
    document.getElementById("plan-add-income")?.focus();
  }

  function downloadPlan() {
    setError("");
    if (issue) { setError(issue); return; }
    let url: string | null = null;
    try {
      const blob = new Blob([exportPlan(plan)], { type: "application/json" });
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "cashloom-monthly-plan.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      const downloadUrl = url;
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      setNotice("Plan file prepared for download. Keep it somewhere private.");
    } catch {
      if (url) URL.revokeObjectURL(url);
      setError("This browser could not create the download. Your open plan is still here.");
    }
  }

  async function chooseImport(file: File | undefined) {
    if (!file) return;
    setError("");
    setNotice("");
    setImporting(true);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("The file is too large. Choose a plan under 64 KB.");
      const imported = importPlan(await file.text());
      setConfirmClear(false);
      setPendingSave(null);
      setPendingImport(imported);
    } catch (failure) { setError(errorMessage(failure, "This file could not be read. Your open plan is unchanged.")); }
    finally { setImporting(false); if (importInput.current) importInput.current.value = ""; }
  }

  function loadLatestSavedPlan() {
    let latest: SavedPlanResult;
    try { latest = readSavedPlan(window.localStorage); }
    catch { setError("This browser blocked access to the saved plan. Your draft is still here."); return; }
    if (latest.status !== "loaded") {
      setError(latest.status === "error" ? latest.message : "There is no saved browser copy to load. Your current draft is still here.");
      return;
    }
    storageSnapshot.current = latest.snapshot;
    setPlan(latest.plan);
    setLastSavedSnapshot(JSON.stringify(latest.plan));
    setStorageConflict("");
    setPendingSave(null);
    setSaveEnabled(true);
    setError("");
    setNotice("The latest saved browser plan is open.");
  }

  function reviewSaving() {
    if (issue) { setError(issue); return; }
    let latest: SavedPlanResult;
    try { latest = readSavedPlan(window.localStorage); }
    catch { setError("This browser blocked access to the saved plan. Your draft is still here."); return; }
    if (latest.snapshot === undefined) { setError(latest.status === "error" ? latest.message : "The saved plan could not be checked."); return; }
    setPendingImport(null);
    setConfirmClear(false);
    setPendingSave({ snapshot: latest.snapshot, description: latest.status === "loaded" ? `The saved copy contains ${latest.plan.items.length} monthly ${latest.plan.currency} entries. Your current draft will replace it.` : latest.status === "empty" ? "There is no saved browser copy. Saving will create a new copy of your current draft." : "The current saved copy cannot be read. Your draft will replace that copy." });
  }

  function confirmSavingDraft() {
    if (!pendingSave) return;
    try {
      storageSnapshot.current = savePlan(window.localStorage, plan, pendingSave.snapshot);
      setLastSavedSnapshot(JSON.stringify(plan));
      setSaveEnabled(true);
      setStorageConflict("");
      setPendingSave(null);
      setError("");
      setNotice("Your current draft is now the saved browser plan.");
    } catch (failure) {
      setError(errorMessage(failure, "Your draft could not be saved."));
      if (failure instanceof PlanStorageConflict) { setPendingSave(null); setStorageConflict("The saved copy changed again. Your draft is still here; review the latest copy before saving."); }
    }
  }

  return <div className="money-plan">
    <a className="skip-link" href="#plan-main">Skip to your plan</a>
    <PublicHeader current="plan" />
    <main id="plan-main">
      <div className="plan-intro">
        <p className="plan-eyebrow">Your money, with a purpose</p>
        <h1>A little clarity.<br />A lot more control.</h1>
        <p>See what comes in, give your money a job, and understand what is left. Build a monthly plan you can change as life changes.</p>
        <div className="plan-badges"><span>No account needed</span><span>Works in your browser</span><span>Your estimates, your decisions</span></div>
      </div>
      {hasUnkeptChanges && <p className="plan-unsaved">Your changes are open in this tab. <a href="#plan-storage-title">Save in this browser or export your plan</a> before leaving.</p>}
      {storageConflict && <p className="plan-unsaved">{storageConflict} <a href="#plan-storage-title">Review your saved plan</a>.</p>}
      <div className="plan-workspace">
        <div className="plan-editor">
          <section className="plan-setup" aria-labelledby="plan-setup-title">
            <h2 id="plan-setup-title">Make this plan yours</h2>
            <fieldset className="plan-purpose">
              <legend>Who are you planning for?</legend>
              <div>{(Object.keys(PURPOSE_COPY) as Purpose[]).map((purpose) => <label key={purpose} className={plan.purpose === purpose ? "is-selected" : ""}>
                <input id={`plan-purpose-${purpose}`} type="radio" name="plan-purpose" value={purpose} checked={plan.purpose === purpose} onChange={() => setPlan((current) => ({ ...current, purpose }))} />
                {PURPOSE_COPY[purpose].label}
              </label>)}</div>
            </fieldset>
            <p className="plan-purpose-description">{PURPOSE_COPY[plan.purpose].description}</p>
            <div className="plan-settings">
              <label htmlFor="plan-currency">Currency<select id="plan-currency" value={plan.currency} onChange={(event) => setPlan((current) => ({ ...current, currency: event.target.value as Currency }))} aria-describedby="plan-currency-help">
                {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
              </select></label>
              <div className="plan-period"><span>Time period</span><strong>One month</strong></div>
            </div>
            <p id="plan-currency-help" className="plan-help">Changing currency relabels your amounts; it does not convert them. Enter monthly amounts only. For annual costs, enter the amount you want to set aside each month.</p>
          </section>

          {CATEGORIES.map((category, index) => {
            const copy = CATEGORIES_COPY[category];
            const items = plan.items.filter((item) => item.category === category);
            return <section className="plan-category" key={category} aria-labelledby={`plan-title-${category}`}>
              <div className="plan-category-heading"><span className="plan-step" aria-hidden="true">0{index + 1}</span><div><h2 id={`plan-title-${category}`}>{copy.title}</h2><p>{copy.description}</p></div><span className="plan-category-total" aria-label={`${copy.title} subtotal`}>{money(summary.totals[category])}</span></div>
              {items.length === 0 && <p className="plan-empty">Start with {copy.example[plan.purpose].toLowerCase()}, or whatever matters in your plan.</p>}
              <div className="plan-entries">{items.map((item, itemIndex) => {
                const invalid = item.amount !== "" && parseAmount(item.amount) === null;
                return <div className="plan-entry" key={item.id}>
                  <label className="plan-entry-name" htmlFor={`plan-name-${item.id}`}><span>Name <span className="plan-sr-only">for {copy.title.toLowerCase()} entry {itemIndex + 1}</span></span><input id={`plan-name-${item.id}`} value={item.label} maxLength={80} placeholder={copy.example[plan.purpose]} autoComplete="off" onChange={(event) => updateEntry(item.id, "label", event.target.value)} /></label>
                  <label className="plan-entry-amount" htmlFor={`plan-amount-${item.id}`}><span>Per month <span className="plan-sr-only">for {item.label || `${copy.title} entry ${itemIndex + 1}`}</span></span><div className="plan-amount-input"><span aria-hidden="true">{plan.currency}</span><input id={`plan-amount-${item.id}`} inputMode="decimal" value={item.amount} maxLength={32} placeholder="0.00" autoComplete="off" aria-invalid={invalid || undefined} aria-describedby={invalid ? `plan-error-${item.id}` : undefined} onChange={(event) => updateEntry(item.id, "amount", event.target.value)} /></div></label>
                  <button type="button" className="plan-remove" aria-label={`Remove ${item.label || `${copy.title.toLowerCase()} entry ${itemIndex + 1}`}`} onClick={() => removeEntry(item.id, category)}><span aria-hidden="true">×</span></button>
                  {invalid && <p className="plan-entry-error" id={`plan-error-${item.id}`}>Use a positive amount or zero, up to 999,999,999.99, with a decimal point and no commas.</p>}
                </div>;
              })}</div>
              <button id={`plan-add-${category}`} className="plan-add" type="button" disabled={plan.items.length >= MAX_ITEMS} onClick={() => addEntry(category)}><span aria-hidden="true">＋</span> {copy.add}</button>
            </section>;
          })}
          {plan.items.length >= MAX_ITEMS && <p className="plan-help">You have reached the limit of {MAX_ITEMS} entries. Remove one to add another.</p>}
        </div>

        <aside className="plan-sidebar" aria-label="Your monthly summary">
          <section className="plan-summary">
            <p className="plan-eyebrow">Your monthly picture</p>
            <h2>{!ready ? "Room for what matters." : shortfall ? "Your plan needs more room." : "Every amount has a place."}</h2>
            <p className="plan-summary-intro">{!hasEntries ? "Start with your income. Then add the costs and goals you want to make room for." : summary.invalidAmounts ? "Complete each amount to see your remaining money. Subtotals include completed amounts only." : "These are estimates from the amounts you enter, not account balances."}</p>
            <dl className="plan-breakdown">
              {CATEGORIES.map((category) => <div key={category}><dt>{category === "income" ? "Coming in" : category === "commitments" ? "Commitments" : category === "spending" ? "Everyday spending" : "Set aside"}</dt><dd>{hasEntries ? money(summary.totals[category]) : "—"}</dd></div>)}
            </dl>
            <div className={`plan-remainder${ready && shortfall ? " is-shortfall" : ""}`}>
              <span>{ready && shortfall ? "Monthly shortfall" : "Left to give a purpose"}</span>
              <strong aria-live="polite">{ready ? money(Math.abs(summary.remainder)) : "—"}</strong>
              <p>{!ready ? "Your remainder appears here as you build your plan." : shortfall ? "Your planned costs and set-asides exceed your income. Review your entries and decide what can change." : summary.remainder === 0 ? "Your expected income is fully allocated. Check that your essentials and future costs are covered." : "You can leave this as breathing room, or give it a purpose in your plan."}</p>
            </div>
            <p className="plan-summary-note">A plan helps you decide. It does not move money, connect accounts or calculate tax.</p>
          </section>
          <section className="plan-tips" aria-labelledby="plan-tips-title">
            <h2 id="plan-tips-title">A plan you can come back to.</h2>
            <p>Use what you know today. If your income changes month to month, choose the amount you expect to receive this month and revisit it when things change.</p>
            <a href="/wallet">Explore accounts &amp; payments <span aria-hidden="true">↗</span></a>
          </section>
        </aside>
      </div>

      <section className="plan-storage" aria-labelledby="plan-storage-title">
        <div><p className="plan-eyebrow">Keep control of your plan</p><h2 id="plan-storage-title">Keep it here. Take it with you.</h2><p>Entries stay on this page unless you choose to save or export them. This planner sends no entries to a server.</p></div>
        <div className="plan-storage-controls">
          <label className="plan-save-choice"><input type="checkbox" checked={saveEnabled} onChange={(event) => toggleSaving(event.target.checked)} aria-describedby="plan-save-help" /><span>Save this plan in this browser</span></label>
          <p id="plan-save-help" className="plan-help">Optional. Anyone using this browser profile may see it. It will not sync to other devices. Turn saving off to remove the saved copy and keep working here.</p>
          {saveEnabled && <p className="plan-save-status" role="status">{saveMessage}</p>}
          <div className="plan-file-actions"><button type="button" className="plan-button plan-button-primary" onClick={downloadPlan}>Export plan</button><button id="plan-import-button" type="button" className="plan-button" disabled={importing} onClick={() => importInput.current?.click()}>{importing ? "Reading file…" : "Import plan"}</button><button type="button" className="plan-clear" onClick={() => { setPendingImport(null); setPendingSave(null); setConfirmClear(true); }}>Clear plan</button></div>
          <input ref={importInput} className="plan-file-input" type="file" accept=".json,application/json" aria-label="Choose a CashLoom plan file" onChange={(event) => void chooseImport(event.target.files?.[0])} />
          <p className="plan-help">Export creates a readable JSON file. Keep it private. Import accepts CashLoom monthly plan files up to 64 KB and asks before replacing your plan.</p>
        </div>
        {storageConflict && <div className="plan-conflict" role="status"><h3>Choose which plan to keep</h3><p>{storageConflict} Loading the saved plan replaces your current draft. Export first if you want to keep both.</p><div><button type="button" className="plan-button" onClick={loadLatestSavedPlan}>Load latest saved plan</button><button type="button" className="plan-button" onClick={() => { setSaveEnabled(false); setNotice("Your current draft is kept in this tab. Saving stays paused until you review saving it again."); }}>Keep my current draft</button><button type="button" className="plan-button" onClick={reviewSaving}>Review saving this draft</button></div></div>}
        {confirmClear && <div className="plan-confirmation" role="alertdialog" aria-labelledby="plan-clear-title" aria-describedby="plan-clear-description"><h3 id="plan-clear-title">Clear this plan?</h3><p id="plan-clear-description">This removes all entries and the saved copy in this browser. Your currency and who you’re planning for stay selected in this tab. Export first if you want to keep a copy. Files you have already exported stay on your device.</p><div><button ref={confirmationCancel} type="button" className="plan-button" onClick={() => { setConfirmClear(false); document.querySelector<HTMLButtonElement>(".plan-clear")?.focus(); }}>Keep my plan</button><button type="button" className="plan-button plan-button-danger" onClick={clearPlan}>Yes, clear plan</button></div></div>}
        {pendingImport && <div className="plan-confirmation" role="alertdialog" aria-labelledby="plan-import-title" aria-describedby="plan-import-description"><h3 id="plan-import-title">Replace your current plan?</h3><p id="plan-import-description">The file contains {pendingImport.items.length} monthly {pendingImport.currency} {pendingImport.items.length === 1 ? "entry" : "entries"}. Importing replaces your open plan{saveEnabled ? " and its saved browser copy" : ""}. Export your current plan first if you want to keep it.</p><div><button ref={confirmationCancel} type="button" className="plan-button" onClick={() => { setPendingImport(null); document.getElementById("plan-import-button")?.focus(); }}>Keep current plan</button><button type="button" className="plan-button plan-button-primary" onClick={() => { setPlan(pendingImport); setPendingImport(null); setError(""); setNotice("Plan imported. Review your entries below the introduction."); document.getElementById("plan-purpose-personal")?.focus(); }}>Replace with imported plan</button></div></div>}
        {pendingSave && <div className="plan-confirmation" role="alertdialog" aria-labelledby="plan-save-review-title" aria-describedby="plan-save-review-description"><h3 id="plan-save-review-title">Save this draft as the browser plan?</h3><p id="plan-save-review-description">{pendingSave.description} Automatic saving will then resume in this tab.</p><div><button ref={confirmationCancel} type="button" className="plan-button" onClick={() => setPendingSave(null)}>Keep saving paused</button><button type="button" className="plan-button plan-button-primary" onClick={confirmSavingDraft}>Save this draft and resume</button></div></div>}
        {error && <p className="plan-feedback plan-feedback-error" role="alert">{error}</p>}
        {notice && <p className="plan-feedback" role="status">{notice}</p>}
      </section>
      <footer className="plan-footer"><span>Your money. Your choices.</span><a href="/">Back to CashLoom</a></footer>
    </main>
  </div>;
}
