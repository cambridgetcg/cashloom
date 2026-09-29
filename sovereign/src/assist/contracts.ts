/** Private, owner-selected record access. No token belongs in these read DTOs. */
export type AssistPermission = "read" | "propose_categories";

export interface AssistAccess {
  id: string;
  label: string;
  account_ids: string[];
  permissions: AssistPermission[];
  created_at: string;
  expires_at: string;
}

export interface AssistAccessInput {
  label: string;
  account_ids: string[];
  allow_proposals: boolean;
  ttl_minutes: number;
}

export interface AssistAccount {
  id: string;
  display_name: string;
  currency: string;
  decimals: number;
  rail: string;
  environment: "local" | "sandbox" | "live";
  balance_minor: string | null;
  balance_as_of: string | null;
  available_minor: string | null;
  pending_minor: string | null;
  held_minor: string | null;
  balance_kind: string | null;
  account_type: string | null;
  connection_status: string | null;
}

export interface AssistTransaction {
  id: string;
  account_id: string;
  title: string;
  amount_minor: string;
  currency: string;
  decimals: number;
  date: string;
  category: string | null;
  status: "posted" | "pending" | "removed";
  source: string;
  is_internal_transfer: boolean;
  record_version: string;
}

export type AssistBaseHolding =
  | { asset: "ETH"; decimals: 18; observed_atomic: string }
  | { asset: "USDC"; decimals: 6; observed_atomic: string };

/** Saved observations, never a spendable balance or proof of ownership.
 * Aliases are deduplicated only within this request's selected active accounts. */
export interface AssistBaseHoldings {
  account_ids: string[];
  chain_id: "eip155:8453";
  network: "Base mainnet";
  authority: "observation_only";
  status: "not_checked" | "saved_finalized" | "retained_after_check" | "conflicted" | "identity_invalid" | "evidence_invalid";
  finality: "finalized" | null;
  /** Timestamp of the saved finalized block, not this API response. */
  as_of: string | null;
  /** Time the saved snapshot was observed/decided locally. */
  observed_at: string | null;
  block_number: string | null;
  /** Complete ETH/18 and native USDC/6 pair, or empty when evidence is unavailable. */
  holdings: AssistBaseHolding[];
  last_check: {
    attempted_at: string;
    outcome: "applied" | "replayed" | "stale" | "superseded" | "conflict" | "partial" | "rejected" | "cancelled";
  } | null;
}

export interface AssistContext {
  schema_version: "cashloom.assist-context/1";
  generated_at: string;
  access: AssistAccess;
  accounts: AssistAccount[];
  base_holdings: AssistBaseHoldings[];
  transactions: AssistTransaction[];
  activity_window: {
    limit: number;
    returned: number;
    has_more: boolean;
    order: "date_desc_id_desc";
  };
}

export interface AssistProposalInput {
  request_id: string;
  transaction_id: string;
  expected_record_version: string;
  category: string;
  reason: string;
}

export interface AssistProposal {
  id: string;
  grant_id: string;
  access_label: string;
  account_id: string;
  transaction_id: string;
  before: AssistTransaction;
  category: string;
  reason: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  review_state: "current" | "changed" | "unavailable";
  created_at: string;
  decided_at: string | null;
}

export interface AssistAccessList { access: AssistAccess[] }
/** This credential is returned only by the explicit owner creation operation. */
export interface AssistAccessCreated { access: AssistAccess; token: string }
export interface AssistProposalList { proposals: AssistProposal[]; has_more: boolean }
export interface AssistProposalResult { proposal: AssistProposal; replayed: boolean }
