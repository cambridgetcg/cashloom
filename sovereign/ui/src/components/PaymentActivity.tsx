import { Badge, LoadingThreads } from "../components";
import { ASSET_DECIMALS, formatDateTime, formatMinorCompact, shortAddress } from "../format";
import type { PaymentListItem, PaymentTruth, PaymentTruthFee } from "../types";

export interface PaymentActivityState {
  label: string;
  detail: string;
  tone: "neutral" | "gold" | "ember" | "dim";
  kind:
    | "quoted"
    | "signed"
    | "broadcast"
    | "pending"
    | "finalized"
    | "reverted"
    | "ambiguous"
    | "failed";
}

const normalized = (value: string | null | undefined): string =>
  value?.trim().toLowerCase() ?? "";

/** A provider-reported FINALIZED tag is evidence, but it is not CashLoom's
 * terminal decision until the backend has recorded canonical, distinct-
 * provider quorum. Keep this check local too so a partial/older node response
 * cannot accidentally become terminal UI copy. */
export function paymentHasFinalizedConsensus(truth: PaymentTruth | null | undefined): boolean {
  const providerIds = truth?.evidence?.provider_ids ?? [];
  const quorumValue = truth?.evidence?.quorum;
  const quorum = typeof quorumValue === "number"
    ? quorumValue
    : typeof quorumValue === "string" && /^[1-9][0-9]*$/.test(quorumValue)
      ? Number(quorumValue)
      : Number.NaN;
  return normalized(truth?.security_level) === "finalized" &&
    normalized(truth?.canonicality) === "canonical" &&
    Number.isSafeInteger(quorum) &&
    quorum >= 2 &&
    new Set(providerIds).size >= quorum;
}

/**
 * Status wording is deliberately evidence-led. In particular, NOT_FOUND is
 * not projected as dropped: an absent receipt cannot prove non-inclusion.
 */
export function paymentActivityState(payment: PaymentListItem): PaymentActivityState {
  const truth = payment.truth;
  const visibility = normalized(truth?.visibility);
  const security = normalized(truth?.security_level);
  const result = normalized(truth?.execution_result);
  const canonicality = normalized(truth?.canonicality);
  const lifecycle = normalized(truth?.lifecycle_state ?? payment.intent_state);
  const legacy = normalized(truth?.legacy_status ?? payment.status);
  const finalizedByConsensus = paymentHasFinalizedConsensus(truth);

  if (canonicality === "reorged" || canonicality === "conflicted" || lifecycle === "ambiguous") {
    return {
      label: canonicality === "reorged" ? "Reorg observed · ambiguous" : "Ambiguous · verify first",
      detail: "Chain evidence is not settled. Do not create a replacement payment.",
      tone: "gold",
      kind: "ambiguous",
    };
  }
  if (finalizedByConsensus && result === "reverted") {
    return {
      label: "Finalized · reverted",
      detail: "The transfer failed on Base. Its network fee was still charged.",
      tone: "ember",
      kind: "reverted",
    };
  }
  if (finalizedByConsensus && result === "success") {
    return {
      label: "Finalized · succeeded",
      detail: "Two providers agree on finalized Base execution evidence.",
      tone: "neutral",
      kind: "finalized",
    };
  }
  if (security === "finalized" && visibility === "included") {
    return {
      label: result === "reverted"
        ? "Finalized reported · revert · quorum pending"
        : "Finalized reported · quorum pending",
      detail:
        "Provider evidence reports finalized inclusion, but CashLoom has not recorded the required two-provider consensus yet.",
      tone: result === "reverted" ? "ember" : "gold",
      kind: "pending",
    };
  }
  if (security === "safe" && visibility === "included") {
    return {
      label: result === "reverted" ? "Safe · revert observed" : "Safe · success observed",
      detail: "Included in Base's safe chain view; finality has not been observed yet.",
      tone: result === "reverted" ? "ember" : "gold",
      kind: "pending",
    };
  }
  if (visibility === "included") {
    return {
      label: result === "reverted" ? "Included · revert observed · unsafe" : "Included · unsafe",
      detail: "Included, but still below Base's safe/finalized boundary.",
      tone: result === "reverted" ? "ember" : "gold",
      kind: "pending",
    };
  }
  if (visibility === "mempool") {
    return {
      label: "Pending · seen in mempool",
      detail: "The signed transaction is visible but has not been included.",
      tone: "gold",
      kind: "pending",
    };
  }
  if (visibility === "not_found") {
    return {
      label: "Not found yet · outcome unknown",
      detail: "No receipt is not proof of a drop. Check again before any new payment.",
      tone: "gold",
      kind: "ambiguous",
    };
  }
  if (["signed"].includes(lifecycle) || legacy === "confirmed") {
    return {
      label: "Signed · network outcome unknown",
      detail: "Exact signed bytes are durable. Verify Base before sending anything again.",
      tone: "gold",
      kind: "signed",
    };
  }
  if (["submitted", "accepted", "pending"].includes(lifecycle) || legacy === "broadcast") {
    return {
      label: "Broadcast · awaiting chain truth",
      detail: "Submission is recorded locally; final Base evidence has not been observed.",
      tone: "gold",
      kind: "broadcast",
    };
  }
  if (lifecycle === "settled") {
    return {
      label: "Settled",
      detail: "The local lifecycle is settled.",
      tone: "neutral",
      kind: "finalized",
    };
  }
  if (["failed", "declined", "expired", "cancelled"].includes(lifecycle) || legacy === "failed") {
    return {
      label: lifecycle === "expired" ? "Quote expired" : "Failed before settlement",
      detail: payment.error ?? "The local payment lifecycle ended without settlement.",
      tone: "ember",
      kind: "failed",
    };
  }
  return {
    label: "Quoted · unsigned",
    detail: "Nothing has been signed or broadcast.",
    tone: "dim",
    kind: "quoted",
  };
}

