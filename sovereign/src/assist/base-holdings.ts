import type { Database } from "bun:sqlite";
import type { AssistBaseHoldings } from "./contracts";
import { BASE_CHAIN_ID, BASE_ETH_ASSET_ID, BASE_USDC_ASSET_ID, resolveBaseAccount } from "../wallet/base-account-projection";
import { WalletKernelStore, type BasePositionSnapshotRecord } from "../wallet/infrastructure/sqlite/store";

type SelectedAccount = { id: string; rail: string; chain_id: string | null; status: string };
type Saved = { view: AssistBaseHoldings; snapshot: BasePositionSnapshotRecord | null };
const outcomes = new Set(["applied", "replayed", "stale", "superseded", "conflict", "partial", "rejected", "cancelled"]);
const uint256 = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const blockHash = (value: unknown): boolean => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const uniqueStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0) && new Set(value).size === value.length;
const empty = (id: string, status: AssistBaseHoldings["status"] = "not_checked"): AssistBaseHoldings => ({
  account_ids: [id], chain_id: BASE_CHAIN_ID, network: "Base mainnet", authority: "observation_only", status,
  finality: null, as_of: null, observed_at: null, block_number: null, holdings: [], last_check: null,
});

function validSnapshot(snapshot: BasePositionSnapshotRecord): boolean {
  return snapshot.chainId === BASE_CHAIN_ID && uint256(snapshot.blockNumber) && blockHash(snapshot.blockHash) &&
    timestamp(snapshot.blockTime) && timestamp(snapshot.decidedAt) && Date.parse(snapshot.blockTime) <= Date.parse(snapshot.decidedAt) &&
    typeof snapshot.evidenceHash === "string" && /^sha256:[0-9a-f]{64}$/.test(snapshot.evidenceHash) &&
    Number.isSafeInteger(snapshot.quorum) && snapshot.quorum >= 2 &&
    uniqueStrings(snapshot.providerIds) && snapshot.providerIds.length >= snapshot.quorum &&
    uniqueStrings(snapshot.sightingIds) && snapshot.sightingIds.length === snapshot.providerIds.length &&
    snapshot.items.length === 2 && snapshot.items[0]?.assetId === BASE_ETH_ASSET_ID && snapshot.items[1]?.assetId === BASE_USDC_ASSET_ID &&
    snapshot.items.every(item => uint256(item.observedAtomic));
}

/** Reads only selected active accounts and their immutable saved kernel heads.
 * No schema installation, account projection, refresh, RPC or vault decryption.
 * Internal addresses are used solely to deduplicate selected aliases; no identity
 * groups or evidence payloads from the wider workspace enter the response. */
