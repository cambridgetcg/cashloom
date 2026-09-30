import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, currentSessionGuard, errorMessage, type WatchWalletInput, type WatchWalletResult } from "../api";
import { Badge, Field } from "../components";
import type { Account } from "../types";
import { BrowserWalletPicker } from "./BrowserWalletPicker";
import { PhoneWalletPicker } from "./PhoneWalletPicker";
import "./watch-wallet.css";

const BASE = "eip155:8453";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE_ASSETS = new Set([`${BASE}/slip44:60`, `${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`]);

/** Shape checks only. The node validates a mixed-case checksum before saving. */
export function watchWalletInput(address: string, name: string): WatchWalletInput {
  const publicAddress = address.trim();
  const label = name.trim();
  if (!ADDRESS.test(publicAddress)) throw new Error("Enter a public Base address: 0x followed by 40 hexadecimal characters.");
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Choose a wallet label from 1 to 120 characters on one line.");
  // Preserve case for the authoritative checksum validation; never silently
  // turn a mistyped mixed-case address into a different unchecked input.
  return { network: "base", address: publicAddress, display_name: label };
}

export function watchedBaseAddress(account: Account): string | null {
  if (account.rail !== "CRYPTO" || account.chain_id !== BASE || account.vault_key_id || !BASE_ASSETS.has(account.asset_id?.toLowerCase() ?? "")) return null;
  const prefix = `${BASE}:`;
  const address = account.account_ref?.startsWith(prefix) ? account.account_ref.slice(prefix.length) : "";
  return ADDRESS.test(address) ? address : null;
}

/** Avoid navigating on an unreadable or unrelated success; its outcome is unknown. */
export function watchResultMatches(result: WatchWalletResult, input: WatchWalletInput): boolean {
  const account = result?.account;
  return typeof result?.created === "boolean" && !!account && typeof account.id === "string" && account.id.length > 0 &&
    typeof account.display_name === "string" && account.rail === "CRYPTO" && account.status === "ACTIVE" &&
    account.chain_id === BASE && BASE_ASSETS.has(account.asset_id?.toLowerCase() ?? "") &&
    account.account_ref?.toLowerCase() === `${BASE}:${input.address.toLowerCase()}` &&
    (!result.created || account.vault_key_id === null);
}

export function watchOutcomeUncertain(reason: unknown): boolean {
  return !(reason instanceof ApiError && reason.status !== undefined && reason.status >= 400 && reason.status < 500 && reason.status !== 408);
}

export function watchResultMessage(result: WatchWalletResult): string {
  return result.created
    ? `Wallet added for watching: ${result.account.display_name}. No balances were checked.`
    : `Already tracked as ${result.account.display_name}. Its existing label and wallet settings were kept; no balances were checked.`;
}

export function WatchedWalletDetails({ account }: { account: Account }) {
  const address = watchedBaseAddress(account);
  if (!address) return null;
  return <section className="watched-wallet-details" aria-label="Watched wallet details">
    <div className="watched-wallet-heading"><Badge tone="dim">Watch only</Badge><strong>Base · public address</strong></div>
    <code>{address}</code>
    <p>Watching a public address does not establish who owns it. No signing key is attached to this record.</p>
    <p><strong>Check balances</strong> sends this address to the node’s configured RPC providers to read finalized ETH and native USDC balances. Opening this page reads saved data locally. Base transaction history is not imported.</p>
  </section>;
}

