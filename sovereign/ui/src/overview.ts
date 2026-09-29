import { errorMessage } from "./api";
import { LIVE_CRYPTO_IDENTITIES } from "./types";
import type { Account, BaseAccountPositionView, SummaryRow, WalletPositionsResponse } from "./types";

const BASE = LIVE_CRYPTO_IDENTITIES.BASE_ETH.chain_id;
const BASE_ASSETS = [LIVE_CRYPTO_IDENTITIES.BASE_ETH, LIVE_CRYPTO_IDENTITIES.BASE_USDC];
const integer = (value: string): boolean => /^-?\d+$/.test(value);
const timestamp = (value: string | null): value is string =>
  value !== null && Number.isFinite(Date.parse(value));

export interface OverviewBaseWallet {
  id: string;
  accounts: Account[];
  view: BaseAccountPositionView | null;
  state: "finalized" | "not_checked" | "conflicted" | "identity_invalid";
  message: string;
}

export interface OverviewAccount {
  account: Account;
  balance: string | null;
  summary: SummaryRow | null;
}

/** Keep saved balances at their account/asset boundary and group Base aliases.
 * There is no sum across symbols, chains, or different observation times. */
export function buildOverview(
  accounts: readonly Account[],
  summaries: readonly SummaryRow[] = [],
  baseViews: readonly BaseAccountPositionView[] = [],
): { baseWallets: OverviewBaseWallet[]; accounts: OverviewAccount[]; accountCount: number } {
  const active = accounts.filter((account) => account.status.toUpperCase() === "ACTIVE");
  const baseGroups = new Map<string, Account[]>();
  const ordinary: OverviewAccount[] = [];
  for (const account of active) {
    const isBase = account.rail === "CRYPTO" && (
      (account.chain_id === BASE && BASE_ASSETS.some((asset) =>
        asset.asset_id === account.asset_id?.toLowerCase())) ||
      baseViews.some((view) => view.account_id === account.id)
    );
    if (isBase) {
      const id = account.account_ref?.toLowerCase() ?? `invalid:${account.id}`;
      const group = baseGroups.get(id) ?? [];
      group.push(account);
      baseGroups.set(id, group);
      continue;
    }
    const summary = summaries.find((row) => row.id === account.id);
    ordinary.push({
      account,
      // A newly created account's default zero is not a balance observation.
      balance: timestamp(account.balance_as_of) && integer(account.balance_minor)
        ? account.balance_minor : null,
      summary: summary && summary.currency === account.currency &&
          summary.decimals === account.decimals &&
          integer(summary.in_minor) && integer(summary.out_minor)
        ? summary : null,
    });
  }

  const baseWallets = [...baseGroups].map(([id, records]): OverviewBaseWallet => {
    const views = baseViews.filter((view) => records.some((record) => record.id === view.account_id));
    const invalid = records.some((account) => {
      const asset = BASE_ASSETS.find((candidate) => candidate.asset_id === account.asset_id?.toLowerCase());
      return !asset || account.chain_id !== BASE || account.currency !== asset.currency ||
        account.decimals !== asset.decimals || !/^eip155:8453:0x[0-9a-f]{40}$/.test(id);
    }) || views.some((view) => view.status === "identity_invalid" ||
      view.chain_id !== BASE || view.account_ref.toLowerCase() !== id ||
      view.identity_group.canonical_account_ref.toLowerCase() !== id);
    if (invalid) return {
      id, accounts: records, view: null, state: "identity_invalid",
      message: "This Base account identity needs review in Accounts before its balance can be shown.",
    };
    if (views.some((view) => view.status === "conflicted")) return {
      id, accounts: records, view: null, state: "conflicted",
      message: "Conflicting evidence froze this wallet. Review the retained snapshot in Accounts.",
    };
    const finalized = views.filter((view) => view.status === "finalized" && view.snapshot);
    if (finalized.some((view) => !/^\d+$/.test(view.snapshot!.block.number))) return {
      id, accounts: records, view: null, state: "not_checked",
      message: "The saved Base balance is incomplete. Review its evidence in Accounts.",
    };
    const view = finalized.sort((a, b) => {
      const left = BigInt(a.snapshot!.block.number);
      const right = BigInt(b.snapshot!.block.number);
      return left === right ? 0 : left > right ? -1 : 1;
    })[0] ?? null;
    if (!view) return {
      id, accounts: records, view: null, state: "not_checked",
      message: views.some((entry) => entry.last_refresh)
        ? "The last Base check did not establish a finalized balance. Check it again in Accounts."
        : "No finalized balance is saved yet. Check this wallet in Accounts.",
    };
    // Aliases are refreshed separately. Show the newest finalized block once;
    // contradictory evidence at the same height still requires review.
    const signature = (entry: BaseAccountPositionView) => JSON.stringify({
      evidence: entry.snapshot?.evidence_hash,
      block: entry.snapshot?.block,
      positions: entry.positions.map((position) => [position.asset_id.toLowerCase(),
        position.observed_atomic, position.decimals])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    });
    if (finalized.some((entry, index) => finalized.slice(index + 1).some((other) =>
      entry.snapshot!.block.number === other.snapshot!.block.number && signature(entry) !== signature(other)))) return {
      id, accounts: records, view: null, state: "conflicted",
      message: "Saved records disagree for this wallet. Review its evidence in Accounts.",
    };
    const snapshot = view.snapshot!;
    const validPositions = view.positions.length === BASE_ASSETS.length && BASE_ASSETS.every((asset) => {
      const matching = view.positions.filter((position) => position.asset_id.toLowerCase() === asset.asset_id);
      const position = matching[0];
      return matching.length === 1 && position.symbol === asset.currency &&
        position.decimals === asset.decimals && /^\d+$/.test(position.observed_atomic) &&
        integer(position.pending_atomic);
    });
    if (!validPositions || snapshot.quorum !== "2" ||
      snapshot.provider_ids.length !== 2 || new Set(snapshot.provider_ids).size !== 2 ||
      !timestamp(snapshot.observed_at) || !timestamp(snapshot.block.timestamp)) return {
      id, accounts: records, view: null, state: "not_checked",
      message: "The saved Base balance is incomplete. Review its evidence in Accounts.",
    };
    const lastRefresh = views.map((entry) => entry.last_refresh).filter((entry) => entry !== null)
      .sort((a, b) => b.attempted_at.localeCompare(a.attempted_at))[0];
    return {
      id, accounts: records, view, state: "finalized",
      message: lastRefresh && lastRefresh.attempted_at > snapshot.observed_at &&
        !["applied", "replayed", "superseded", "stale"].includes(lastRefresh.outcome)
        ? "The latest check did not establish a new balance. This is the retained finalized snapshot."
        : "The newest saved finalized block for this wallet, observed by two provider endpoints. Refresh in Accounts when you need a new observation.",
    };
  });
  return { baseWallets, accounts: ordinary, accountCount: active.length };
}

