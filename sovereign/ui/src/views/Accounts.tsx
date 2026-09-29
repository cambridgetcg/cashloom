import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, currentSessionGuard, errorMessage } from "../api";
import {
  Amount,
  Badge,
  EmptyState,
  Field,
  LoadingThreads,
  RailBadge,
  SectionTitle,
} from "../components";
import { formatDateTime, formatMinor, parseToMinor, shortAddress } from "../format";
import { toast } from "../toast";
import type { WalletNavigate } from "../navigation";
import { isLiveSendingAccount, type Asset } from "./Pay";
import { AccountBalances } from "../components/AccountBalances";
import { WatchedWalletDetails, watchedBaseAddress } from "./WatchWallet";
import {
  BasePositionPanel,
  isObservableBaseAccount,
} from "../components/BasePositionPanel";
import {
  LIVE_CRYPTO_IDENTITIES,
  RAILS,
  type Account,
  type BaseAccountPositionView,
  type Caip10AccountId,
  type Caip19AssetId,
  type Caip2ChainId,
  type LiveCryptoAsset,
  type Rail,
  type VaultKey,
} from "../types";

const RAIL_DEFAULTS: Record<Rail, { currency: string; decimals: number }> = {
  STRIPE: { currency: "USD", decimals: 2 },
  BANK: { currency: "USD", decimals: 2 },
  CRYPTO: { currency: "ETH", decimals: 18 },
  CASH: { currency: "USD", decimals: 2 },
  PLATFORM_CREDIT: { currency: "USD", decimals: 2 },
  GIFT_CARD: { currency: "USD", decimals: 2 },
};

type CryptoChoice = LiveCryptoAsset | "ADVANCED";

interface AccountsLoadDependencies {
  accounts(): ReturnType<typeof api.accounts>;
  keys(): ReturnType<typeof api.keys>;
  walletPositions(): ReturnType<typeof api.walletPositions>;
}

interface AccountsLoadCallbacks {
  essentialsLoaded(accounts: Account[], keys: VaultKey[]): void;
  essentialsFailed(message: string): void;
  positionsLoaded(positions: BaseAccountPositionView[]): void;
  positionsFailed(message: string): void;
}

/**
 * Start required account/key hydration and optional chain-position hydration
 * as separate work. A slow or unavailable observer projection must never hold
 * the ordinary account ledger page behind its request.
 */
export function beginAccountsLoad(
  dependencies: AccountsLoadDependencies,
  callbacks: AccountsLoadCallbacks,
): { essentials: Promise<void>; positions: Promise<void> } {
  const essentials = Promise.all([
    dependencies.accounts(),
    dependencies.keys(),
  ]).then(
    ([accountResult, keyResult]) => {
      callbacks.essentialsLoaded(accountResult.accounts, keyResult.keys);
    },
    (error: unknown) => {
      callbacks.essentialsFailed(errorMessage(error));
    },
  );

  const positions = dependencies.walletPositions().then(
    (result) => {
      callbacks.positionsLoaded(
        Array.isArray(result.base_accounts) ? result.base_accounts : [],
      );
    },
    (error: unknown) => {
      callbacks.positionsFailed(errorMessage(error));
    },
  );

  return { essentials, positions };
}

export function updateRefreshingAccounts(
  current: ReadonlySet<string>,
  accountId: string,
  refreshing: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (refreshing) next.add(accountId);
  else next.delete(accountId);
  return next;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BITCOIN_MAINNET_ADDRESS =
  /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
const CAIP_2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const CAIP_10 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;
const CAIP_19 =
  /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}(?:\/[-.%a-zA-Z0-9]{1,78})?$/;

function chainIdProblem(value: string): string | null {
  if (!CAIP_2.test(value)) return "Chain ID must be a CAIP-2 id, such as eip155:8453.";
  const [namespace, reference] = value.split(":", 2);
  if (namespace === "eip155" && !/^(?:0|[1-9]\d*)$/.test(reference ?? "")) {
    return "An eip155 chain reference must be a canonical unsigned number.";
  }
  if (namespace === "bip122" && !/^[0-9a-f]{32}$/.test(reference ?? "")) {
    return "A bip122 chain reference must be 32 lowercase hexadecimal characters.";
  }
  if (
    namespace === "solana" &&
    !/^[1-9A-HJ-NP-Za-km-z]{32}$/.test(reference ?? "")
  ) {
    return "A solana chain reference must be 32 base58 characters.";
  }
  return null;
}

