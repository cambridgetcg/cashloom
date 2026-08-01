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
  verifyV2RecordLink,
  type KarmaObservationChallengeRecordCore,
  type KarmaObservationRecordCore,
  type KarmaObservationWithdrawalRecordCore,
  type VerifiedV2Record,
} from "./records.ts";

export const KARMA_EVIDENCE_BUNDLE_SCHEMA =
  "cashloom.karma-evidence-bundle/v2" as const;
export const KARMA_EVALUATION_SCHEMA = "cashloom.karma-evaluation/v2" as const;
export const KARMA_REVIEW_BUNDLE_SCHEMA =
  "cashloom.karma-review-bundle/v2" as const;
export const KARMA_REVIEW_EVALUATION_SCHEMA =
  "cashloom.karma-review-evaluation/v2" as const;

export interface EvaluateV2KarmaInput {
  readonly subject: unknown;
  readonly observation_records: readonly unknown[];
  readonly policy: unknown;
  /** Explicit canonical time; no ambient clock enters evaluation. */
  readonly evaluated_at: string;
}

export interface EvaluateV2KarmaReviewInput extends EvaluateV2KarmaInput {
  readonly withdrawal_records?: readonly unknown[];
  readonly challenge_records?: readonly unknown[];
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

export interface KarmaWithdrawalSummary {
  readonly review_record_id: Sha256Id;
  readonly target_observation_record_id: Sha256Id;
  readonly issuer_key_id: Sha256Id;
  readonly withdrawn_at: string;
  readonly evidence_sha256: readonly Sha256Id[];
}

export interface KarmaChallengeSummary {
  readonly review_record_id: Sha256Id;
  readonly target_observation_record_id: Sha256Id;
  readonly challenger_key_id: Sha256Id;
  readonly challenged_at: string;
  readonly evidence_sha256: readonly Sha256Id[];
  readonly effect_scope: "report-only";
}

export interface KarmaReviewEvaluation
  extends Omit<KarmaEvaluation, "schema"> {
  readonly schema: typeof KARMA_REVIEW_EVALUATION_SCHEMA;
  readonly review_bundle_hash: Sha256Id;
  readonly original_observation_record_ids: readonly Sha256Id[];
  readonly active_observation_record_ids: readonly Sha256Id[];
  readonly withdrawn_observation_record_ids: readonly Sha256Id[];
  readonly withdrawal_record_ids: readonly Sha256Id[];
  readonly challenge_record_ids: readonly Sha256Id[];
  readonly withdrawals: readonly KarmaWithdrawalSummary[];
  readonly challenges: readonly KarmaChallengeSummary[];
}

const MAX_OBSERVATION_RECORDS = 256;
const MAX_REVIEW_RECORDS = 256;
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

function expectWithdrawalRecord(
  value: unknown,
): VerifiedV2Record<KarmaObservationWithdrawalRecordCore> {
  const record = verifyV2Record(value);
  if (record.schema !== V2_SCHEMAS.karma_observation_withdrawal) {
    throw new TypeError(
      "KARMA withdrawal input requires signed observation withdrawal records.",
    );
  }
  return record;
}

function expectChallengeRecord(
  value: unknown,
): VerifiedV2Record<KarmaObservationChallengeRecordCore> {
  const record = verifyV2Record(value);
  if (record.schema !== V2_SCHEMAS.karma_observation_challenge) {
    throw new TypeError(
      "KARMA challenge input requires signed observation challenge records.",
    );
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

/**
 * Verify and authorize signed review records before filtering observations.
 *
 * This ordering is the security boundary: every original observation and
 * every review record is signature-verified first; exact parent links and
 * withdrawal authority are then checked; only afterward may an authorized
 * withdrawal remove its target from the ordinary evaluator. Challenges are
 * returned as report-only metadata and never enter rule matching.
 */
export function evaluateV2KarmaReview(
  input: EvaluateV2KarmaReviewInput,
): Readonly<KarmaReviewEvaluation> {
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

  // Phase 1: verify every signed record before deriving any filtering effect.
  const observationValues = denseArray(
    input.observation_records,
    "input.observation_records",
    MAX_OBSERVATION_RECORDS,
  );
  const observations = observationValues.map((value) =>
    expectObservationRecord(value));
  const observationsById = new Map<
    Sha256Id,
    VerifiedV2Record<KarmaObservationRecordCore>
  >();
  for (const observation of observations) {
    if (observationsById.has(observation.record_id)) {
      throw new TypeError(
        `input.observation_records repeats record ID ${observation.record_id}.`,
      );
    }
    if (Date.parse(observation.issued_at) > evaluatedMs) {
      throw new TypeError(
        `Observation ${observation.record_id} was issued after input.evaluated_at.`,
      );
    }
    observationsById.set(observation.record_id, observation);
  }

  const withdrawalValues = denseArray(
    input.withdrawal_records ?? [],
    "input.withdrawal_records",
    MAX_REVIEW_RECORDS,
  );
  const challengeValues = denseArray(
    input.challenge_records ?? [],
    "input.challenge_records",
    MAX_REVIEW_RECORDS,
  );
  if (withdrawalValues.length + challengeValues.length > MAX_REVIEW_RECORDS) {
    throw new TypeError(
      `KARMA review input must contain at most ${MAX_REVIEW_RECORDS} total review records.`,
    );
  }
  const withdrawals = withdrawalValues.map((value) =>
    expectWithdrawalRecord(value));
  const challenges = challengeValues.map((value) =>
    expectChallengeRecord(value));
  const seenReviewIds = new Set<Sha256Id>();
  for (const review of [...withdrawals, ...challenges]) {
    if (seenReviewIds.has(review.record_id)) {
      throw new TypeError(
        `KARMA review input repeats record ID ${review.record_id}.`,
      );
    }
    seenReviewIds.add(review.record_id);
    if (Date.parse(review.issued_at) > evaluatedMs) {
      throw new TypeError(
        `Review ${review.record_id} was issued after input.evaluated_at.`,
      );
    }
  }

  // Phase 2: authorize exact parent edges and reject semantic replay.
  const withdrawalSlots = new Map<Sha256Id, Sha256Id>();
  const withdrawalSummaries: KarmaWithdrawalSummary[] = withdrawals.map(
    (withdrawal) => {
      const targetId = withdrawal.withdrawal.target_observation_record_id;
      const target = observationsById.get(targetId);
      if (target === undefined) {
        throw new TypeError(
          `Withdrawal ${withdrawal.record_id} has orphan target ${targetId}.`,
        );
      }
      verifyV2RecordLink(withdrawal, target);
      if (!sameSubject(target.observation.subject, subject)) {
        throw new TypeError(
          `Withdrawal ${withdrawal.record_id} targets a different scoped subject.`,
        );
      }
      const slot = sha256Id({
        schema: "cashloom.karma-withdrawal-slot/v2",
        target_observation_record_id: targetId,
      });
      const first = withdrawalSlots.get(slot);
      if (first !== undefined) {
        throw new TypeError(
          `Withdrawals ${first} and ${withdrawal.record_id} repeat one target slot.`,
        );
      }
      withdrawalSlots.set(slot, withdrawal.record_id);
      return {
        review_record_id: withdrawal.record_id,
        target_observation_record_id: targetId,
        issuer_key_id: withdrawal.withdrawal.issuer_key_id,
        withdrawn_at: withdrawal.withdrawal.withdrawn_at,
        evidence_sha256: withdrawal.withdrawal.evidence.map(({ sha256 }) =>
          sha256),
      };
    },
  ).sort((left, right) =>
    left.review_record_id < right.review_record_id
      ? -1
      : left.review_record_id > right.review_record_id ? 1 : 0);

  const challengeSlots = new Map<Sha256Id, Sha256Id>();
  const challengeSummaries: KarmaChallengeSummary[] = challenges.map(
    (challenge) => {
      const targetId = challenge.challenge.target_observation_record_id;
      const target = observationsById.get(targetId);
      if (target === undefined) {
        throw new TypeError(
          `Challenge ${challenge.record_id} has orphan target ${targetId}.`,
        );
      }
      verifyV2RecordLink(challenge, target);
      if (!sameSubject(target.observation.subject, subject)) {
        throw new TypeError(
          `Challenge ${challenge.record_id} targets a different scoped subject.`,
        );
      }
      const slot = sha256Id({
        schema: "cashloom.karma-challenge-slot/v2",
        challenger_key_id: challenge.challenge.challenger_key_id,
        target_observation_record_id: targetId,
      });
      const first = challengeSlots.get(slot);
      if (first !== undefined) {
        throw new TypeError(
          `Challenges ${first} and ${challenge.record_id} repeat one challenger/target slot.`,
        );
      }
      challengeSlots.set(slot, challenge.record_id);
      return {
        review_record_id: challenge.record_id,
        target_observation_record_id: targetId,
        challenger_key_id: challenge.challenge.challenger_key_id,
        challenged_at: challenge.challenge.challenged_at,
        evidence_sha256: challenge.challenge.evidence.map(({ sha256 }) =>
          sha256),
        effect_scope: "report-only" as const,
      };
    },
  ).sort((left, right) =>
    left.review_record_id < right.review_record_id
      ? -1
      : left.review_record_id > right.review_record_id ? 1 : 0);

  // Phase 3: filter only issuer-authorized withdrawals, then delegate all
  // matching and recommendation logic to the unchanged ordinary evaluator.
  const withdrawnIds = withdrawalSummaries
    .map(({ target_observation_record_id }) => target_observation_record_id)
    .sort();
  const withdrawnSet = new Set(withdrawnIds);
  const activeObservations = observations.filter(({ record_id }) =>
    !withdrawnSet.has(record_id));
  const base = evaluateV2Karma({
    subject,
    observation_records: activeObservations,
    policy,
    evaluated_at: evaluatedAt,
  });

  const originalIds = [...observationsById.keys()].sort();
  const activeIds = activeObservations.map(({ record_id }) => record_id).sort();
  const withdrawalMappings = withdrawalSummaries.map((summary) => ({
    review_record_id: summary.review_record_id,
    target_observation_record_id: summary.target_observation_record_id,
  }));
  const challengeMappings = challengeSummaries.map((summary) => ({
    review_record_id: summary.review_record_id,
    target_observation_record_id: summary.target_observation_record_id,
  }));
  const reviewBundleHash = sha256Id({
    schema: KARMA_REVIEW_BUNDLE_SCHEMA,
    subject,
    policy_hash: policyHash,
    evaluated_at: evaluatedAt,
    original_observation_record_ids: originalIds,
    withdrawal_mappings: withdrawalMappings,
    challenge_mappings: challengeMappings,
  });

  return deepFreeze({
    ...base,
    schema: KARMA_REVIEW_EVALUATION_SCHEMA,
    review_bundle_hash: reviewBundleHash,
    original_observation_record_ids: originalIds,
    active_observation_record_ids: activeIds,
    withdrawn_observation_record_ids: withdrawnIds,
    withdrawal_record_ids: withdrawalSummaries.map(
      ({ review_record_id }) => review_record_id,
    ),
    challenge_record_ids: challengeSummaries.map(
      ({ review_record_id }) => review_record_id,
    ),
    withdrawals: withdrawalSummaries,
    challenges: challengeSummaries,
    notices: [
      ...base.notices,
      "Only an exact observation issuer's valid signed withdrawal removed an observation from this evaluation.",
      "Challenges are signed report-only claims; their signer, count, timing, and evidence do not alter rule matching or recommendation.",
      "A compromised observation issuer can withdraw that issuer's own claims; key compromise is not resolved by this protocol.",
    ],
  });
}