export function WatchWallet({ canManage, disabled = false, onBusyChange, onSaved, onCancel, onReviewAccounts }: {
  canManage: boolean; disabled?: boolean; onBusyChange?(busy: boolean): void;
  onSaved(result: WatchWalletResult): void; onCancel(): void; onReviewAccounts?(): void;
}) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryInput, setRetryInput] = useState<WatchWalletInput | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<"browser" | "phone">("browser");
  const [pickerBusy, setPickerBusy] = useState(false);
  const [copiedFromWallet, setCopiedFromWallet] = useState(false);
  const pending = useRef(false), live = useRef(true);
  const pickerAllowed = useRef(false);
  const addressField = useRef<HTMLInputElement | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const phonePickerTrigger = useRef<HTMLButtonElement | null>(null);
  const Picker = pickerKind === "phone" ? PhoneWalletPicker : BrowserWalletPicker;
  pickerAllowed.current = canManage && !disabled && !busy && retryInput === null;
  useEffect(() => { live.current = true; addressField.current?.focus(); return () => { live.current = false; }; }, []);
  useEffect(() => { if (!canManage || disabled || busy || retryInput !== null) setPickerOpen(false); }, [canManage, disabled, busy, retryInput]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const session = currentSessionGuard();
    if (!live.current || !session() || pending.current || pickerOpen || pickerBusy || disabled || !canManage) return;
    let input: WatchWalletInput;
    try { input = retryInput ?? watchWalletInput(address, name); }
    catch (reason) { setError(errorMessage(reason)); return; }
    pending.current = true; setBusy(true); setError(null); onBusyChange?.(true);
    try {
      const result = await api.watchWallet(input);
      if (!live.current || !session()) return;
      if (!watchResultMatches(result, input)) throw new Error("The node returned an unreadable wallet result.");
      setRetryInput(null);
      onSaved(result);
    } catch (reason) {
      if (!live.current || !session()) return;
      if (watchOutcomeUncertain(reason)) {
        setRetryInput(input);
        setError("The result could not be confirmed. The node may have saved this wallet. Retry the same wallet or review saved accounts; no balance check is started by adding it.");
      } else {
        setRetryInput(null); setError(errorMessage(reason));
      }
    } finally {
      pending.current = false;
      if (live.current && session()) { setBusy(false); onBusyChange?.(false); }
    }
  }

  return <form className="card watch-wallet-form" aria-label="Watch a wallet" onSubmit={event => void submit(event)} autoComplete="off">
    <h3>Watch a wallet</h3>
    <p>Add a public address to your local records. You can check its ETH and native USDC balances on Base afterwards. Saving the address does not check balances.</p>
    <p className="journey-note">A public address is enough. No wallet signature, seed phrase or private key is requested. Watching does not establish ownership or enable sending and receiving actions.</p>
    {!busy && retryInput === null && <div className="watch-wallet-picker-entry"><button ref={pickerTrigger} className="btn btn-ghost" type="button" disabled={!canManage || disabled || pickerOpen} onClick={() => {
      if (live.current && pickerAllowed.current && currentSessionGuard()()) { setPickerKind("browser"); setPickerOpen(true); }
    }}>Choose from a wallet</button><button ref={phonePickerTrigger} className="btn btn-ghost" type="button" disabled={!canManage || disabled || pickerOpen} onClick={() => {
      if (live.current && pickerAllowed.current && currentSessionGuard()()) { setPickerKind("phone"); setPickerOpen(true); }
    }}>Connect a phone wallet</button><span>Optional · or paste a public address below.</span></div>}
    {pickerOpen && pickerAllowed.current && <Picker disabled={disabled || !canManage}
      onBusyChange={value => { if (live.current) { setPickerBusy(value); onBusyChange?.(pending.current || value); } }}
      onAddress={pickedAddress => {
        if (!live.current || !pickerAllowed.current || pending.current || !currentSessionGuard()()) return;
        setAddress(pickedAddress); setCopiedFromWallet(true); setError(null); setPickerOpen(false);
        requestAnimationFrame(() => { if (live.current) addressField.current?.focus(); });
      }}
      onClose={() => { setPickerOpen(false); requestAnimationFrame(() => { if (live.current) (pickerKind === "phone" ? phonePickerTrigger : pickerTrigger).current?.focus(); }); }} />}
    {copiedFromWallet && <p className="journey-note" role="status">Address copied from your wallet. Review it and choose Add watched wallet to save. This form does not follow later wallet changes.</p>}
    <fieldset disabled={busy || pickerBusy || disabled || !canManage || retryInput !== null}>
      <Field label="Network"><select value="base" onChange={() => undefined}><option value="base">Base</option></select></Field>
      <Field label="Public wallet address" hint="An address on Base, beginning with 0x. Other networks are not supported in this flow."><input ref={addressField} className="mono-input" value={address} onChange={event => { setAddress(event.target.value); setCopiedFromWallet(false); }} placeholder="0x…" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} required /></Field>
      <Field label="Wallet label" hint="A name for your records, not a claim about who owns this address."><input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Base wallet to follow" maxLength={120} required /></Field>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    {retryInput && <p className="journey-note">The submitted address and label are kept unchanged for this retry. If it was already added, the node returns the existing account.</p>}
    {!canManage && <p className="journey-note">The workspace owner can add watched wallets.</p>}
    <div className="btn-row"><button className="btn btn-primary" type="submit" disabled={busy || pickerOpen || pickerBusy || disabled || !canManage}>{busy ? "Adding watched wallet…" : retryInput ? "Retry same wallet" : "Add watched wallet"}</button>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => {
        // The form's cleanup invalidates child callbacks. Release only the
        // picker-owned flag before removing the form from Connections.
        if (pickerBusy) { pickerAllowed.current = false; onBusyChange?.(false); }
        onCancel();
      }}>Cancel</button>
      {retryInput && onReviewAccounts && <button className="link-btn" type="button" disabled={busy} onClick={onReviewAccounts}>Review saved accounts</button>}
    </div>
    <p className="watch-wallet-limit">Balances stay unknown until you choose Check balances in Accounts. That check sends the address to configured RPC providers. This flow does not import Base transaction history.</p>
  </form>;
}
