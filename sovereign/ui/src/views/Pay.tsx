import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import { EmptyState, Field, LoadingThreads, SectionTitle } from "../components";
import {
  PaymentActivity,
  paymentHasFinalizedConsensus,
} from "../components/PaymentActivity";
import { QuoteFeeTerms } from "../components/QuoteFeeTerms";
import {
  ASSET_DECIMALS,
  formatMinor,
  formatMinorCompact,
  parseToMinor,
} from "../format";
import {
  LIVE_CRYPTO_IDENTITIES,
  type Account,
  type ConfirmResult,
  type LiveCryptoIdentity,
  type PaymentListItem,
  type PaymentReconcileResult,
  type PaymentTruth,
  type Quote,
  type VaultKey,
} from "../types";

const ASSETS = ["ETH", "USDC", "BTC"] as const;
export type Asset = (typeof ASSETS)[number];

export function baseReconciliationNotice(
  truth: PaymentTruth,
  check?: PaymentReconcileResult["check"],
): { kind: "status" | "alert"; text: string } {
  if (check?.available_providers === "0") {
    return {
      kind: "alert",
      text: "Base check reached no evidence provider. Prior local truth is unchanged; try again later.",
    };
  }
  return {
    kind: "status",
    text: paymentHasFinalizedConsensus(truth)
      ? "Base check complete. Finalized evidence is recorded."
      : "Base check complete. The available provider evidence is recorded; CashLoom has not reached finalized consensus yet.",
  };
}

const LIVE_IDENTITY_BY_ASSET: Record<Asset, LiveCryptoIdentity> = {
  ETH: LIVE_CRYPTO_IDENTITIES.BASE_ETH,
  USDC: LIVE_CRYPTO_IDENTITIES.BASE_USDC,
  BTC: LIVE_CRYPTO_IDENTITIES.BITCOIN_BTC,
};

// Loose client-side shape check only — quote() is the authoritative
// validator (btc-signer decodes and refuses testnet/mixed-case/bad checksums).
const BTC_ADDR_SHAPE = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

export function isLegacyMappedBitcoinAccount(account: Account): boolean {
  return (
    account.chain_id === null &&
    account.asset_id === null &&
    account.account_ref === null &&
    account.connector_type?.toLowerCase() === "esplora"
  );
}

/** Pure UI projection of pay.ts's account-routing eligibility boundary. */
export function isLiveSendingAccount(
  account: Account,
  asset: Asset,
  keyById: ReadonlyMap<string, VaultKey>,
): boolean {
  if (
    account.rail !== "CRYPTO" ||
    account.status.toUpperCase() !== "ACTIVE" ||
    !account.vault_key_id
  ) {
    return false;
  }
  const identity = LIVE_IDENTITY_BY_ASSET[asset];
  const key = keyById.get(account.vault_key_id);
  if (!key || key.kind !== identity.keyKind) return false;

  const address = identity.keyKind === "evm" ? key.address.toLowerCase() : key.address;
  const validAddress =
    identity.keyKind === "evm"
      ? /^0x[0-9a-f]{40}$/.test(address)
      : BTC_ADDR_SHAPE.test(address);
  if (!validAddress) return false;

  if (
    account.currency.trim().toUpperCase() !== identity.currency ||
    account.decimals !== identity.decimals
  ) {
    return false;
  }

  const connector = account.connector_type?.toLowerCase();
  if (connector === "esplora" && account.external_account_id !== address) {
    return false;
  }

  if (asset === "BTC") {
    const explicitIdentity =
      account.chain_id === identity.chain_id &&
      account.asset_id === identity.asset_id &&
      account.account_ref === `${identity.chain_id}:${address}`;
    const legacyIdentity =
      isLegacyMappedBitcoinAccount(account) &&
      account.external_account_id === address;
    return explicitIdentity || legacyIdentity;
  }

  if (account.connector_type?.toLowerCase() === "alchemy") return false;
  return (
    account.chain_id === identity.chain_id &&
    account.asset_id?.toLowerCase() === identity.asset_id &&
    account.account_ref?.toLowerCase() === `${identity.chain_id}:${address}`
  );
}

const explorerFor = (asset: Asset, tx: string) =>
  asset === "BTC"
    ? { href: `https://mempool.space/tx/${tx}`, label: "View on mempool.space ↗" }
    : { href: `https://basescan.org/tx/${tx}`, label: "View on Basescan ↗" };

const networkNameFor = (asset: Asset): string =>
  asset === "BTC" ? "the Bitcoin network" : "Base";

type Stage =
  | { step: "form" }
  | { step: "quoted"; quote: Quote; quotedAt: number }
  | { step: "confirming"; quote: Quote }
  | { step: "done"; result: ConfirmResult };

