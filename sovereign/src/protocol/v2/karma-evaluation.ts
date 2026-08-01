/**
 * Verified, deterministic, participant-local KARMA evaluation.
 *
 * Every observation crosses the signed v2 record boundary before use. The
 * result is an explanation and recommendation only; this module has no
 * payment, account, network, evidence-fetching, or enforcement capability.
 */

import {
  assertTimestamp,
  sha256Id,
  type Sha256Id,
} from "@agenttool/wallet";

import {
  karmaPolicyHash,
  parseKarmaPolicy,
  parseKarmaSubjectCommitment,
  type KarmaComparison,
  type KarmaPolicyRule,
  type KarmaRecommendation,
  type KarmaSubjectCommitment,
} from "./karma.ts";
import {
  V2_SCHEMAS,
  verifyV2Record,
  type KarmaObservationRecordCore,
  type VerifiedV2Record,
} from "./records.ts";

export const KARMA_EVIDENCE_BUNDLE_SCHEMA =
  "cashloom.karma-evidence-bundle/v2" as const;
export const KARMA_EVALUATION_SCHEMA = "cashloom.karma-evaluation/v2" as const;

export interface EvaluateV2KarmaInput {
  readonly subject: unknown;
  readonly observation_records: readonly unknown[];
  readonly policy: unknown;
  /** Explicit canonical time; no ambient clock enters evaluation. */
  readonly evaluated_at: string;
}

export interface KarmaRuleEvaluation {
  readonly rule_id: string;
  readonly metric: KarmaPolicyRule["metric"];
  readonly comparison: KarmaComparison;
  readonly threshold: number;
  readonly accepted_issuer_key_ids: readonly Sha256Id[];
  readonly minimum_unique_issuers: number;
  readonly maximum_window_seconds: number;
  readonly max_age_seconds: number | null;
  readonly recommendation: KarmaRecommendation;
  readonly matched: boolean;
  readonly matching_issuer_key_ids: readonly Sha256Id[];
  readonly matching_record_ids: readonly Sha256Id[];
}

export interface KarmaEvaluation {
  readonly schema: typeof KARMA_EVALUATION_SCHEMA;
  readonly effect_scope: "advisory-only";
  readonly recommendation: KarmaRecommendation;
  readonly subject: KarmaSubjectCommitment;
  readonly policy_id: string;
  readonly policy_hash: Sha256Id;
  readonly evaluated_at: string;
  readonly evidence_bundle_hash: Sha256Id;
  readonly supplied_observation_record_ids: readonly Sha256Id[];
  readonly in_scope_observation_record_ids: readonly Sha256Id[];
  readonly out_of_scope_observation_record_ids: readonly Sha256Id[];
  readonly matched_rule_ids: readonly string[];
  readonly rule_evaluations: readonly KarmaRuleEvaluation[];
  readonly capabilities: {
    readonly can_execute_payment: false;
    readonly can_mutate_account: false;
    readonly can_settle_refund_or_reroute_funds: false;
  };
  readonly notices: readonly string[];
}

const MAX_OBSERVATION_RECORDS = 256;
const RECOMMENDATION_STRENGTH: Readonly<Record<KarmaRecommendation, number>> =
  Object.freeze({
    proceed: 0,
    "increase-friction": 1,
    "manual-review": 2,
    "withhold-settlement-handoff": 3,
  });

function denseArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) {
    throw new TypeError(`${path} must be an array with at most ${maximum} entries.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  expected.push("length");
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${path} must be dense and contain no extra properties.`);
  }
  return value;
}