function compactAccountAddress(account: Account): string | null {
  if (!account.chain_id || !account.account_ref) return null;
  const prefix = `${account.chain_id}:`;
  return account.account_ref.startsWith(prefix)
    ? shortAddress(account.account_ref.slice(prefix.length))
    : null;
}

export const canRecordManualBalance = (account: Account): boolean =>
  account.status.toUpperCase() === "ACTIVE" &&
  !account.read_connection_id &&
  ["CASH", "BANK", "STRIPE", "PLATFORM_CREDIT", "GIFT_CARD"].includes(account.rail) &&
  (account.connector_type === null || account.connector_type === "");

export const canArchiveAccount = (account: Account): boolean =>
  account.connector_type !== "plaid" || account.read_connection_status === "disconnected";

/** Parse the owner's balance without deriving it from transaction history. */
export function manualBalanceRequest(account: Account, input: string) {
  if (!canRecordManualBalance(account)) throw new Error("This account does not accept a manual balance.");
  const value = input.trim();
  const negative = value.startsWith("-");
  const absolute = parseToMinor(negative ? value.slice(1) : value, account.decimals);
  if (absolute === null) throw new Error(`Enter a balance with at most ${account.decimals} decimal places.`);
  const amount = negative && absolute !== "0" ? `-${absolute}` : absolute;
  if (amount.length > 120) throw new Error("That balance is too long to record.");
  return {
    balance_minor: amount,
    expected_balance_minor: account.balance_minor,
    expected_balance_as_of: account.balance_as_of,
  };
}

export function ManualBalanceEditor({ account, onSaved, onCancel }: {
  account: Account;
  onSaved(account: Account): void;
  onCancel(): void;
}) {
  const [snapshot, setSnapshot] = useState(account);
  const [amount, setAmount] = useState(account.balance_as_of ? formatMinor(account.balance_minor, account.decimals) : "");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || mustReload) return;
    setError(null);
    setNotice(null);
    try {
      const body = manualBalanceRequest(snapshot, amount);
      pending.current = true;
      setBusy(true);
      const result = await api.recordAccountBalance(snapshot.id, body);
      onSaved(result.account);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.code === "account_balance_conflict") setMustReload(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await api.accounts();
      const latest = result.accounts.find((candidate) => candidate.id === snapshot.id);
      if (!latest || !canRecordManualBalance(latest)) throw new Error("This account is no longer available for manual balances.");
      setSnapshot(latest);
      setMustReload(false);
      setError(null);
      setNotice("Saved balance reloaded. Your amount is still in the form; review it before recording.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="create-form" onSubmit={(event) => void record(event)} aria-label={`Record balance for ${account.display_name}`}>
      <p className="journey-note">Record what this account holds now. This saves a balance observation; it does not add an activity entry or move money.</p>
      <p className="journey-note">
        {snapshot.balance_as_of
          ? `Saved: ${formatMinor(snapshot.balance_minor, snapshot.decimals)} ${snapshot.currency} · ${formatDateTime(snapshot.balance_as_of)}`
          : "No balance recorded yet."}
      </p>
      <Field label={`Balance (${snapshot.currency})`} hint={`Up to ${snapshot.decimals} decimal places. Use a minus sign for a negative balance.`}>
        <input className="mono-input" inputMode="decimal" value={amount} maxLength={120}
          autoFocus disabled={busy} placeholder="e.g. 25.00" onChange={(event) => setAmount(event.target.value)} />
      </Field>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="journey-note" role="status">{notice}</p>}
      <div className="account-row-actions">
        <button className="btn btn-primary" disabled={busy || mustReload} type="submit">{busy ? "Working…" : "Record balance"}</button>
        {mustReload && <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => void reload()}>Reload saved balance</button>}
        <button className="btn btn-ghost" disabled={busy} type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A late local GET cannot replace evidence returned by a newer explicit check. */
export function mergeSavedBasePositions(previous: BaseAccountPositionView[], received: BaseAccountPositionView[], atRead: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>): BaseAccountPositionView[] {
  const newer = new Set([...current].filter(([id, revision]) => revision !== (atRead.get(id) ?? 0)).map(([id]) => id));
  return [...received.filter(view => !newer.has(view.account_id)), ...previous.filter(view => newer.has(view.account_id))];
}

