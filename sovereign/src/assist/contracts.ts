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

export interface AssistContext {
  schema_version: "cashloom.assist-context/1";
  generated_at: string;
  access: AssistAccess;
  accounts: AssistAccount[];
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
