import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import {
  Badge,
  CopyButton,
  EmptyState,
  LoadingThreads,
  SectionTitle,
} from "../components";
import { formatDate } from "../format";
import type { Account, VaultKey } from "../types";
import type { WalletNavigate } from "../navigation";
import { initialSendingAccount } from "./Pay";
import { isAddressKey } from "../wallet-key";

/**
 * Addresses are public by design — share them freely.
 * (No QR: a proper generator needs a dependency, and this UI carries none.)
 */
export function Receive({ initialAccountId, initialKeyId, onGoto }: { initialAccountId?: string; initialKeyId?: string; onGoto?: WalletNavigate } = {}) {
  const [keys, setKeys] = useState<VaultKey[] | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [missingSelection, setMissingSelection] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [r, accounts] = await Promise.all([api.keys(), initialAccountId ? api.accounts() : Promise.resolve({ accounts: [] })]);
        if (!live) return;
        const selected = initialAccountId ? initialSendingAccount(accounts.accounts, r.keys, initialAccountId) : null;
        setAccount(selected);
        const keyId = selected?.vault_key_id ?? initialKeyId;
        const addressKeys = r.keys.filter(isAddressKey);
        const scopedKeys = initialAccountId && !selected ? [] : keyId ? addressKeys.filter((key) => key.id === keyId) : addressKeys;
        setKeys(scopedKeys);
        setMissingSelection(Boolean((initialAccountId || initialKeyId) && scopedKeys.length === 0));
      } catch (ex) {
        if (live) setErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!keys) return <LoadingThreads />;

  return (
    <div className="stagger">
      <SectionTitle>
        Receive money
      </SectionTitle>
      <p className="journey-note">Share a supported public address with the person paying you. Check that they use the same asset and network shown here.</p>
      {account && <p className="journey-note">Receiving into {account.display_name} · {account.currency} on {account.currency === "BTC" ? "Bitcoin mainnet" : "Base"}.</p>}

      {missingSelection ? <EmptyState>The selected account or key cannot supply a receiving address. {onGoto && <button className="link-btn" onClick={() => onGoto("accounts")}>Review your accounts</button>}</EmptyState> : keys.length === 0 ? (
        <EmptyState>
          No addresses yet. {onGoto ? <button className="link-btn" onClick={() => onGoto("keys")}>Create or import a key</button> : "Create a key under Keys"} to get started.
        </EmptyState>
      ) : (
        <div className="receive-list">
          {keys.map((k) => (
            <article className="card receive-card" key={k.id}>
              <header className="card-head">
                <h3>{k.label}</h3>
                <Badge tone="gold">{k.kind === "btc" ? "Bitcoin mainnet" : account ? `Base · ${account.currency}` : "Base · ETH / USDC"}</Badge>
              </header>
              <code className="receive-address">{k.address}</code>
              <footer className="card-foot receive-foot">
                <CopyButton text={k.address} label="Copy address" big />
                <span className="card-asof">since {formatDate(k.created_at)}</span>
              </footer>
              {onGoto && <div className="btn-row journey-actions">
                <button className="link-btn" onClick={() => onGoto("accounts", account ? { accountId: account.id } : { keyId: k.id })}>{account ? "View account" : "Use in an account"}</button>
                {account && <button className="link-btn" onClick={() => onGoto("ledger", { accountId: account.id })}>View activity</button>}
              </div>}
              {k.kind === "btc" && (
                <p className="receive-note">
                  One Bitcoin address, in the open: anyone you pay or share it
                  with can read its full balance and history on the public
                  chain. Sharing it can't move your money — only reveal it.
                </p>
              )}
            </article>
          ))}
          <p className="receive-note">
            Match the asset and network before sending. Sharing a public address can reveal its balance and history; it does not grant signing access.
          </p>
        </div>
      )}
    </div>
  );
}
