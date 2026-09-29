import { useEffect, useRef, useState } from "react";
import { currentSessionGuard } from "../api";
import { createBrowserWalletController } from "../integrations/browser-wallet";

type Controller = ReturnType<typeof createBrowserWalletController>;
export type BrowserWalletPickerState = ReturnType<Controller["getState"]>;
const EMPTY_STATE: BrowserWalletPickerState = { wallets: [], status: "idle", wallet_id: null, accounts: [], error: null };

export function pickerCanUseAddress(state: BrowserWalletPickerState, address: string | null): address is string {
  return state.status === "ready" && state.wallet_id !== null && address !== null && state.accounts.includes(address);
}

export function retainPickerChoice(previous: BrowserWalletPickerState, next: BrowserWalletPickerState, address: string | null): string | null {
  return previous.wallet_id === next.wallet_id && pickerCanUseAddress(next, address) ? address : null;
}

/** Presentation stays separate from provider access so no render discovers wallets. */
export function BrowserWalletPickerView({ state, selectedAddress, busy, disabled, onConnect, onSelect, onConfirm, onDiscover, onClose }: {
  state: BrowserWalletPickerState; selectedAddress: string | null; busy: boolean; disabled: boolean;
  onConnect(id: string): void; onSelect(address: string): void; onConfirm(): void; onDiscover(): void; onClose(): void;
}) {
  const requesting = busy || state.status === "requesting";
  return <section className="browser-wallet-picker" aria-label="Browser wallet picker" aria-busy={requesting}>
    <h4>Choose an address from your wallet</h4>
    <p>Choose a wallet, then allow it to share addresses with this site. Your wallet must be on Base. This requests no signature or payment; your wallet may contact its own providers.</p>
    <p className="journey-note">Wallet names are self-reported, not verified by CashLoom.</p>
    {state.wallets.length === 0 ? <p role="status">No browser wallet has been found. Open your wallet extension and try discovery again, or close this picker and paste a public address.</p>
      : <div className="browser-wallet-options">{state.wallets.map(wallet => <button type="button" className="btn btn-ghost" key={wallet.id} disabled={disabled || requesting} onClick={() => onConnect(wallet.id)}>Request addresses from {wallet.name}</button>)}</div>}
    {requesting && <p role="status">Waiting for your wallet. Check its window to continue. Closing this picker stops this selection; it cannot dismiss a wallet prompt.</p>}
    {state.error && <p className="form-error" role="alert">{state.error.message}</p>}
    {state.status === "ready" && state.accounts.length > 0 && <fieldset className="browser-wallet-addresses" disabled={disabled || requesting}>
      <legend>Choose one public address</legend>
      {state.accounts.map(address => <label className="browser-wallet-address" key={address}>
        <input type="radio" name="browser-wallet-address" value={address} checked={selectedAddress === address} onChange={() => onSelect(address)} />
        <code>{address}</code>
      </label>)}
    </fieldset>}
    <p className="journey-note">Switch your wallet to Base, then request addresses again if needed. CashLoom does not switch networks for you.</p>
    <div className="btn-row">
      {state.status === "ready" && state.accounts.length > 0 && <button type="button" className="btn btn-primary" disabled={disabled || requesting || !pickerCanUseAddress(state, selectedAddress)} onClick={onConfirm}>Use this address</button>}
      <button type="button" className="btn btn-ghost" disabled={disabled || requesting} onClick={onDiscover}>Discover wallets again</button>
      <button type="button" className="link-btn" onClick={onClose}>Close wallet picker</button>
    </div>
    <p className="watch-wallet-limit">Closing stops this picker. To remove this site’s wallet permission, use your wallet’s settings. A saved watched address remains a separate local record.</p>
  </section>;
}

export function BrowserWalletPicker({ disabled = false, onBusyChange, onAddress, onClose }: {
  disabled?: boolean; onBusyChange(busy: boolean): void; onAddress(address: string): void; onClose(): void;
}) {
  const [state, setState] = useState<BrowserWalletPickerState>(EMPTY_STATE);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<Controller | null>(null);
  const alive = useRef(false), pending = useRef(false), reportedBusy = useRef(false), enabled = useRef(!disabled);
  const callbacks = useRef({ onBusyChange, onAddress });
  enabled.current = !disabled;
  callbacks.current = { onBusyChange, onAddress };

  useEffect(() => {
    alive.current = true;
    const session = currentSessionGuard();
    const instance = createBrowserWalletController({ isSessionCurrent: () => alive.current && enabled.current && session() });
    controller.current = instance;
    let publishedState = instance.getState();
    const unsubscribe = instance.subscribe(next => {
      if (!alive.current || !session()) return;
      const previous = publishedState;
      publishedState = next;
      setState(next);
      // A late discovery announcement is unrelated to the chosen address.
      // Provider changes and new requests still invalidate that explicit choice.
      setSelectedAddress(current => retainPickerChoice(previous, next, current));
    });
    instance.discover();
    setState(instance.getState());
    return () => {
      alive.current = false; controller.current = null;
      unsubscribe(); instance.close();
      if (reportedBusy.current) { reportedBusy.current = false; callbacks.current.onBusyChange(false); }
    };
  }, []);

  async function run(action: (instance: Controller) => Promise<void>) {
    const instance = controller.current;
    const session = currentSessionGuard();
    if (!instance || !alive.current || !enabled.current || !session() || pending.current) return;
    pending.current = true; reportedBusy.current = true; setBusy(true); callbacks.current.onBusyChange(true);
    try { await action(instance); }
    catch { /* The controller publishes fixed, credential-free error messages. */ }
    finally {
      pending.current = false;
      if (alive.current && session()) {
        setBusy(false);
        if (reportedBusy.current) { reportedBusy.current = false; callbacks.current.onBusyChange(false); }
      }
    }
  }

  return <BrowserWalletPickerView state={state} selectedAddress={selectedAddress} busy={busy} disabled={disabled}
    onConnect={id => void run(async instance => { await instance.connect(id); })}
    onSelect={setSelectedAddress}
    onConfirm={() => {
      const address = selectedAddress;
      if (!pickerCanUseAddress(state, address)) return;
      const walletId = state.wallet_id;
      const session = currentSessionGuard();
      void run(async instance => {
        const result = await instance.confirm(address);
        if (!alive.current || !enabled.current || !session() || controller.current !== instance ||
            instance.getState().wallet_id !== walletId || !pickerCanUseAddress(instance.getState(), result.address)) return;
        callbacks.current.onAddress(result.address);
      });
    }}
    onDiscover={() => {
      if (!alive.current || !enabled.current || pending.current || !currentSessionGuard()()) return;
      setSelectedAddress(null); controller.current?.discover();
    }}
    onClose={() => { controller.current?.close(); onClose(); }} />;
}
