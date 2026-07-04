import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import {
  Amount,
  Badge,
  EmptyState,
  Field,
  LoadingThreads,
  RailBadge,
  SectionTitle,
} from "../components";
import { formatMinor, shortAddress } from "../format";
import { toast } from "../toast";
import { RAILS, type Account, type Rail, type VaultKey } from "../types";

const RAIL_DEFAULTS: Record<Rail, { currency: string; decimals: number }> = {
  STRIPE: { currency: "USD", decimals: 2 },
  BANK: { currency: "USD", decimals: 2 },
  CRYPTO: { currency: "ETH", decimals: 18 },
  CASH: { currency: "USD", decimals: 2 },
  PLATFORM_CREDIT: { currency: "USD", decimals: 2 },
  GIFT_CARD: { currency: "USD", decimals: 2 },
};

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // create form
  const [rail, setRail] = useState<Rail>("CASH");
  const [displayName, setDisplayName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [decimals, setDecimals] = useState(2);
  const [connectorChoice, setConnectorChoice] = useState("");
  const [connectorCustom, setConnectorCustom] = useState("");
  const [externalId, setExternalId] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [vaultKeyId, setVaultKeyId] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // row actions
  const [syncing, setSyncing] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  async function load() {
    try {
      const [a, k] = await Promise.all([api.accounts(), api.keys()]);
      setAccounts(a.accounts);
      setKeys(k.keys);
    } catch (ex) {
      setErr(errorMessage(ex));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function pickRail(r: Rail) {
    setRail(r);
    setCurrency(RAIL_DEFAULTS[r].currency);
    setDecimals(RAIL_DEFAULTS[r].decimals);
    if (r !== "CRYPTO") setVaultKeyId("");
  }

  const connectorType =
    connectorChoice === "custom" ? connectorCustom.trim() : connectorChoice;

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormErr(null);
    if (!displayName.trim()) {
      setFormErr("Give the account a name you'll recognise.");
      return;
    }
    if (!currency.trim()) {
      setFormErr("Currency is required — USD, ETH, whatever it holds.");
      return;
    }
    setCreating(true);
    try {
      await api.createAccount({
        rail,
        display_name: displayName.trim(),
        currency: currency.trim().toUpperCase(),
        decimals,
        ...(connectorType ? { connector_type: connectorType } : {}),
        ...(connectorType && externalId.trim()
          ? { external_account_id: externalId.trim() }
          : {}),
        ...(connectorType && credentialRef.trim()
          ? { credential_ref: credentialRef.trim() }
          : {}),
        ...(rail === "CRYPTO" && vaultKeyId ? { vault_key_id: vaultKeyId } : {}),
      });
      toast(`"${displayName.trim()}" is on the loom.`, "ok");
      setDisplayName("");
      setExternalId("");
      setCredentialRef("");
      setConnectorChoice("");
      setConnectorCustom("");
      setVaultKeyId("");
      await load();
    } catch (ex) {
      setFormErr(errorMessage(ex));
    } finally {
      setCreating(false);
    }
  }

  async function sync(a: Account) {
    setSyncing(a.id);
    try {
      const r = await api.syncAccount(a.id);
      toast(
        `${a.display_name} — balance ${formatMinor(r.balanceMinor, a.decimals)} ${a.currency} · ${r.imported} imported · ${r.skipped} skipped`,
        "ok",
      );
      await load();
    } catch (ex) {
      toast(errorMessage(ex), "err");
    } finally {
      setSyncing(null);
    }
  }

  async function archive(a: Account) {
    if (confirmArchive !== a.id) {
      setConfirmArchive(a.id);
      window.setTimeout(() => setConfirmArchive((c) => (c === a.id ? null : c)), 4000);
      return;
    }
    setConfirmArchive(null);
    try {
      await api.archiveAccount(a.id);
      toast(`${a.display_name} archived. Its history stays in the ledger.`, "info");
      await load();
    } catch (ex) {
      toast(errorMessage(ex), "err");
    }
  }

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!accounts) return <LoadingThreads />;

  const keyById = new Map(keys.map((k) => [k.id, k]));
  const activeFirst = [...accounts].sort((a, b) =>
    a.status === b.status ? 0 : a.status === "archived" ? 1 : -1,
  );

  return (
    <div className="stagger">
      <SectionTitle>Accounts</SectionTitle>

      {accounts.length === 0 ? (
        <EmptyState>
          Every thread starts somewhere. Add your first account below — the
          cash in your pocket is a perfectly good one.
        </EmptyState>
      ) : (
        <div className="account-rows">
          {activeFirst.map((a) => {
            const archived = a.status === "archived";
            const key = a.vault_key_id ? keyById.get(a.vault_key_id) : undefined;
            return (
              <article className={`card account-row${archived ? " is-archived" : ""}`} key={a.id}>
                <div className="account-row-main">
                  <div className="account-row-name">
                    <h3>{a.display_name}</h3>
                    <span className="account-row-badges">
                      <RailBadge rail={a.rail} />
                      {a.connector_type && <Badge tone="gold">{a.connector_type}</Badge>}
                      {key && (
                        <Badge tone="ember">key · {shortAddress(key.address)}</Badge>
                      )}
                      {archived && <Badge tone="dim">archived</Badge>}
                    </span>
                  </div>
                  <div className="account-row-balance">
                    <Amount
                      minor={a.balance_minor}
                      decimals={a.decimals}
                      currency={a.currency}
                      size="lg"
                    />
                  </div>
                </div>
                {!archived && (
                  <div className="account-row-actions">
                    {a.connector_type && (
                      <button
                        className="btn btn-ghost"
                        disabled={syncing === a.id}
                        onClick={() => void sync(a)}
                      >
                        {syncing === a.id ? "Syncing…" : "Sync"}
                      </button>
                    )}
                    <button
                      className={`btn btn-ghost btn-danger-ghost${confirmArchive === a.id ? " is-arming" : ""}`}
                      onClick={() => void archive(a)}
                    >
                      {confirmArchive === a.id ? "Really archive?" : "Archive"}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <SectionTitle>Add an account</SectionTitle>
      <form className="card create-form" onSubmit={(e) => void create(e)}>
        <Field label="Rail" hint="Where this money actually lives.">
          <div className="segmented segmented-wrap" role="radiogroup" aria-label="Rail">
            {RAILS.map((r) => (
              <button
                key={r}
                type="button"
                className={rail === r ? "is-active" : ""}
                onClick={() => pickRail(r)}
              >
                {r.replace(/_/g, " ").toLowerCase()}
              </button>
            ))}
          </div>
        </Field>

        <div className="field-row">
          <Field label="Name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Kitchen drawer, Base hot wallet"
            />
          </Field>
          <Field label="Currency">
            <input
              className="mono-input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              placeholder="USD"
              maxLength={12}
            />
          </Field>
          <Field label="Decimals" hint="Minor units per whole — 2 for cents, 18 for wei.">
            <input
              className="mono-input"
              type="number"
              min={0}
              max={18}
              value={decimals}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 18) setDecimals(n);
              }}
            />
          </Field>
        </div>

        <Field
          label="Connector"
          hint="Optional. A connector lets the node pull balances and history itself."
        >
          <select value={connectorChoice} onChange={(e) => setConnectorChoice(e.target.value)}>
            <option value="">none — I'll keep this one by hand</option>
            <option value="agenttool">agenttool</option>
            <option value="custom">other…</option>
          </select>
        </Field>

        {connectorChoice === "custom" && (
          <Field label="Connector type">
            <input
              className="mono-input"
              value={connectorCustom}
              onChange={(e) => setConnectorCustom(e.target.value)}
              placeholder="connector id, as your node knows it"
            />
          </Field>
        )}

        {connectorType !== "" && (
          <div className="field-row">
            <Field
              label="External account id"
              hint={
                connectorType === "agenttool"
                  ? "The agenttool wallet UUID this account mirrors."
                  : "The account's id at the connector."
              }
            >
              <input
                className="mono-input"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                placeholder={connectorType === "agenttool" ? "wallet uuid" : "external id"}
                spellCheck={false}
              />
            </Field>
            <Field
              label="Credential ref"
              hint={
                connectorType === "agenttool"
                  ? "The name of the credential your node holds — e.g. AGENTTOOL_API_KEY. Never the secret itself."
                  : "The name of the credential your node holds. Never the secret itself."
              }
            >
              <input
                className="mono-input"
                value={credentialRef}
                onChange={(e) => setCredentialRef(e.target.value)}
                placeholder={connectorType === "agenttool" ? "AGENTTOOL_API_KEY" : "CREDENTIAL_NAME"}
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        {rail === "CRYPTO" && (
          <Field
            label="Vault key"
            hint={
              keys.length === 0
                ? "No vault keys yet — weave one under Keys, then this account can sign."
                : "Bind a key and this account can pay, not just watch."
            }
          >
            <select value={vaultKeyId} onChange={(e) => setVaultKeyId(e.target.value)}>
              <option value="">watch only — no key</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} · {shortAddress(k.address)}
                </option>
              ))}
            </select>
          </Field>
        )}

        {formErr && <p className="form-error">{formErr}</p>}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? "Adding…" : "Add account"}
          </button>
        </div>
      </form>
    </div>
  );
}