export function selectedBaseHoldings(db: Database, selected: readonly SelectedAccount[]): AssistBaseHoldings[] {
  const candidates = selected.filter(account => account.status === "ACTIVE" && account.rail === "CRYPTO" && account.chain_id === BASE_CHAIN_ID);
  if (!candidates.length) return [];
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wk_%'").all() as { name: string }[]).map(row => row.name));
  const installed = ["wk_accounts", "wk_base_position_snapshot_heads", "wk_base_position_snapshots", "wk_base_position_refresh_attempts"].every(name => tables.has(name));
  const store = new WalletKernelStore(db, { install: false });
  const groups = new Map<string, Saved[]>();
  for (const account of candidates) {
    const view = empty(account.id);
    let identity: ReturnType<typeof resolveBaseAccount>;
    try { identity = resolveBaseAccount(db, account.id); }
    catch {
      // An invalid reference is not a usable alias for any other account.
      groups.set(`invalid:${account.id}`, [{ view: { ...view, status: "identity_invalid" }, snapshot: null }]);
      continue;
    }
    const group = groups.get(identity.accountRef) ?? [];
    groups.set(identity.accountRef, group);
    const saved: Saved = { view, snapshot: null };
    group.push(saved);
    if (!installed) continue;
    try {
      const kernel = db.query("SELECT chain_id,account_ref,address,status,rail FROM wk_accounts WHERE id=?").get(account.id) as {
        chain_id: string; account_ref: string; address: string; status: string; rail: string;
      } | null;
      if (kernel && (kernel.chain_id !== BASE_CHAIN_ID || kernel.account_ref?.toLowerCase() !== identity.accountRef ||
        kernel.address?.toLowerCase() !== identity.address || kernel.status !== "ACTIVE" || kernel.rail !== "evm-base")) {
        view.status = "identity_invalid";
        continue;
      }
      const attempt = store.listBasePositionRefreshAttempts({ accountId: account.id, limit: 1 })[0];
      if (attempt) {
        if (!timestamp(attempt.attemptedAt) || !outcomes.has(attempt.outcome)) throw new Error("Invalid saved check");
        view.last_check = { attempted_at: attempt.attemptedAt, outcome: attempt.outcome };
      }
      const head = store.getBasePositionHead(account.id);
      if (!head) continue;
      if (!kernel || head.accountId !== account.id || !uint256(head.blockNumber) || !blockHash(head.blockHash) ||
        !Number.isSafeInteger(head.version) || head.version < 0 || !["ACTIVE", "FROZEN"].includes(head.state)) throw new Error("Invalid saved head");
      if (head.state === "FROZEN" || head.conflictSnapshotId !== null) { view.status = "conflicted"; continue; }
      // A malformed head must not cause even an internal read of another account's snapshot.
      const belongs = db.query("SELECT id FROM wk_base_position_snapshots WHERE id=? AND account_id=?").get(head.snapshotId, account.id);
      if (!belongs) throw new Error("Missing selected snapshot");
      const snapshot = store.getBasePositionSnapshot(head.snapshotId);
      if (!snapshot || snapshot.accountId !== account.id || snapshot.blockNumber !== head.blockNumber || snapshot.blockHash !== head.blockHash || !validSnapshot(snapshot)) throw new Error("Invalid selected snapshot");
      saved.snapshot = snapshot;
    } catch {
      view.status = "evidence_invalid";
      view.last_check = null;
    }
  }
  return [...groups.values()].map(group => {
    const result = { ...group[0]!.view, account_ids: group.flatMap(entry => entry.view.account_ids) };
    const checks = group.flatMap(entry => entry.view.last_check ? [entry.view.last_check] : []).sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at));
    result.last_check = checks[0] ?? null;
    for (const status of ["identity_invalid", "evidence_invalid", "conflicted"] as const) {
      if (group.some(entry => entry.view.status === status)) return { ...result, status };
    }
    const snapshots = group.flatMap(entry => entry.snapshot ? [entry.snapshot] : []);
    // Same-height contradictions anywhere among these selected aliases invalidate
    // the group. Unselected aliases are deliberately neither read nor revealed.
    const heights = new Map<string, string>();
    for (const snapshot of snapshots) {
      const facts = JSON.stringify([snapshot.blockHash, snapshot.blockTime, snapshot.items]);
      const prior = heights.get(snapshot.blockNumber);
      if (prior !== undefined && prior !== facts) return { ...result, status: "conflicted" };
      heights.set(snapshot.blockNumber, facts);
    }
    snapshots.sort((a, b) => BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? 1 : Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
    const snapshot = snapshots[0];
    if (!snapshot) return result;
    const retained = result.last_check && Date.parse(result.last_check.attempted_at) >= Date.parse(snapshot.decidedAt) && !["applied", "replayed"].includes(result.last_check.outcome);
    return { ...result, status: retained ? "retained_after_check" : "saved_finalized", finality: "finalized",
      as_of: snapshot.blockTime, observed_at: snapshot.decidedAt, block_number: snapshot.blockNumber,
      holdings: [{ asset: "ETH", decimals: 18, observed_atomic: snapshot.items[0].observedAtomic },
        { asset: "USDC", decimals: 6, observed_atomic: snapshot.items[1].observedAtomic }] };
  });
}