function decimalsFor(asset: Asset, account: Account | undefined): number {
  if (account) return account.decimals;
  return ASSET_DECIMALS[asset] ?? 18;
}

export function Pay() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentListItem[] | null>(null);
  const [paymentsErr, setPaymentsErr] = useState<string | null>(null);
  const [checkingPaymentId, setCheckingPaymentId] = useState<string | null>(null);
  const [activityNotice, setActivityNotice] = useState<{
    kind: "status" | "alert";
    text: string;
  } | null>(null);

  const [accountId, setAccountId] = useState("");
  const [to, setTo] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [asset, setAsset] = useState<Asset>("ETH");

  const [stage, setStage] = useState<Stage>({ step: "form" });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [r, k] = await Promise.all([api.accounts(), api.keys()]);
        if (!live) return;
        setAccounts(r.accounts);
        setKeys(k.keys);
        const keyById = new Map(k.keys.map((key) => [key.id, key]));
        const first = r.accounts.find((candidate) => {
          if (!(ASSETS as readonly string[]).includes(candidate.currency)) return false;
          return isLiveSendingAccount(candidate, candidate.currency as Asset, keyById);
        });
        if (first) {
          setAccountId(first.id);
          if ((ASSETS as readonly string[]).includes(first.currency)) {
            setAsset(first.currency as Asset);
          }
        }
      } catch (ex) {
        if (live) setLoadErr(errorMessage(ex));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Recent records are local projections. Loading them independently keeps a
  // slow account connector from hiding payment truth after a refresh.
  useEffect(() => {
    let live = true;
    void api.payments().then(
      (result) => {
        if (!live) return;
        setPayments(result.payments);
        setPaymentsErr(null);
      },
      (ex: unknown) => {
        if (live) setPaymentsErr(errorMessage(ex));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // Countdown clock while a quote is on the table.
  useEffect(() => {
    if (stage.step !== "quoted") return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [stage.step]);

  // Eligibility mirrors the kernel's exact routing boundary: asset position,
  // chain, account address and key kind must all agree before it appears here.
  const keyById = useMemo(() => new Map(keys.map((key) => [key.id, key])), [keys]);
  const eligible = useMemo(
    () =>
      (accounts ?? []).filter((candidate) =>
        isLiveSendingAccount(candidate, asset, keyById),
      ),
    [accounts, keyById, asset],
  );
  const account = eligible.find((a) => a.id === accountId);
  const decimals = decimalsFor(asset, account);
  const minor = parseToMinor(amountStr, decimals);

  // Switching asset can strand the picker on an account that can't sign it.
  useEffect(() => {
    if (!eligible.some((a) => a.id === accountId) && eligible.length > 0) {
      setAccountId(eligible[0].id);
    } else if (eligible.length === 0 && accountId !== "") {
      setAccountId("");
    }
  }, [asset, eligible, accountId]);

  async function requestQuote(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setFormErr(null);
    if (!account) {
      setFormErr("Pick the account that will sign.");
      return;
    }
    let dest = to.trim();
    if (asset === "BTC") {
      // BIP-173 QR codes render bech32 ALL-UPPERCASE — normalize that form
      // to canonical lowercase (mixed case stays refused, as the spec says).
      if (/^BC1/.test(dest) && dest === dest.toUpperCase()) dest = dest.toLowerCase();
      if (!BTC_ADDR_SHAPE.test(dest)) {
        setFormErr("Destination should be a Bitcoin address — bech32 (bc1…) or legacy base58.");
        return;
      }
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) {
      setFormErr("Destination should be a 0x address — 40 hex characters after the 0x.");
      return;
    }
    if (!minor || minor === "0") {
      setFormErr(
        amountStr.trim() === ""
          ? "How much? Plain decimals — e.g. 0.05."
          : `That amount doesn't parse at ${decimals} decimals. Plain digits and one dot.`,
      );
      return;
    }
    setBusy(true);
    try {
      const quote = await api.payQuote({
        accountId: account.id,
        to: dest,
        amountMinor: minor,
        asset,
      });
      setStage({ step: "quoted", quote, quotedAt: Date.now() });
      setNow(Date.now());
    } catch (ex) {
      setFormErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(quote: Quote) {
    setStage({ step: "confirming", quote });
    try {
      const result = await api.payConfirm(quote.paymentId);
      setStage({ step: "done", result });
    } catch (ex) {
      setStage({
        step: "done",
        result: {
          paymentId: quote.paymentId,
          status: "failed",
          txHash: null,
          error: errorMessage(ex),
        },
      });
    } finally {
      void refreshPayments();
    }
  }

  async function refreshPayments(): Promise<void> {
    try {
      const result = await api.payments();
      setPayments(result.payments);
      setPaymentsErr(null);
    } catch (ex) {
      setPaymentsErr(errorMessage(ex));
    }
  }

  async function reconcile(payment: PaymentListItem): Promise<void> {
    setCheckingPaymentId(payment.id);
    setActivityNotice(null);
    try {
      const response = await api.reconcileBasePayment(payment.id);
      const truth: PaymentTruth = "truth" in response ? response.truth : response;
      const check = "truth" in response ? response.check : undefined;
      setPayments((current) =>
        current?.map((candidate) =>
          candidate.id === payment.id ? { ...candidate, truth } : candidate,
        ) ?? null,
      );
      setActivityNotice(baseReconciliationNotice(truth, check));
      // Re-read the local projection so lifecycle and legacy status changes
      // committed by reconciliation arrive alongside the returned truth.
      await refreshPayments();
    } catch (ex) {
      setActivityNotice({ kind: "alert", text: `Base check unavailable: ${errorMessage(ex)}` });
    } finally {
      setCheckingPaymentId(null);
    }
  }

  function reset() {
    setStage({ step: "form" });
    setAmountStr("");
    setTo("");
    setFormErr(null);
  }

  const activity = (
    <PaymentActivity
      payments={payments}
      error={paymentsErr}
      checkingId={checkingPaymentId}
      notice={activityNotice}
      onReconcile={(payment) => void reconcile(payment)}
    />
  );

  if (loadErr) {
    return (
      <div className="stagger">
        <SectionTitle>Pay</SectionTitle>
        <EmptyState>{loadErr}</EmptyState>
        {activity}
      </div>
    );
  }
  if (!accounts) {
    return (
      <div className="stagger">
        <SectionTitle>Pay</SectionTitle>
        <LoadingThreads />
        {activity}
      </div>
    );
  }

  // Only bail out entirely when NOTHING can sign — if the mismatch is just
  // the chosen asset (evm key, BTC picked), keep the form so the asset
  // switcher stays reachable.
  const anyLiveSending = ASSETS.some((candidateAsset) =>
    accounts.some((candidate) => isLiveSendingAccount(candidate, candidateAsset, keyById)),
  );
  if (!anyLiveSending) {
    return (
      <div className="stagger">
        <SectionTitle>Pay</SectionTitle>
        <EmptyState>
          Nothing here is an exact live sending position yet. Paying needs a
          Base ETH, Base USDC, or Bitcoin mainnet account whose CAIP identity
          and public address match its vault key. Add one under <strong>Accounts</strong>.
        </EmptyState>
        {activity}
      </div>
    );
  }

  /* ── done ── */
  if (stage.step === "done") {
    const r = stage.result;
    const ok = r.status === "broadcast";
    // 'confirmed' back from confirm = the broadcast went UNANSWERED. The tx
    // may be live; the one wrong move is quoting again before checking.
    const unknown = r.status === "confirmed";
    const explorer = r.txHash ? explorerFor(asset, r.txHash) : null;
    return (
      <div className="stagger">
        <SectionTitle>Pay</SectionTitle>
        <div className={`pay-result card ${ok ? "is-ok" : unknown ? "is-unknown" : "is-failed"}`}>
          <h3>{ok ? "Woven." : unknown ? "The network didn't answer." : "The thread didn't take."}</h3>
          {ok ? (
            <>
              <p className="pay-result-sub">
                Signed in your vault, broadcast to {networkNameFor(asset)}. Give it a
                moment to settle.
              </p>
              {r.txHash && explorer && (
                <div className="txhash-row">
                  <code className="txhash">{r.txHash}</code>
                  <a className="btn btn-ghost" href={explorer.href} target="_blank" rel="noreferrer">
                    {explorer.label}
                  </a>
                </div>
              )}
            </>
          ) : unknown ? (
            <>
              <p className="form-error pay-fail-msg">{r.error ?? "The broadcast went unanswered."}</p>
              <p className="pay-result-sub">
                The payment was signed, but the network never said yes or no — it may
                still go through. <strong>Check the transaction on-chain before you
                quote again</strong>; sending twice is the one mistake this screen
                exists to prevent.
              </p>
              {r.txHash && explorer && (
                <div className="txhash-row">
                  <code className="txhash">{r.txHash}</code>
                  <a className="btn btn-ghost" href={explorer.href} target="_blank" rel="noreferrer">
                    {explorer.label}
                  </a>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="form-error pay-fail-msg">{r.error ?? "The node reported a failure."}</p>
              <p className="pay-result-sub">
                Failed payments stay failed — CashLoom never retries on its own.
                Nothing moves twice without you. When you're ready, quote again.
              </p>
            </>
          )}
          <button className="btn btn-primary" onClick={reset}>
            Weave another payment
          </button>
        </div>
        {activity}
      </div>
    );
  }

  /* ── quoted / confirming ── */
  if (stage.step === "quoted" || stage.step === "confirming") {
    const quote = stage.quote;
    const confirming = stage.step === "confirming";
    const expiresMs = Date.parse(quote.expiresAt);
    const hasClock = !Number.isNaN(expiresMs);
    const remaining = hasClock ? Math.max(0, expiresMs - now) : null;
    const expired = remaining !== null && remaining <= 0 && !confirming;
    const total =
      hasClock && stage.step === "quoted"
        ? Math.max(1, expiresMs - stage.quotedAt)
        : 1;
    const fraction =
      remaining !== null && stage.step === "quoted"
        ? Math.min(1, remaining / total)
        : 1;
    const secs = remaining !== null ? Math.ceil(remaining / 1000) : null;
    const feeDecimals = ASSET_DECIMALS[quote.feeAsset] ?? decimals;

    return (
      <div className="stagger">
        <SectionTitle>Pay · read before you sign</SectionTitle>
        <div className="card pay-quote">
          <div className="disclosure">
            <span className="disclosure-label">The fee, disclosed</span>
            <blockquote>{quote.summary}</blockquote>
          </div>

          <dl className="quote-facts">
            <div>
              <dt>{quote.feeTerms ? "Estimated network fee" : "Network fee"}</dt>
              <dd>
                <span className="amt">
                  {formatMinorCompact(quote.feeMinor, feeDecimals)} {quote.feeAsset}
                </span>
              </dd>
            </div>
            <div>
              <dt>CashLoom's cut</dt>
              <dd className="fee-zero">Nothing. Pass-through only, ever.</dd>
            </div>
          </dl>

          {quote.feeTerms && (
            <QuoteFeeTerms
              terms={quote.feeTerms}
              feeAsset={quote.feeAsset}
              feeDecimals={feeDecimals}
            />
          )}

          {hasClock && (
            <div className={`quote-clock${expired ? " is-expired" : ""}`}>
              <div className="quote-clock-bar">
                <span style={{ width: `${fraction * 100}%` }} />
              </div>
              <span className="quote-clock-text">
                {confirming
                  ? "Held for signing"
                  : expired
                    ? "This quote has lapsed — prices move, your money shouldn't guess."
                    : `Quote holds for ${secs}s`}
              </span>
            </div>
          )}

          <div className="btn-row">
            {expired ? (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void requestQuote()}
              >
                {busy ? "Re-quoting…" : "Ask for a fresh quote"}
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sign"
                disabled={confirming}
                onClick={() => void confirm(quote)}
              >
                {confirming ? "Signing in your vault…" : "Sign & broadcast"}
              </button>
            )}
            <button className="btn btn-ghost" disabled={confirming} onClick={() => setStage({ step: "form" })}>
              Back
            </button>
          </div>
          {confirming && (
            <p className="pay-confirming-note">
              Signing locally, broadcasting to {networkNameFor(asset)}. Don't close the tab.
            </p>
          )}
        </div>
        {activity}
      </div>
    );
  }

  /* ── form ── */
  return (
    <div className="stagger">
      <SectionTitle>Pay</SectionTitle>
      <form className="card pay-form" onSubmit={(e) => void requestQuote(e)}>
        <Field
          label="From"
          hint={
            eligible.length === 0
              ? `No account exactly matches the live ${LIVE_IDENTITY_BY_ASSET[asset].networkLabel} ${asset} identity and its vault key.`
              : "Only an exact asset, chain, account-address and vault-key match appears here."
          }
        >
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {eligible.length === 0 && <option value="">no eligible account</option>}
            {eligible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name} · {formatMinor(a.balance_minor, a.decimals)} {a.currency} · {a.chain_id ?? "Bitcoin mainnet"}
                {isLegacyMappedBitcoinAccount(a) ? " · legacy mapped" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="To"
          hint={
            asset === "BTC"
              ? "A Bitcoin address — bech32 (bc1…) or legacy. Check the first and last characters — always."
              : "A 0x address on Base. Check the first and last characters — always."
          }
        >
          <input
            className="mono-input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={asset === "BTC" ? "bc1…" : "0x…"}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <div className="field-row">
          <Field
            label="Amount"
            hint={
              minor
                ? `= ${minor} minor units at ${decimals} decimals`
                : `Plain decimals, up to ${decimals} places.`
            }
          >
            <input
              className="mono-input amt-input"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field label="Asset">
            <div className="segmented" role="radiogroup" aria-label="Asset">
              {ASSETS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={asset === a ? "is-active" : ""}
                  onClick={() => setAsset(a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </Field>
        </div>

        {formErr && <p className="form-error">{formErr}</p>}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Asking the network…" : "Quote this payment"}
          </button>
          <span className="pay-note">
            You'll see the full fee, in writing, before anything is signed.
          </span>
        </div>
      </form>
      {activity}
    </div>
  );
}