export function isBasePayment(payment: PaymentListItem): boolean {
  const chainId = normalized(payment.truth?.chain_id);
  const rail = normalized(payment.truth?.rail ?? payment.rail);
  return chainId === "eip155:8453" || rail === "evm-base" || rail === "base";
}

export function paymentCanReconcile(payment: PaymentListItem): boolean {
  const networkTxId = payment.truth?.network_tx_id ?? payment.tx_hash;
  if (!networkTxId || !isBasePayment(payment)) return false;
  if (payment.truth?.actions?.reconcile === false) return false;
  const state = paymentActivityState(payment).kind;
  return state !== "finalized" && state !== "reverted" && state !== "quoted" && state !== "failed";
}

function explorerFor(payment: PaymentListItem, txId: string): { href: string; label: string } {
  return normalized(payment.asset) === "btc"
    ? { href: `https://mempool.space/tx/${txId}`, label: "Open in mempool.space" }
    : { href: `https://basescan.org/tx/${txId}`, label: "Open in Basescan" };
}

function feeAsset(fee: PaymentTruthFee): string {
  const asset = fee.asset ?? fee.asset_id ?? "fee asset";
  return asset.toLowerCase() === "eip155:8453/slip44:60" ? "ETH" : asset;
}

function feeDecimals(fee: PaymentTruthFee): number {
  if (typeof fee.decimals === "number" && Number.isSafeInteger(fee.decimals) && fee.decimals >= 0) {
    return fee.decimals;
  }
  const asset = feeAsset(fee);
  if (asset.toLowerCase().includes("slip44:60")) return 18;
  return ASSET_DECIMALS[asset.toUpperCase()] ?? 0;
}

function AtomicFee({ amount, fee }: { amount: string | null | undefined; fee: PaymentTruthFee }) {
  if (amount === null || amount === undefined) return <span className="truth-missing">not observed</span>;
  const decimals = feeDecimals(fee);
  const asset = feeAsset(fee);
  return (
    <span className="truth-fee-value">
      <span className="amt">{formatMinorCompact(amount, decimals)} {asset}</span>
      {decimals > 0 && <code>{amount} atomic</code>}
    </span>
  );
}

function TruthFee({ fee }: { fee: PaymentTruthFee }) {
  const hasComponents = [
    fee.l2_execution_atomic,
    fee.l1_data_security_atomic,
    fee.operator_atomic,
    fee.total_atomic,
  ].some((amount) => amount !== undefined && amount !== null);
  if (!hasComponents) return null;
  return (
    <div className="truth-fee">
      <div className="truth-fee-heading">
        <strong>Network fee</strong>
        {fee.completeness && <Badge tone={normalized(fee.completeness) === "exact" ? "neutral" : "gold"}>{fee.completeness}</Badge>}
      </div>
      <dl>
        <div><dt>Base execution (L2)</dt><dd><AtomicFee amount={fee.l2_execution_atomic} fee={fee} /></dd></div>
        <div><dt>Ethereum data security (L1)</dt><dd><AtomicFee amount={fee.l1_data_security_atomic} fee={fee} /></dd></div>
        <div><dt>Operator</dt><dd><AtomicFee amount={fee.operator_atomic} fee={fee} /></dd></div>
        <div className="truth-fee-total"><dt>Total</dt><dd><AtomicFee amount={fee.total_atomic} fee={fee} /></dd></div>
      </dl>
      {fee.budget_exceeded === true && (
        <p className="truth-budget-warning" role="alert">
          Fee budget exceeded. Chain truth was recorded anyway; the final protocol charge was higher than the quote estimate
          {fee.budget_atomic ? ` (${fee.budget_atomic} atomic budget)` : ""}.
        </p>
      )}
    </div>
  );
}

