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
import type { VaultKey } from "../types";

/**
 * Addresses are public by design — share them freely.
 * (No QR: a proper generator needs a dependency, and this UI carries none.)
 */
export function Receive() {
  const [keys, setKeys] = useState<VaultKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await api.keys();
        if (live) setKeys(r.keys);
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
      <SectionTitle aside="Everyone pays everyone — this is your end of the thread.">
        Receive
      </SectionTitle>

      {keys.length === 0 ? (
        <EmptyState>
          No addresses yet. Weave a key under <strong>Keys</strong> and it will
          appear here, ready to be paid.
        </EmptyState>
      ) : (
        <div className="receive-list">
          {keys.map((k) => (
            <article className="card receive-card" key={k.id}>
              <header className="card-head">
                <h3>{k.label}</h3>
                <Badge tone="gold">{k.kind}</Badge>
              </header>
              <code className="receive-address">{k.address}</code>
              <footer className="card-foot receive-foot">
                <CopyButton text={k.address} label="Copy address" big />
                <span className="card-asof">since {formatDate(k.created_at)}</span>
              </footer>
            </article>
          ))}
          <p className="receive-note">
            An address is safe to share — it can only ever receive.
          </p>
        </div>
      )}
    </div>
  );
}
