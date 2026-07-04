import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import {
  Badge,
  CopyButton,
  EmptyState,
  Field,
  LoadingThreads,
  SectionTitle,
} from "../components";
import { formatDate } from "../format";
import { toast } from "../toast";
import type { VaultKey } from "../types";

export function Keys() {
  const [keys, setKeys] = useState<VaultKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [genLabel, setGenLabel] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);

  const [impLabel, setImpLabel] = useState("");
  const [impHex, setImpHex] = useState("");
  const [impBusy, setImpBusy] = useState(false);
  const [impErr, setImpErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.keys();
      setKeys(r.keys);
    } catch (ex) {
      setErr(errorMessage(ex));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setGenErr(null);
    if (!genLabel.trim()) {
      setGenErr("Name the key — you'll thank yourself later.");
      return;
    }
    setGenBusy(true);
    try {
      const r = await api.createKey({ label: genLabel.trim(), action: "generate" });
      toast(`Key "${r.key.label}" woven. It lives only in your vault.`, "ok");
      setGenLabel("");
      await load();
    } catch (ex) {
      setGenErr(errorMessage(ex));
    } finally {
      setGenBusy(false);
    }
  }

  async function importKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setImpErr(null);
    const hex = impHex.trim();
    // The private key is cleared from this form on submit, success or not.
    // It is never logged, never echoed back.
    if (!impLabel.trim()) {
      setImpErr("Name the key first.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
      setImpHex("");
      setImpErr("A private key is 0x followed by exactly 64 hex characters. The field was cleared — paste it fresh.");
      return;
    }
    setImpBusy(true);
    setImpHex("");
    try {
      const r = await api.createKey({
        label: impLabel.trim(),
        action: "import",
        privHex: hex,
      });
      toast(`Key "${r.key.label}" imported and sealed in the vault.`, "ok");
      setImpLabel("");
      await load();
    } catch (ex) {
      setImpErr(errorMessage(ex));
    } finally {
      setImpBusy(false);
    }
  }

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!keys) return <LoadingThreads />;

  return (
    <div className="stagger">
      <SectionTitle aside="Sealed by your passphrase. They never leave this machine.">
        Keys
      </SectionTitle>

      {keys.length === 0 ? (
        <EmptyState>
          The vault is empty. Weave a fresh key below, or bring one you already
          hold.
        </EmptyState>
      ) : (
        <div className="key-rows">
          {keys.map((k) => (
            <article className="card key-row" key={k.id}>
              <div className="key-row-main">
                <h3>{k.label}</h3>
                <Badge tone="gold">{k.kind}</Badge>
                <span className="card-asof">since {formatDate(k.created_at)}</span>
              </div>
              <div className="key-row-addr">
                <code>{k.address}</code>
                <CopyButton text={k.address} />
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="key-forms">
        <form className="card key-form" onSubmit={(e) => void generate(e)}>
          <h3>Weave a new key</h3>
          <p className="key-form-sub">
            Generated inside your node, encrypted at rest, shown to no one.
          </p>
          <Field label="Label">
            <input
              value={genLabel}
              onChange={(e) => setGenLabel(e.target.value)}
              placeholder="e.g. hot wallet, savings"
            />
          </Field>
          {genErr && <p className="form-error">{genErr}</p>}
          <button className="btn btn-primary" type="submit" disabled={genBusy}>
            {genBusy ? "Weaving…" : "Generate key"}
          </button>
        </form>

        <form className="card key-form" onSubmit={(e) => void importKey(e)}>
          <h3>Bring your own</h3>
          <p className="key-form-sub">
            Paste only here. It travels once, over localhost, into the vault —
            then this field is wiped. It is never logged.
          </p>
          <Field label="Label">
            <input
              value={impLabel}
              onChange={(e) => setImpLabel(e.target.value)}
              placeholder="e.g. old MetaMask key"
            />
          </Field>
          <Field label="Private key" hint="0x + 64 hex characters.">
            <input
              className="mono-input"
              type="password"
              value={impHex}
              onChange={(e) => setImpHex(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {impErr && <p className="form-error">{impErr}</p>}
          <button className="btn btn-primary" type="submit" disabled={impBusy}>
            {impBusy ? "Sealing…" : "Import key"}
          </button>
        </form>
      </div>
    </div>
  );
}