export function Accounts({ initialAccountId, initialKeyId, onGoto }: { initialAccountId?: string; initialKeyId?: string; onGoto?: WalletNavigate } = {}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [basePositions, setBasePositions] = useState<BaseAccountPositionView[]>([]);
  const [baseLoadError, setBaseLoadError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const appliedInitialKey = useRef(false);
  const live = useRef(true);
  const [canManage, setCanManage] = useState(false);
  const [managementError, setManagementError] = useState(false);
  const baseObservationVersions = useRef(new Map<string, number>());

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
  const [cryptoChoice, setCryptoChoice] = useState<CryptoChoice>("BASE_ETH");
  const [advancedChainId, setAdvancedChainId] = useState("");
  const [advancedAssetId, setAdvancedAssetId] = useState("");
  const [advancedAccountRef, setAdvancedAccountRef] = useState("");
  const [esploraAutofilled, setEsploraAutofilled] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // row actions
  const [syncing, setSyncing] = useState<string | null>(null);
  const [refreshingBase, setRefreshingBase] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const refreshingBaseNow = useRef(new Set<string>());
  const [baseMessages, setBaseMessages] = useState<Record<string, string>>({});
  const [baseErrors, setBaseErrors] = useState<Record<string, string>>({});
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [balanceAccount, setBalanceAccount] = useState<Account | null>(null);

  async function load() {
    const generation = ++loadGeneration.current;
    const session = currentSessionGuard();
    const baseVersionsAtRead = new Map(baseObservationVersions.current);
    setErr(null);
    setBaseLoadError(null);
    const cycle = beginAccountsLoad(api, {
      essentialsLoaded(nextAccounts, nextKeys) {
        if (!live.current || !session() || loadGeneration.current !== generation) return;
        setAccounts(nextAccounts);
        setKeys(nextKeys);
      },
      essentialsFailed(message) {
        if (!live.current || !session() || loadGeneration.current !== generation) return;
        setErr(message);
      },
      positionsLoaded(positions) {
        if (!live.current || !session() || loadGeneration.current !== generation) return;
        setBasePositions(previous => mergeSavedBasePositions(previous, positions, baseVersionsAtRead, baseObservationVersions.current));
        setBaseLoadError(null);
      },
      positionsFailed(message) {
        if (!live.current || !session() || loadGeneration.current !== generation) return;
        setBaseLoadError(message);
      },
    });

    // The optional position promise handles its own rejection and continues in
    // the background. Callers waiting on load only wait for account essentials.
    void cycle.positions;
    await cycle.essentials;
  }

  useEffect(() => {
    live.current = true;
    const session = currentSessionGuard();
    void load();
    void api.connections().then(result => { if (live.current && session()) { setCanManage(result.can_manage === true); setManagementError(false); } }, () => { if (live.current && session()) { setCanManage(false); setManagementError(true); } });
    return () => { live.current = false; loadGeneration.current++; };
  }, []);

  useEffect(() => {
    if (!initialKeyId || !accounts || appliedInitialKey.current) return;
    appliedInitialKey.current = true;
    const key = keys.find((candidate) => candidate.id === initialKeyId);
    if (!key) { setFormErr("That key is no longer available. Choose a current key before creating an account."); return; }
    if (key.kind !== "evm" && key.kind !== "btc") { setFormErr("That key has no supported account preset. Choose a supported key or an explicit watch-only identity."); return; }
    const choice = key.kind === "btc" ? "BITCOIN_BTC" : "BASE_ETH";
    const preset = LIVE_CRYPTO_IDENTITIES[choice];
    setRail("CRYPTO");
    setCryptoChoice(choice);
    setCurrency(preset.currency);
    setDecimals(preset.decimals);
    setVaultKeyId(key.id);
    setDisplayName(`${key.label} · ${preset.label}`);
    if (key.kind === "btc") {
      setConnectorChoice("esplora"); setExternalId(key.address); setEsploraAutofilled(true);
    }
  }, [accounts, keys, initialKeyId]);

  function pickRail(r: Rail) {
    setRail(r);
    if (r === "CRYPTO") {
      const preset = LIVE_CRYPTO_IDENTITIES[cryptoChoice === "ADVANCED" ? "BASE_ETH" : cryptoChoice];
      if (cryptoChoice !== "ADVANCED") {
        setCurrency(preset.currency);
        setDecimals(preset.decimals);
      }
    } else {
      setCurrency(RAIL_DEFAULTS[r].currency);
      setDecimals(RAIL_DEFAULTS[r].decimals);
      setVaultKeyId("");
      if (esploraAutofilled) {
        setConnectorChoice("");
        setExternalId("");
        setEsploraAutofilled(false);
      }
    }
  }

  function chooseCryptoAsset(choice: CryptoChoice) {
    setCryptoChoice(choice);
    if (choice === "ADVANCED") {
      // Advanced identities are deliberately watch-only. A generic chain or
      // token must not acquire apparent signing support from an address guess.
      setVaultKeyId("");
      if (esploraAutofilled) {
        setConnectorChoice("");
        setExternalId("");
        setEsploraAutofilled(false);
      }
      return;
    }

    const preset = LIVE_CRYPTO_IDENTITIES[choice];
    setCurrency(preset.currency);
    setDecimals(preset.decimals);

    const selected = keys.find((key) => key.id === vaultKeyId);
    if (selected && selected.kind !== preset.keyKind) setVaultKeyId("");

    if (choice === "BITCOIN_BTC" && selected?.kind === "btc") {
      setConnectorChoice("esplora");
      setExternalId(selected.address);
      setCredentialRef("");
      setEsploraAutofilled(true);
    } else if (esploraAutofilled) {
      setConnectorChoice("");
      setExternalId("");
      setEsploraAutofilled(false);
    }
  }

  function chooseVaultKey(id: string) {
    setVaultKeyId(id);
    const key = keys.find((candidate) => candidate.id === id);
    if (cryptoChoice === "BITCOIN_BTC" && key?.kind === "btc") {
      setConnectorChoice("esplora");
      setExternalId(key.address);
      setCredentialRef("");
      setEsploraAutofilled(true);
    } else if (esploraAutofilled) {
      setConnectorChoice("");
      setExternalId("");
      setEsploraAutofilled(false);
    }
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
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      setFormErr("Decimals must be a whole number from 0 through 18.");
      return;
    }

    let cryptoIdentity:
      | {
          chain_id: Caip2ChainId;
          asset_id: Caip19AssetId;
          account_ref: Caip10AccountId;
        }
      | undefined;

    if (rail === "CRYPTO") {
      const selectedKey = keys.find((key) => key.id === vaultKeyId);
      if (cryptoChoice !== "ADVANCED") {
        const preset = LIVE_CRYPTO_IDENTITIES[cryptoChoice];
        if (!selectedKey) {
          setFormErr(
            `Select a ${preset.keyKind.toUpperCase()} vault key for ${preset.label}, or use Advanced / watch-only and enter the identities yourself.`,
          );
          return;
        }
        if (selectedKey.kind !== preset.keyKind) {
          setFormErr(`${preset.label} needs a ${preset.keyKind.toUpperCase()} vault key.`);
          return;
        }
        if (currency.trim().toUpperCase() !== preset.currency || decimals !== preset.decimals) {
          setFormErr(
            `${preset.label} is exactly ${preset.currency} with ${preset.decimals} decimals.`,
          );
          return;
        }
        const validAddress =
          preset.keyKind === "evm"
            ? EVM_ADDRESS.test(selectedKey.address)
            : BITCOIN_MAINNET_ADDRESS.test(selectedKey.address);
        if (!validAddress) {
          setFormErr(
            `The selected key does not expose a valid ${preset.networkLabel} mainnet address.`,
          );
          return;
        }
        if (connectorType === "esplora" && cryptoChoice !== "BITCOIN_BTC") {
          setFormErr("The Esplora connector watches Bitcoin addresses; it cannot sync a Base position.");
          return;
        }
        if (
          connectorType === "esplora" &&
          externalId.trim() &&
          externalId.trim() !== selectedKey.address
        ) {
          setFormErr("The Esplora watch address must be the selected Bitcoin key's address.");
          return;
        }
        const address =
          preset.keyKind === "evm" ? selectedKey.address.toLowerCase() : selectedKey.address;
        cryptoIdentity = {
          chain_id: preset.chain_id,
          asset_id: preset.asset_id,
          account_ref: `${preset.chain_id}:${address}` as Caip10AccountId,
        };
      } else {
        const chainId = advancedChainId.trim();
        const assetId = advancedAssetId.trim();
        const accountRef = advancedAccountRef.trim();
        const chainProblem = chainIdProblem(chainId);
        if (chainProblem) {
          setFormErr(chainProblem);
          return;
        }
        if (!CAIP_19.test(assetId) || !assetId.startsWith(`${chainId}/`)) {
          setFormErr("Asset ID must be a CAIP-19 id on the exact chain above.");
          return;
        }
        if (!CAIP_10.test(accountRef) || !accountRef.startsWith(`${chainId}:`)) {
          setFormErr("Account ID must be a CAIP-10 id on the exact chain above.");
          return;
        }
        cryptoIdentity = {
          chain_id: chainId as Caip2ChainId,
          asset_id: assetId as Caip19AssetId,
          account_ref: accountRef as Caip10AccountId,
        };
      }
    }

    const common = {
      display_name: displayName.trim(),
      currency: currency.trim().toUpperCase(),
      decimals,
      ...(connectorType ? { connector_type: connectorType } : {}),
      ...(connectorType && externalId.trim()
        ? { external_account_id: externalId.trim() }
        : {}),
      // Esplora is a public indexer and must never receive a credential ref.
      ...(connectorType && connectorType !== "esplora" && credentialRef.trim()
        ? { credential_ref: credentialRef.trim() }
        : {}),
    };

    setCreating(true);
    try {
      if (rail === "CRYPTO") {
        // cryptoIdentity is established by the validated branch above.
        await api.createAccount({
          rail: "CRYPTO",
          ...common,
          ...cryptoIdentity!,
          ...(vaultKeyId ? { vault_key_id: vaultKeyId } : {}),
        });
      } else {
        await api.createAccount({ rail, ...common });
      }
      toast(`"${displayName.trim()}" added to your accounts.`, "ok");
      setDisplayName("");
      setExternalId("");
      setCredentialRef("");
      setConnectorChoice("");
      setConnectorCustom("");
      setVaultKeyId("");
      setAdvancedChainId("");
      setAdvancedAssetId("");
      setAdvancedAccountRef("");
      setEsploraAutofilled(false);
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
    if (!canArchiveAccount(a)) return;
    if (confirmArchive !== a.id) {
      setConfirmArchive(a.id);
      window.setTimeout(() => setConfirmArchive((c) => (c === a.id ? null : c)), 4000);
      return;
    }
    setConfirmArchive(null);
    try {
      await api.archiveAccount(a.id);
      toast(`${a.display_name} archived. Its history stays in Activity.`, "info");
      await load();
    } catch (ex) {
      toast(errorMessage(ex), "err");
    }
  }

  async function refreshBasePositions(account: Account) {
    const session = currentSessionGuard();
    if (!live.current || !session() || refreshingBaseNow.current.has(account.id) || watchedBaseAddress(account) !== null && !canManage) return;
    refreshingBaseNow.current.add(account.id);
    setRefreshingBase((current) =>
      updateRefreshingAccounts(current, account.id, true)
    );
    setBaseErrors((current) => ({ ...current, [account.id]: "" }));
    setBaseMessages((current) => ({ ...current, [account.id]: "" }));
    try {
      const result = await api.refreshBasePositions(account.id);
      if (!live.current || !session()) return;
      baseObservationVersions.current.set(account.id, (baseObservationVersions.current.get(account.id) ?? 0) + 1);
      setBasePositions((current) => {
        const remaining = current.filter((entry) => entry.account_id !== account.id);
        return [...remaining, result.account];
      });
      const message = result.outcome === "partial"
        ? "The providers did not agree or one was unavailable. The last finalized snapshot, if any, was retained."
        : result.outcome === "conflict"
          ? "A same-height conflict froze this position until it can be reviewed."
          : result.outcome === "stale"
            ? "An older observation was retained as evidence but did not replace the newer snapshot."
            : result.outcome === "superseded"
              ? "A newer finalized block atomically replaced the previous saved snapshot."
            : result.outcome === "replayed"
              ? "The same finalized snapshot was re-proved; no balance was posted twice."
              : "Finalized Base balances updated from two-provider evidence.";
      setBaseMessages((current) => ({ ...current, [account.id]: message }));
    } catch (ex) {
      if (live.current && session()) setBaseErrors((current) => ({ ...current, [account.id]: `${errorMessage(ex)} Any previously loaded finalized snapshot remains visible.` }));
    } finally {
      refreshingBaseNow.current.delete(account.id);
      if (live.current && session()) setRefreshingBase((current) => updateRefreshingAccounts(current, account.id, false));
    }
  }

  if (err) return <EmptyState>{err}</EmptyState>;
  if (!accounts) return <LoadingThreads />;

  const keyById = new Map(keys.map((k) => [k.id, k]));
  const selectedVaultKey = vaultKeyId ? keyById.get(vaultKeyId) : undefined;
  const selectedPreset =
    cryptoChoice === "ADVANCED" ? null : LIVE_CRYPTO_IDENTITIES[cryptoChoice];
  const derivedAccountRef =
    selectedPreset &&
    selectedVaultKey &&
    selectedVaultKey.kind === selectedPreset.keyKind
      ? `${selectedPreset.chain_id}:${
          selectedPreset.keyKind === "evm"
            ? selectedVaultKey.address.toLowerCase()
            : selectedVaultKey.address
        }`
      : "";
  const selectableKeys = selectedPreset
    ? keys.filter((key) => key.kind === selectedPreset.keyKind)
    : [];
  const activeFirst = [...accounts].sort((a, b) =>
    a.id === initialAccountId ? -1 : b.id === initialAccountId ? 1
      : a.status === b.status ? 0 : a.status.toUpperCase() === "ARCHIVED" ? 1 : -1,
  );

  return (
    <div className="stagger">
      <SectionTitle aside={canManage && onGoto ? <button className="link-btn" onClick={() => onGoto("connections")}>Watch a wallet in Connections</button> : undefined}>Accounts</SectionTitle>
      <p className="journey-note">Keep a record of where your money lives. Add cash or a bank account manually, or use a configured connection to read a supported balance.</p>
      {initialAccountId && !accounts.some((account) => account.id === initialAccountId) && <p role="status">That account is no longer available. Your current accounts are below.</p>}

      {accounts.length === 0 ? (
        <EmptyState>
          Add your first account below. Start with the cash you have, a bank account,
          or a supported wallet. You can record a balance without connecting a service.
        </EmptyState>
      ) : (
        <div className="account-rows">
          {activeFirst.map((a) => {
            const archived = a.status.toUpperCase() === "ARCHIVED";
            const key = a.vault_key_id ? keyById.get(a.vault_key_id) : undefined;
            const baseView = basePositions.find((entry) => entry.account_id === a.id) ?? null;
            const watched = watchedBaseAddress(a) !== null;
            return (
              <article aria-label={a.display_name} className={`card account-row${archived ? " is-archived" : ""}${a.id === initialAccountId ? " is-selected" : ""}`} key={a.id}>
                <div className="account-row-main">
                  <div className="account-row-name">
                    <h3>{a.display_name}</h3>
                    <span className="account-row-badges">
                      <RailBadge rail={a.rail} />
                      {a.read_environment === "sandbox" && <Badge tone="gold">Sandbox • test accounts</Badge>}
                      {a.connector_type && <Badge tone="gold">{a.connector_type}</Badge>}
                      {key && (
                        <Badge tone="ember">key · {shortAddress(key.address)}</Badge>
                      )}
                      {a.chain_id && (
                        <Badge tone="dim">
                          <span
                            className="account-chain-id"
                            title={[a.asset_id, a.account_ref].filter(Boolean).join("\n")}
                          >
                            {a.chain_id} · {a.currency}
                            {compactAccountAddress(a)
                              ? ` · ${compactAccountAddress(a)}`
                              : ""}
                          </span>
                        </Badge>
                      )}
                      {archived && <Badge tone="dim">archived</Badge>}
                    </span>
                  </div>
                  <div className="account-row-balance">
                    {isObservableBaseAccount(a) || baseView?.status === "identity_invalid" ? <span className="journey-note">Finalized balances below</span> : a.read_connection_id ? <span className="journey-note">Observed values below</span> : a.balance_as_of === null ? <span className="journey-note">Balance not recorded</span> : <Amount
                      minor={a.balance_minor}
                      decimals={a.decimals}
                      currency={a.currency}
                      size="lg"
                    />}
                  </div>
                </div>
                {!isObservableBaseAccount(a) && baseView?.status !== "identity_invalid" && <AccountBalances account={a} />}
                {watched && <WatchedWalletDetails account={a} />}
                {watched && !canManage && <p className="journey-note">{managementError ? "Connection permissions could not be loaded. Reopen Accounts to retry." : "The workspace owner can check balances."}</p>}
                {!archived && (
                  <div className="account-row-actions">
                    {canRecordManualBalance(a) && <button className="btn btn-ghost" onClick={() => setBalanceAccount(a)}>Record balance</button>}
                    {onGoto && <>
                      {!watched && (["ETH", "USDC", "BTC"] as string[]).includes(a.currency.trim().toUpperCase()) && isLiveSendingAccount(a, a.currency.trim().toUpperCase() as Asset, keyById) && <>
                        <button className="btn btn-ghost" onClick={() => onGoto("pay", { accountId: a.id })}>Send money</button>
                        <button className="btn btn-ghost" onClick={() => onGoto("receive", { accountId: a.id })}>Receive money</button>
                      </>}
                      <button className="link-btn" onClick={() => onGoto("ledger", { accountId: a.id })}>{watched ? "Recorded activity" : "Activity"}</button>
                    </>}
                    {a.connector_type && !a.read_connection_id && (
                      <button
                        className="btn btn-ghost"
                        disabled={syncing === a.id}
                        onClick={() => void sync(a)}
                      >
                        {syncing === a.id ? "Syncing…" : "Sync"}
                      </button>
                    )}
                    {a.read_connection_id && onGoto && <button className="btn btn-ghost" onClick={() => onGoto("connections")}>Manage connection / sync</button>}
                    <button
                      className={`btn btn-ghost btn-danger-ghost${confirmArchive === a.id ? " is-arming" : ""}`}
                      disabled={!canArchiveAccount(a)}
                      onClick={() => void archive(a)}
                    >
                      {confirmArchive === a.id ? "Really archive?" : "Archive"}
                    </button>
                    {!canArchiveAccount(a) && <span className="journey-note">Disconnect this bank in Connections before archiving.</span>}
                  </div>
                )}
                {!archived && canRecordManualBalance(a) && a.balance_as_of && <p className="journey-note">Recorded balance · <time dateTime={a.balance_as_of}>{formatDateTime(a.balance_as_of)}</time></p>}
                {!archived && balanceAccount?.id === a.id && (
                  <ManualBalanceEditor account={balanceAccount} onCancel={() => setBalanceAccount(null)} onSaved={(saved) => {
                    setAccounts((current) => current?.map((entry) => entry.id === saved.id ? saved : entry) ?? null);
                    setBalanceAccount(null);
                    toast("Balance recorded. Your activity history is unchanged.", "ok");
                  }} />
                )}
                {!archived && (isObservableBaseAccount(a) || baseView?.status === "identity_invalid") && (
                  <BasePositionPanel
                    view={baseView}
                    refreshing={refreshingBase.has(a.id)}
                    message={baseMessages[a.id] ?? null}
                    error={baseErrors[a.id] ?? baseLoadError ?? null}
                    refreshLabel={watched ? "Check balances" : undefined}
                    actionDisabled={watched && !canManage}
                    onRefresh={() => void refreshBasePositions(a)}
                  />
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
              readOnly={rail === "CRYPTO" && cryptoChoice !== "ADVANCED"}
            />
          </Field>
          <Field label="Decimals" hint="Minor units per whole — 2 for cents, 18 for wei.">
            <input
              className="mono-input"
              type="number"
              min={0}
              max={18}
              value={decimals}
              readOnly={rail === "CRYPTO" && cryptoChoice !== "ADVANCED"}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 18) setDecimals(n);
              }}
            />
          </Field>
        </div>

        {rail === "CRYPTO" && (
          <Field
            label="Asset & network"
            hint="These live presets are exact and send-capable. Advanced identities are explicit and always watch-only."
          >
            <select
              value={cryptoChoice}
              onChange={(e) => chooseCryptoAsset(e.target.value as CryptoChoice)}
            >
              {(Object.keys(LIVE_CRYPTO_IDENTITIES) as LiveCryptoAsset[]).map((choice) => {
                const preset = LIVE_CRYPTO_IDENTITIES[choice];
                return (
                  <option key={choice} value={choice}>
                    {preset.label} · {preset.chain_id}
                  </option>
                );
              })}
              <option value="ADVANCED">advanced / watch-only · enter CAIP identities</option>
            </select>
          </Field>
        )}

        <Field
          label="Connector"
          hint="Optional. A connector lets the node pull balances and history itself."
        >
          <select
            value={connectorChoice}
            onChange={(e) => {
              const v = e.target.value;
              setConnectorChoice(v);
              setEsploraAutofilled(false);
              // keyless connector — drop any credential typed under an
              // earlier choice so it can't ride into the payload
              if (v === "esplora") setCredentialRef("");
            }}
          >
            <option value="">none — I'll keep this one by hand</option>
            <option value="agenttool">agenttool</option>
            <option value="esplora">esplora — watch a Bitcoin address</option>
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
                  : connectorType === "esplora"
                    ? "The Bitcoin address to watch — public chain data, no credential."
                    : "The account's id at the connector."
              }
            >
              <input
                className="mono-input"
                value={externalId}
                onChange={(e) => {
                  setExternalId(e.target.value);
                  setEsploraAutofilled(false);
                }}
                placeholder={
                  connectorType === "agenttool"
                    ? "wallet uuid"
                    : connectorType === "esplora"
                      ? "bc1…"
                      : "external id"
                }
                spellCheck={false}
              />
            </Field>
            {/* esplora is a KEYLESS public indexer — it refuses credentials,
                so don't offer the field at all. */}
            {connectorType !== "esplora" && (
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
            )}
          </div>
        )}

        {rail === "CRYPTO" && (
          <div className="crypto-identity-card">
            {selectedPreset ? (
              <Field
                label="Vault key"
                hint={
                  selectableKeys.length === 0
                    ? `No ${selectedPreset.keyKind.toUpperCase()} key exists yet. Create one under Keys, or use Advanced / watch-only.`
                    : `Required for this live preset. The ${selectedPreset.networkLabel} account identity is derived from its public address.`
                }
              >
                <select value={vaultKeyId} onChange={(e) => chooseVaultKey(e.target.value)}>
                  <option value="">
                    select a {selectedPreset.keyKind.toUpperCase()} key…
                  </option>
                  {selectableKeys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.label} ({key.kind}) · {shortAddress(key.address)}
                    </option>
                  ))}
                </select>
                {onGoto && <button type="button" className="link-btn" onClick={() => onGoto("keys")}>{selectableKeys.length ? "Manage keys" : "Create or import a key"}</button>}
              </Field>
            ) : (
              <Field
                label="Custody"
                hint="Advanced identities are deliberately watch-only. CashLoom will not imply signing support for an unrecognised chain or asset."
              >
                <input className="mono-input" value="watch only · no local signing key" readOnly />
              </Field>
            )}

            {selectedPreset ? (
              <div className="crypto-id-grid">
                <Field label="Chain ID" hint="CAIP-2 · fixed by the selected network.">
                  <input
                    className="mono-input"
                    value={selectedPreset.chain_id}
                    readOnly
                    spellCheck={false}
                  />
                </Field>
                <Field label="Asset ID" hint="CAIP-19 · the exact native asset or token contract.">
                  <input
                    className="mono-input"
                    value={selectedPreset.asset_id}
                    readOnly
                    spellCheck={false}
                  />
                </Field>
                <Field label="Account ID" hint="CAIP-10 · derived only after you select a compatible key.">
                  <input
                    className="mono-input"
                    value={derivedAccountRef}
                    placeholder={`select a ${selectedPreset.keyKind.toUpperCase()} key above`}
                    readOnly
                    spellCheck={false}
                  />
                </Field>
              </div>
            ) : (
              <div className="crypto-id-grid">
                <Field label="Chain ID" hint="CAIP-2 · explicit; an address never implies this.">
                  <input
                    className="mono-input"
                    value={advancedChainId}
                    onChange={(e) => setAdvancedChainId(e.target.value)}
                    placeholder="eip155:1"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Asset ID" hint="CAIP-19 · must belong to the chain above.">
                  <input
                    className="mono-input"
                    value={advancedAssetId}
                    onChange={(e) => setAdvancedAssetId(e.target.value)}
                    placeholder="eip155:1/slip44:60"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Account ID" hint="CAIP-10 · include the same chain and public address.">
                  <input
                    className="mono-input"
                    value={advancedAccountRef}
                    onChange={(e) => setAdvancedAccountRef(e.target.value)}
                    placeholder="eip155:1:0x…"
                    spellCheck={false}
                  />
                </Field>
              </div>
            )}
          </div>
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
