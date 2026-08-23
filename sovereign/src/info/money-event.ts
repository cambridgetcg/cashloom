/**
 * MoneyEvent — the cited companion to MoneyFact.
 *
 * A rate is a scalar fact; a policy decision, scheduled meeting, sanctions
 * change, or supply disruption is an event. Keeping those shapes separate
 * prevents prose and causal claims from being smuggled into a numeric value.
 */

import type { Method, ProofState, Redistribution, Source } from "./money-fact.ts";

export const MONEYEVENT_MEDIA_TYPE = "application/vnd.cashloom.moneyevent.v1+json";

export type MoneyEventKind =
  | "policy_meeting"
  | "policy_decision"
  | "minutes_release"
  | "economic_release"
  | "sovereign_auction"
  | "energy_release"
  | "sanctions_change"
  | "geopolitical_event";

export type MoneyEventStatus = "scheduled" | "published" | "revised" | "cancelled";

export interface EventMeasure {
  predicate: string;
  value: string;
  decimals: number;
  unit: string;
  previous_value?: string;
  change_bps?: string;
}

export interface MoneyEvent {
  "@type": "MoneyEvent";
  schema: "cashloom.moneyevent/1";
  id: string;
  kind: MoneyEventKind;
  subject: string;
  title: string;
  status: MoneyEventStatus;
  starts_at: string;
  ends_at?: string;
  published_at?: string;
  effective_at?: string;
  timezone?: string;
  summary?: string;
  measure?: EventMeasure;
  method: Method;
  proof_state: ProofState;
  redistribution: Redistribution;
  sources: Source[];
  fetched_at: string;
  stale_after_s: number;
  tags?: string[];
}

export function makeEvent(
  event: Omit<MoneyEvent, "@type" | "schema">,
): MoneyEvent {
  return { "@type": "MoneyEvent", schema: "cashloom.moneyevent/1", ...event };
}

/**
 * A relationship is an explicitly bounded calculation, never a causal label.
 * The window and limitations are mandatory so “moved together” cannot quietly
 * become “caused”. Values are exact scaled strings like every other money datum.
 */
export interface RelationshipFact {
  "@type": "RelationshipFact";
  schema: "cashloom.relationship/1";
  id: string;
  predicate: "rolling_correlation" | "rolling_beta" | "event_window_change";
  left: string;
  right: string;
  value: string;
  decimals: number;
  unit: "coefficient" | "percent" | "basis_points";
  window: string;
  lag: string;
  sample_count: number;
  observed_at: string;
  method: "derived";
  proof_state: ProofState;
  redistribution: Redistribution;
  sources: Source[];
  recompute: { how: string; inputs: string[] };
  limitations: string[];
}