function expectObservationRecord(
  value: unknown,
): VerifiedV2Record<KarmaObservationRecordCore> {
  const record = verifyV2Record(value);
  if (record.schema !== V2_SCHEMAS.karma_observation) {
    throw new TypeError("KARMA evidence requires signed karma observation records.");
  }
  return record;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function matchesComparison(
  value: number,
  comparison: KarmaComparison,
  threshold: number,
): boolean {
  switch (comparison) {
    case "at-least":
      return value >= threshold;
    case "at-most":
      return value <= threshold;
    case "equal":
      return value === threshold;
  }
}

function sameSubject(
  left: KarmaSubjectCommitment,
  right: KarmaSubjectCommitment,
): boolean {
  return left.scheme === right.scheme
    && left.scope === right.scope
    && left.scope_ref === right.scope_ref
    && left.commitment === right.commitment;
}

function semanticObservationSlot(
  record: VerifiedV2Record<KarmaObservationRecordCore>,
): Sha256Id {
  return sha256Id({
    schema: "cashloom.karma-observation-slot/v2",
    issuer_key_id: record.observation.issuer_key_id,
    subject: record.observation.subject,
    metric: record.observation.metric,
    window: record.observation.window,
  });
}

function chooseStronger(
  left: KarmaRecommendation,
  right: KarmaRecommendation,
): KarmaRecommendation {
  return RECOMMENDATION_STRENGTH[right] > RECOMMENDATION_STRENGTH[left]
    ? right
    : left;
}

/**
 * Evaluate one exact signed bundle under one explicit local policy.
 *
 * Repeated record IDs and re-signed observations for the same issuer/subject/
 * metric/window slot fail closed. Separate windows from one issuer also cannot
 * amplify a quorum because rules count unique issuer keys, never record sums.
 */
export function evaluateV2Karma(
  input: EvaluateV2KarmaInput,
): Readonly<KarmaEvaluation> {
  assertTimestamp(input.evaluated_at, "input.evaluated_at");
  const evaluatedAt = input.evaluated_at;
  const evaluatedMs = Date.parse(evaluatedAt);
  const subject = parseKarmaSubjectCommitment(input.subject);
  const policy = parseKarmaPolicy(input.policy);
  if (subject.scope !== policy.subject_scope) {
    throw new TypeError(
      "The scoped subject commitment does not match policy.subject_scope.",
    );
  }
  const policyHash = karmaPolicyHash(policy);
  const values = denseArray(
    input.observation_records,
    "input.observation_records",
    MAX_OBSERVATION_RECORDS,
  );
  const records = values.map((value) => expectObservationRecord(value));

  const seenRecordIds = new Set<Sha256Id>();
  const seenSlots = new Map<Sha256Id, Sha256Id>();
  for (const record of records) {
    if (seenRecordIds.has(record.record_id)) {
      throw new TypeError(
        `input.observation_records repeats record ID ${record.record_id}.`,
      );
    }
    seenRecordIds.add(record.record_id);
    if (Date.parse(record.issued_at) > evaluatedMs) {
      throw new TypeError(
        `Observation ${record.record_id} was issued after input.evaluated_at.`,
      );
    }
    const slot = semanticObservationSlot(record);
    const first = seenSlots.get(slot);
    if (first !== undefined) {
      throw new TypeError(
        `Observations ${first} and ${record.record_id} repeat one issuer/subject/metric/window slot.`,
      );
    }
    seenSlots.set(slot, record.record_id);
  }

  const suppliedIds = records.map(({ record_id }) => record_id).sort();
  const inScope = records.filter(({ observation }) =>
    sameSubject(observation.subject, subject));
  const inScopeIds = inScope.map(({ record_id }) => record_id).sort();
  const outOfScopeIds = records
    .filter(({ observation }) => !sameSubject(observation.subject, subject))
    .map(({ record_id }) => record_id)
    .sort();

  const ruleEvaluations: KarmaRuleEvaluation[] = policy.rules.map((rule) => {
    const matching = inScope.filter(({ observation }) => {
      if (
        observation.metric !== rule.metric
        || !rule.accepted_issuer_key_ids.includes(observation.issuer_key_id)
        || !matchesComparison(observation.value, rule.comparison, rule.threshold)
      ) {
        return false;
      }
      const windowEndedMs = Date.parse(observation.window.ended_at);
      const windowDurationMs = windowEndedMs
        - Date.parse(observation.window.started_at);
      if (windowDurationMs > rule.maximum_window_seconds * 1_000) {
        return false;
      }
      const observedMs = Date.parse(observation.observed_at);
      return rule.max_age_seconds === null
        || (
          evaluatedMs - windowEndedMs <= rule.max_age_seconds * 1_000
          && evaluatedMs - observedMs <= rule.max_age_seconds * 1_000
        );
    });
    const issuerIds = [...new Set(
      matching.map(({ observation }) => observation.issuer_key_id),
    )].sort();
    return {
      rule_id: rule.rule_id,
      metric: rule.metric,
      comparison: rule.comparison,
      threshold: rule.threshold,
      accepted_issuer_key_ids: [...rule.accepted_issuer_key_ids],
      minimum_unique_issuers: rule.minimum_unique_issuers,
      maximum_window_seconds: rule.maximum_window_seconds,
      max_age_seconds: rule.max_age_seconds,
      recommendation: rule.recommendation,
      matched: issuerIds.length >= rule.minimum_unique_issuers,
      matching_issuer_key_ids: issuerIds,
      matching_record_ids: matching.map(({ record_id }) => record_id).sort(),
    };
  });

  let recommendation = policy.default_recommendation;
  for (const rule of ruleEvaluations) {
    if (rule.matched) {
      recommendation = chooseStronger(recommendation, rule.recommendation);
    }
  }
  const matchedRuleIds = ruleEvaluations
    .filter(({ matched }) => matched)
    .map(({ rule_id }) => rule_id);
  const evidenceBundleHash = sha256Id({
    schema: KARMA_EVIDENCE_BUNDLE_SCHEMA,
    subject,
    policy_hash: policyHash,
    evaluated_at: evaluatedAt,
    observation_record_ids: suppliedIds,
  });

  return deepFreeze({
    schema: KARMA_EVALUATION_SCHEMA,
    effect_scope: "advisory-only",
    recommendation,
    subject,
    policy_id: policy.policy_id,
    policy_hash: policyHash,
    evaluated_at: evaluatedAt,
    evidence_bundle_hash: evidenceBundleHash,
    supplied_observation_record_ids: suppliedIds,
    in_scope_observation_record_ids: inScopeIds,
    out_of_scope_observation_record_ids: outOfScopeIds,
    matched_rule_ids: matchedRuleIds,
    rule_evaluations: ruleEvaluations,
    capabilities: {
      can_execute_payment: false,
      can_mutate_account: false,
      can_settle_refund_or_reroute_funds: false,
    },
    notices: [
      "Observations are issuer claims about scoped behaviour, not identity, intent, guilt, or account standing.",
      "The recommendation reflects only this exact local policy and signed evidence bundle; another participant may disagree.",
      "Evidence references are inert and were not fetched or independently validated.",
      "No output authorizes payment, settlement, refund, rerouting, account mutation, retaliation, or publication to a global blacklist.",
      "Issuer-key pinning limits open amplification but does not prove that distinct keys are independent people or organisations.",
    ],
  });
}
