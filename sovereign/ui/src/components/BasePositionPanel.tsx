import { Amount, Badge } from "../components";
import { shortAddress } from "../format";
import type { Account, BaseAccountPositionView } from "../types";

const BASE_CHAIN = "eip155:8453";
const BASE_ETH = `${BASE_CHAIN}/slip44:60`;
const BASE_USDC =
  `${BASE_CHAIN}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`;

export const isObservableBaseAccount = (account: Account): boolean => {
  const asset = account.asset_id?.toLowerCase();
  return account.rail === "CRYPTO" &&
    account.status.toUpperCase() === "ACTIVE" &&
    account.chain_id === BASE_CHAIN &&
    (asset === BASE_ETH || asset === BASE_USDC) &&
    account.account_ref?.toLowerCase().startsWith(`${BASE_CHAIN}:0x`) === true;
};

const dateTime = (value: string): string => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
};

const age = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "age unavailable";

  const seconds = Math.round((Date.now() - timestamp) / 1_000);
  const future = seconds < 0;
  const magnitude = Math.abs(seconds);
  const [amount, unit] = magnitude < 60
    ? [magnitude, "second"]
    : magnitude < 3_600
      ? [Math.floor(magnitude / 60), "minute"]
      : magnitude < 86_400
        ? [Math.floor(magnitude / 3_600), "hour"]
        : [Math.floor(magnitude / 86_400), "day"];
  const plural = amount === 1 ? unit : `${unit}s`;
  return future ? `in ${amount} ${plural}` : `${amount} ${plural} ago`;
};

export function BasePositionPanel({
  view,
  refreshing,
  message,
  error,
  onRefresh,
}: {
  view: BaseAccountPositionView | null;
  refreshing: boolean;
  message?: string | null;
  error?: string | null;
  onRefresh(): void;
}) {
  const finalized = view?.status.toLowerCase() === "finalized" && view.snapshot !== null;
  const conflicted = view?.status.toLowerCase() === "conflicted";
  const identityInvalid = view?.status.toLowerCase() === "identity_invalid";
  const hasSavedSnapshot = view?.snapshot !== null && view?.snapshot !== undefined;
  const lastRefresh = view?.last_refresh ?? null;
  return (
    <section className="base-position-panel" aria-busy={refreshing}>
      <div className="base-position-heading">
        <div>
          <strong>Finalized Base positions</strong>
          <p>
            {identityInvalid
              ? view?.refusal?.message ?? "This Base account identity cannot be observed safely."
              : conflicted
              ? "Conflicting same-height evidence froze this view. The last uncontested finalized snapshot remains visible and no balance was overwritten."
              : finalized
                ? "Matching responses from two configured provider endpoints established one finalized block."
                : lastRefresh
                  ? "The last Base check did not settle a finalized snapshot. Saved evidence remains explicit; no missing response is treated as zero."
                  : "Not checked on Base yet. No missing response is treated as a zero balance."}
          </p>
        </div>
        <Badge tone={conflicted || identityInvalid ? "ember" : finalized ? "gold" : "dim"}>
          {identityInvalid
            ? "identity invalid"
            : conflicted
              ? "evidence conflict"
              : finalized
                ? "2-provider finalized"
                : "not checked"}
        </Badge>
      </div>

      {hasSavedSnapshot && view ? (
        <>
          <div className="base-position-values">
            {view.positions.map((position) => (
              <div key={position.asset_id}>
                <span>{position.name || position.symbol}</span>
                <Amount
                  minor={position.observed_atomic}
                  decimals={position.decimals}
                  currency={position.symbol}
                />
                {position.pending_atomic !== "0" && (
                  <small>pending ledger delta {position.pending_atomic} atomic</small>
                )}
              </div>
            ))}
          </div>
          <dl className="base-position-proof">
            <div>
              <dt>Block</dt>
              <dd title={view.snapshot!.block.hash}>
                {view.snapshot!.block.number} · {shortAddress(view.snapshot!.block.hash)}
              </dd>
            </div>
            <div>
              <dt>Block age</dt>
              <dd>
                {age(view.snapshot!.block.timestamp)} ·{" "}
                <time dateTime={view.snapshot!.block.timestamp}>
                  {dateTime(view.snapshot!.block.timestamp)}
                </time>
              </dd>
            </div>
            <div>
              <dt>{conflicted ? "Retained snapshot age" : "Snapshot age"}</dt>
              <dd>{age(view.snapshot!.applied_at)}</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>
                <time dateTime={view.snapshot!.observed_at}>
                  {dateTime(view.snapshot!.observed_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Applied</dt>
              <dd>
                <time dateTime={view.snapshot!.applied_at}>
                  {dateTime(view.snapshot!.applied_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Provider IDs</dt>
              <dd>
                {view.snapshot!.provider_ids.join(" · ")} · quorum {view.snapshot!.quorum}
              </dd>
            </div>
          </dl>
        </>
      ) : null}

      {lastRefresh && (
        <dl className="base-position-proof base-position-last-check">
          <div>
            <dt>Last check</dt>
            <dd>
              {lastRefresh.outcome} · {age(lastRefresh.attempted_at)} ·{" "}
              <time dateTime={lastRefresh.attempted_at}>{dateTime(lastRefresh.attempted_at)}</time>
            </dd>
          </div>
          <div>
            <dt>Provider result</dt>
            <dd>
              {lastRefresh.agreeing_provider_count} agreeing ·{" "}
              {lastRefresh.available_provider_count}/{lastRefresh.provider_count} available
            </dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{lastRefresh.error_code ?? lastRefresh.reason_code}</dd>
          </div>
        </dl>
      )}

      {view?.identity_group?.duplicate && (
        <p className="base-position-error" role="alert">
          This CAIP-10 address appears in {view.identity_group.account_ids.length} local account
          records. Treat the on-chain balances as one wallet identity; do not sum these cards.
        </p>
      )}

      {message && <p className="base-position-message" role="status">{message}</p>}
      {error && <p className="base-position-error" role="alert">{error}</p>}
      <div className="base-position-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={refreshing || conflicted || identityInvalid || view?.actions.refresh === false}
          onClick={onRefresh}
        >
          {refreshing ? "Checking finalized Base…" : "Refresh finalized balances"}
        </button>
        <small>Explicit read only · never signs, submits, or retries a payment.</small>
      </div>
    </section>
  );
}