function TruthTime({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return <span>{label} <time dateTime={value}>{formatDateTime(value)}</time></span>;
}

function truthTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (first) => first.toUpperCase());
}

function EvidenceFacts({ truth }: { truth: PaymentTruth }) {
  const facts = [
    truth.chain_id ? ["Chain", truth.chain_id] : null,
    truth.visibility ? ["Visibility", truthTerm(truth.visibility)] : null,
    truth.security_level ? ["Security", truthTerm(truth.security_level)] : null,
    truth.execution_result ? ["Execution", truthTerm(truth.execution_result)] : null,
    truth.canonicality ? ["Canonicality", truthTerm(truth.canonicality)] : null,
  ].filter((fact): fact is string[] => fact !== null);
  if (facts.length === 0) return null;
  return (
    <dl className="truth-facts">
      {facts.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function PaymentActivity({
  payments,
  error,
  checkingId,
  notice,
  onReconcile,
}: {
  payments: PaymentListItem[] | null;
  error: string | null;
  checkingId: string | null;
  notice: { kind: "status" | "alert"; text: string } | null;
  onReconcile: (payment: PaymentListItem) => void;
}) {
  return (
    <section className="payment-activity" aria-labelledby="payment-activity-title">
      <div className="section-title">
        <h2 id="payment-activity-title">Payment activity</h2>
        <span className="thread-rule" aria-hidden="true" />
        {payments && <span className="section-aside">{payments.length} recent</span>}
      </div>
      {notice && (
        <p className="truth-notice" role={notice.kind} aria-live="polite">
          {notice.text}
        </p>
      )}
      {error && <p className="truth-notice is-error" role="alert">Activity unavailable: {error}</p>}
      {!payments && !error && <LoadingThreads label="Reading recent payment records…" />}
      {payments?.length === 0 && <p className="payment-activity-empty">No payments have been quoted yet.</p>}
      {payments && payments.length > 0 && (
        <div className="payment-activity-list">
          {payments.map((payment) => {
            const truth = payment.truth;
            const state = paymentActivityState(payment);
            const txId = truth?.network_tx_id ?? payment.tx_hash;
            const explorer = txId ? explorerFor(payment, txId) : null;
            const canReconcile = paymentCanReconcile(payment);
            const checking = checkingId === payment.id;
            const assetDecimals = ASSET_DECIMALS[payment.asset.toUpperCase()] ?? 0;
            return (
              <article className="payment-activity-card card" data-state={state.kind} key={payment.id}>
                <header className="payment-activity-head">
                  <div>
                    <span className="payment-activity-kicker">{payment.asset} outbound</span>
                    <h3>{formatMinorCompact(payment.amount_minor, assetDecimals)} {payment.asset}</h3>
                  </div>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </header>

                <p className="payment-activity-detail">{state.detail}</p>
                {truth && <EvidenceFacts truth={truth} />}
                <div className="payment-activity-meta">
                  <span>To <code>{shortAddress(payment.to_addr)}</code></span>
                  <span>Created <time dateTime={payment.created_at}>{formatDateTime(payment.created_at)}</time></span>
                  {truth?.block?.number && <span>Block <code>{truth.block.number}</code></span>}
                  {truth?.block?.hash && <span>Block hash <code title={truth.block.hash}>{shortAddress(truth.block.hash)}</code></span>}
                  {truth?.evidence?.provider_ids && truth.evidence.provider_ids.length > 0 && (
                    <span>{truth.evidence.provider_ids.length} provider evidence record{truth.evidence.provider_ids.length === 1 ? "" : "s"}</span>
                  )}
                  {truth?.evidence?.quorum !== undefined && truth.evidence.quorum !== null && (
                    <span>Quorum <code>{String(truth.evidence.quorum)}</code></span>
                  )}
                </div>

                {txId && explorer && (
                  <div className="truth-tx-row">
                    <code title={txId}>{txId}</code>
                    <a href={explorer.href} target="_blank" rel="noreferrer">{explorer.label} ↗</a>
                  </div>
                )}

                {truth?.fee && <TruthFee fee={truth.fee} />}

                {(truth?.checked_at || truth?.observed_at) && (
                  <div className="truth-times">
                    <TruthTime label="Checked" value={truth.checked_at} />
                    <TruthTime label="Evidence observed" value={truth.observed_at} />
                  </div>
                )}

                <div className="truth-actions">
                  {canReconcile && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={checkingId !== null}
                      aria-busy={checking}
                      onClick={() => onReconcile(payment)}
                    >
                      {checking ? "Checking Base…" : "Check Base now"}
                    </button>
                  )}
                  {truth?.actions?.exact_rebroadcast === true && (
                    <span className="truth-action-note">Exact-byte rebroadcast is available; it cannot create a different transaction.</span>
                  )}
                  {truth?.actions?.safe_to_create_new_payment === false && (
                    <strong className="truth-hold">Do not create a replacement payment.</strong>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