interface OverviewLoadDependencies {
  accounts(): Promise<{ accounts: Account[] }>;
  summary(): Promise<{ accounts: SummaryRow[] }>;
  walletPositions(): Promise<WalletPositionsResponse>;
}

interface OverviewLoadCallbacks {
  accountsLoaded(accounts: Account[]): void;
  accountsFailed(message: string): void;
  summaryLoaded(accounts: SummaryRow[]): void;
  summaryFailed(message: string): void;
  positionsLoaded(positions: BaseAccountPositionView[]): void;
  positionsFailed(message: string): void;
}

/** Optional evidence and history resolve independently of the accounts. */
export function beginOverviewLoad(dependencies: OverviewLoadDependencies, callbacks: OverviewLoadCallbacks) {
  return {
    accounts: dependencies.accounts().then(
      (result) => callbacks.accountsLoaded(result.accounts),
      (error: unknown) => callbacks.accountsFailed(errorMessage(error)),
    ),
    summary: dependencies.summary().then(
      (result) => callbacks.summaryLoaded(result.accounts),
      (error: unknown) => callbacks.summaryFailed(errorMessage(error)),
    ),
    positions: dependencies.walletPositions().then(
      (result) => callbacks.positionsLoaded(Array.isArray(result.base_accounts) ? result.base_accounts : []),
      (error: unknown) => callbacks.positionsFailed(errorMessage(error)),
    ),
  };
}
