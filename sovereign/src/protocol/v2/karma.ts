/**
 * CashLoom KARMA behavioural observations and participant-local policies.
 *
 * An observation is one issuer's bounded claim about an observable event. It
 * is not identity, intent, guilt, account standing, or a platform verdict.
 * Subject commitments are deliberately scoped to one local context so a
 * commitment cannot safely become a global identifier.
 *
 * This module is pure: it performs no discovery, evidence fetching, scoring,
 * payment action, account mutation, or policy distribution.
 */

import {
  assertSha256Id,
  assertTimestamp,
  canonicalJsonBytes,
  decodeFixedBase64Url,
  sha256Id,
  snapshotJsonData,
  type JsonValue,
  type Sha256Id,
} from "@agenttool/wallet";

export const KARMA_OBSERVATION_SCHEMA =
  "cashloom.karma-observation/v2" as const;
export const KARMA_OBSERVATION_WITHDRAWAL_SCHEMA =
  "cashloom.karma-observation-withdrawal/v2" as const;
export const KARMA_OBSERVATION_CHALLENGE_SCHEMA =
  "cashloom.karma-observation-challenge/v2" as const;
export const KARMA_POLICY_SCHEMA = "cashloom.karma-policy/v2" as const;
export const KARMA_SUBJECT_COMMITMENT_SCHEMA =
  "cashloom.karma-subject-commitment/v2" as const;

export const KARMA_SUBJECT_SCOPES = Object.freeze([
  "account-session",
  "custody-handoff",
  "market-trade",
  "payment-attempt",
] as const);

/** Closed observable vocabulary; none of these values assert identity or intent. */
export const KARMA_METRICS = Object.freeze([
  "account.authentication-failure.count",
  "account.authentication-success.count",
  "custody.handoff-completed.count",
  "custody.seal-mismatch.count",
  "market.completed-trade.count",
  "market.dispute-opened.count",
  "market.duplicate-recovery-attempt.count",
  "market.order-cancellation.count",
  "market.return-item-mismatch.count",
  "market.shipment-deadline-missed.count",
  "payment.attempt-failed.count",
  "payment.attempt-succeeded.count",
] as const);

export const KARMA_COMPARISONS = Object.freeze([
  "at-least",
  "at-most",
  "equal",
] as const);

/** Advisory outputs only; evaluation cannot carry out any of them. */
export const KARMA_RECOMMENDATIONS = Object.freeze([
  "increase-friction",
  "manual-review",
  "proceed",
  "withhold-settlement-handoff",
] as const);

export type KarmaSubjectScope = (typeof KARMA_SUBJECT_SCOPES)[number];
export type KarmaMetric = (typeof KARMA_METRICS)[number];
export type KarmaComparison = (typeof KARMA_COMPARISONS)[number];
export type KarmaRecommendation = (typeof KARMA_RECOMMENDATIONS)[number];

/** Prevents evidence or policy rules from being laundered across contexts. */
export const KARMA_SCOPE_BY_METRIC: Readonly<Record<KarmaMetric, KarmaSubjectScope>> =
  Object.freeze({
    "account.authentication-failure.count": "account-session",
    "account.authentication-success.count": "account-session",
    "custody.handoff-completed.count": "custody-handoff",
    "custody.seal-mismatch.count": "custody-handoff",
    "market.completed-trade.count": "market-trade",
    "market.dispute-opened.count": "market-trade",
    "market.duplicate-recovery-attempt.count": "market-trade",
    "market.order-cancellation.count": "market-trade",
    "market.return-item-mismatch.count": "market-trade",
    "market.shipment-deadline-missed.count": "market-trade",
    "payment.attempt-failed.count": "payment-attempt",
    "payment.attempt-succeeded.count": "payment-attempt",
  });

export interface KarmaSubjectCommitmentReveal {
  readonly schema: typeof KARMA_SUBJECT_COMMITMENT_SCHEMA;
  readonly scope: KarmaSubjectScope;
  /** Content address for the local trade, attempt, handoff, or session. */
  readonly scope_ref: Sha256Id;
  /** Local identifier; never included in the published observation. */
  readonly local_subject_ref: string;
  /** Canonical base64url encoding of exactly 128 bits of random salt. */
  readonly nonce: string;
}

export interface KarmaSubjectCommitment {
  readonly scheme: typeof KARMA_SUBJECT_COMMITMENT_SCHEMA;
  readonly scope: KarmaSubjectScope;
  readonly scope_ref: Sha256Id;
  readonly commitment: Sha256Id;
}

export interface KarmaEvidenceReference {
  readonly sha256: Sha256Id;
}

export interface KarmaObservation {
  readonly schema: typeof KARMA_OBSERVATION_SCHEMA;
  /** Must equal the self-certifying authority of the signed v2 envelope. */
  readonly issuer_key_id: Sha256Id;
  readonly assertion_scope: "issuer-observation-only";
  readonly subject: KarmaSubjectCommitment;
  readonly metric: KarmaMetric;
  readonly value: number;
  readonly window: {
    readonly started_at: string;
    readonly ended_at: string;
  };
  readonly observed_at: string;
  readonly evidence: readonly KarmaEvidenceReference[];
}

/** Issuer-authorized removal of one exact observation from local evaluation. */
export interface KarmaObservationWithdrawal {
  readonly schema: typeof KARMA_OBSERVATION_WITHDRAWAL_SCHEMA;
  /** Must match both the review envelope and target observation issuer. */
  readonly issuer_key_id: Sha256Id;
  readonly assertion_scope: "issuer-withdrawal-only";
  readonly subject: KarmaSubjectCommitment;
  readonly target_observation_record_id: Sha256Id;
  readonly withdrawn_at: string;
  readonly evidence: readonly KarmaEvidenceReference[];
}

/** A signed report that carries no withdrawal or recommendation authority. */
export interface KarmaObservationChallenge {
  readonly schema: typeof KARMA_OBSERVATION_CHALLENGE_SCHEMA;
  /** Must match the review envelope; it need not match the target issuer. */
  readonly challenger_key_id: Sha256Id;
  readonly assertion_scope: "challenger-report-only";
  readonly subject: KarmaSubjectCommitment;
  readonly target_observation_record_id: Sha256Id;
  readonly challenged_at: string;
  readonly evidence: readonly KarmaEvidenceReference[];
}

export interface KarmaPolicyRule {
  readonly rule_id: string;
  readonly metric: KarmaMetric;
  readonly comparison: KarmaComparison;
  readonly threshold: number;
  /** Local pins only. Empty/open/global issuer sets are deliberately invalid. */
  readonly accepted_issuer_key_ids: readonly Sha256Id[];
  readonly minimum_unique_issuers: number;
  /** Count applies only to observation windows at or below this duration. */
  readonly maximum_window_seconds: number;
  readonly max_age_seconds: number | null;
  readonly recommendation: KarmaRecommendation;
}

export interface KarmaPolicy {
  readonly schema: typeof KARMA_POLICY_SCHEMA;
  readonly policy_id: string;
  readonly subject_scope: KarmaSubjectScope;
  readonly default_recommendation: KarmaRecommendation;
  readonly rules: readonly KarmaPolicyRule[];
}

const MAX_TOKEN_BYTES = 128;
const MAX_LOCAL_SUBJECT_BYTES = 512;
const MAX_EVIDENCE = 16;
const MAX_RULES = 64;
const MAX_ISSUERS = 64;
const MAX_VALUE = 1_000_000_000;
const MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const MAX_WINDOW_SECONDS = 365 * 24 * 60 * 60;
const MAX_OBSERVATION_BYTES = 24 * 1024;
const MAX_REVIEW_BYTES = 8 * 1024;
const MAX_POLICY_BYTES = 32 * 1024;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
const RESERVED_AUTHORITY_TOKEN = /^(?:cashloom|cambridgetcg|cambridge)[.:/_-]+(?:verified|approved|certified|legitimate|trusted)(?:[.:/_-]|$)/iu;

type JsonObject = Record<string, unknown>;

const own = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalid = (path: string, detail: string): never => {
  throw new TypeError(`${path} ${detail}`);
};

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "must be a plain object.");
  }
  const result = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string") {
      return invalid(path, "must not contain symbol properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      invalid(`${path}.${key}`, "must be an enumerable data property.");
    }
    if (!allowed.has(key)) invalid(`${path}.${key}`, "is not an allowed field.");
  }
  for (const key of required) {
    if (!own(result, key)) invalid(`${path}.${key}`, "is required.");
  }
  return result;
}

function boundedSnapshot(
  value: unknown,
  path: string,
  maximumBytes: number,
): JsonValue {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotJsonData(value);
  } catch (cause) {
    throw new TypeError(`${path} must be safe canonical JSON data.`, { cause });
  }
  if (canonicalJsonBytes(snapshot).byteLength > maximumBytes) {
    return invalid(path, `must not exceed ${maximumBytes} canonical bytes.`);
  }
  return snapshot;
}

function literal<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}.`);
  return expected;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return invalid(path, `must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || new TextEncoder().encode(value).byteLength > maximum
  ) {
    return invalid(path, `must be a trimmed bounded UTF-8 string of at most ${maximum} bytes.`);
  }
  return value;
}

function token(value: unknown, path: string): string {
  const parsed = boundedString(value, path, MAX_TOKEN_BYTES);
  if (!TOKEN.test(parsed)) invalid(path, "must be a canonical token.");
  if (RESERVED_AUTHORITY_TOKEN.test(parsed)) {
    invalid(path, "uses a reserved platform-authority phrase.");
  }
  return parsed;
}

function shaId(value: unknown, path: string): Sha256Id {
  assertSha256Id(value, path);
  return value;
}

function timestamp(value: unknown, path: string): string {
  assertTimestamp(value, path);
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    return invalid(path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) {
    return invalid(path, `must be an array with at most ${maximum} entries.`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  expected.push("length");
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    return invalid(path, "must be dense and contain no extra properties.");
  }
  return value;
}

function sortedUniqueShaIds(
  value: unknown,
  path: string,
  maximum: number,
): Sha256Id[] {
  const parsed = array(value, path, maximum).map((entry, index) =>
    shaId(entry, `${path}[${index}]`));
  const sorted = [...parsed].sort();
  if (
    new Set(parsed).size !== parsed.length
    || parsed.some((entry, index) => entry !== sorted[index])
  ) {
    invalid(path, "must be unique and lexicographically sorted.");
  }
  return parsed;
}

function subject(value: unknown, path: string): KarmaSubjectCommitment {
  const root = exactObject(value, path, [
    "scheme",
    "scope",
    "scope_ref",
    "commitment",
  ]);
  return {
    scheme: literal(
      root.scheme,
      KARMA_SUBJECT_COMMITMENT_SCHEMA,
      `${path}.scheme`,
    ),
    scope: enumValue(root.scope, KARMA_SUBJECT_SCOPES, `${path}.scope`),
    scope_ref: shaId(root.scope_ref, `${path}.scope_ref`),
    commitment: shaId(root.commitment, `${path}.commitment`),
  };
}

function evidence(value: unknown, path: string): KarmaEvidenceReference {
  const root = exactObject(value, path, ["sha256"]);
  return {
    sha256: shaId(root.sha256, `${path}.sha256`),
  };
}

function evidenceList(value: unknown, path: string): KarmaEvidenceReference[] {
  const parsed = array(value, path, MAX_EVIDENCE).map((entry, index) =>
    evidence(entry, `${path}[${index}]`));
  const identities = parsed.map((entry) => entry.sha256);
  const sorted = [...identities].sort();
  if (
    new Set(identities).size !== identities.length
    || identities.some((entry, index) => entry !== sorted[index])
  ) {
    invalid(path, "must contain unique lexicographically sorted digests.");
  }
  return parsed;
}

export function parseKarmaSubjectCommitmentReveal(
  value: unknown,
): KarmaSubjectCommitmentReveal {
  const root = exactObject(
    boundedSnapshot(value, "reveal", 2_048),
    "reveal",
    ["schema", "scope", "scope_ref", "local_subject_ref", "nonce"],
  );
  const encodedNonce = boundedString(root.nonce, "reveal.nonce", 64);
  decodeFixedBase64Url(encodedNonce, 16, "reveal.nonce");
  return {
    schema: literal(
      root.schema,
      KARMA_SUBJECT_COMMITMENT_SCHEMA,
      "reveal.schema",
    ),
    scope: enumValue(root.scope, KARMA_SUBJECT_SCOPES, "reveal.scope"),
    scope_ref: shaId(root.scope_ref, "reveal.scope_ref"),
    local_subject_ref: boundedString(
      root.local_subject_ref,
      "reveal.local_subject_ref",
      MAX_LOCAL_SUBJECT_BYTES,
    ),
    nonce: encodedNonce,
  };
}

export function createKarmaSubjectCommitment(
  revealValue: unknown,
): Readonly<KarmaSubjectCommitment> {
  const reveal = parseKarmaSubjectCommitmentReveal(revealValue);
  return Object.freeze({
    scheme: KARMA_SUBJECT_COMMITMENT_SCHEMA,
    scope: reveal.scope,
    scope_ref: reveal.scope_ref,
    commitment: sha256Id(reveal),
  });
}

export function parseKarmaSubjectCommitment(
  value: unknown,
): KarmaSubjectCommitment {
  return subject(
    boundedSnapshot(value, "subject", 1_024),
    "subject",
  );
}

export function parseKarmaObservation(value: unknown): KarmaObservation {
  const root = exactObject(
    boundedSnapshot(value, "observation", MAX_OBSERVATION_BYTES),
    "observation",
    [
      "schema",
      "issuer_key_id",
      "assertion_scope",
      "subject",
      "metric",
      "value",
      "window",
      "observed_at",
      "evidence",
    ],
  );
  literal(root.schema, KARMA_OBSERVATION_SCHEMA, "observation.schema");
  const window = exactObject(root.window, "observation.window", [
    "started_at",
    "ended_at",
  ]);
  const startedAt = timestamp(window.started_at, "observation.window.started_at");
  const endedAt = timestamp(window.ended_at, "observation.window.ended_at");
  const observedAt = timestamp(root.observed_at, "observation.observed_at");
  const parsedSubject = subject(root.subject, "observation.subject");
  const metric = enumValue(root.metric, KARMA_METRICS, "observation.metric");
  if (KARMA_SCOPE_BY_METRIC[metric] !== parsedSubject.scope) {
    invalid(
      "observation.metric",
      `requires subject.scope ${KARMA_SCOPE_BY_METRIC[metric]}.`,
    );
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    invalid("observation.window", "ended_at must not predate started_at.");
  }
  if (Date.parse(endedAt) - Date.parse(startedAt) > MAX_WINDOW_SECONDS * 1_000) {
    invalid(
      "observation.window",
      `must not exceed ${MAX_WINDOW_SECONDS} seconds.`,
    );
  }
  if (Date.parse(observedAt) < Date.parse(endedAt)) {
    invalid("observation.observed_at", "must not predate the observation window.");
  }
  return {
    schema: KARMA_OBSERVATION_SCHEMA,
    issuer_key_id: shaId(root.issuer_key_id, "observation.issuer_key_id"),
    assertion_scope: literal(
      root.assertion_scope,
      "issuer-observation-only",
      "observation.assertion_scope",
    ),
    subject: parsedSubject,
    metric,
    value: boundedInteger(root.value, "observation.value", 0, MAX_VALUE),
    window: { started_at: startedAt, ended_at: endedAt },
    observed_at: observedAt,
    evidence: evidenceList(root.evidence, "observation.evidence"),
  };
}

export function karmaObservationHash(value: unknown): Sha256Id {
  return sha256Id(parseKarmaObservation(value));
}

export function parseKarmaObservationWithdrawal(
  value: unknown,
): KarmaObservationWithdrawal {
  const root = exactObject(
    boundedSnapshot(value, "withdrawal", MAX_REVIEW_BYTES),
    "withdrawal",
    [
      "schema",
      "issuer_key_id",
      "assertion_scope",
      "subject",
      "target_observation_record_id",
      "withdrawn_at",
      "evidence",
    ],
  );
  return {
    schema: literal(
      root.schema,
      KARMA_OBSERVATION_WITHDRAWAL_SCHEMA,
      "withdrawal.schema",
    ),
    issuer_key_id: shaId(root.issuer_key_id, "withdrawal.issuer_key_id"),
    assertion_scope: literal(
      root.assertion_scope,
      "issuer-withdrawal-only",
      "withdrawal.assertion_scope",
    ),
    subject: subject(root.subject, "withdrawal.subject"),
    target_observation_record_id: shaId(
      root.target_observation_record_id,
      "withdrawal.target_observation_record_id",
    ),
    withdrawn_at: timestamp(root.withdrawn_at, "withdrawal.withdrawn_at"),
    evidence: evidenceList(root.evidence, "withdrawal.evidence"),
  };
}

export function karmaObservationWithdrawalHash(value: unknown): Sha256Id {
  return sha256Id(parseKarmaObservationWithdrawal(value));
}

export function parseKarmaObservationChallenge(
  value: unknown,
): KarmaObservationChallenge {
  const root = exactObject(
    boundedSnapshot(value, "challenge", MAX_REVIEW_BYTES),
    "challenge",
    [
      "schema",
      "challenger_key_id",
      "assertion_scope",
      "subject",
      "target_observation_record_id",
      "challenged_at",
      "evidence",
    ],
  );
  return {
    schema: literal(
      root.schema,
      KARMA_OBSERVATION_CHALLENGE_SCHEMA,
      "challenge.schema",
    ),
    challenger_key_id: shaId(
      root.challenger_key_id,
      "challenge.challenger_key_id",
    ),
    assertion_scope: literal(
      root.assertion_scope,
      "challenger-report-only",
      "challenge.assertion_scope",
    ),
    subject: subject(root.subject, "challenge.subject"),
    target_observation_record_id: shaId(
      root.target_observation_record_id,
      "challenge.target_observation_record_id",
    ),
    challenged_at: timestamp(root.challenged_at, "challenge.challenged_at"),
    evidence: evidenceList(root.evidence, "challenge.evidence"),
  };
}

export function karmaObservationChallengeHash(value: unknown): Sha256Id {
  return sha256Id(parseKarmaObservationChallenge(value));
}

function policyRule(
  value: unknown,
  path: string,
  subjectScope: KarmaSubjectScope,
): KarmaPolicyRule {
  const root = exactObject(value, path, [
    "rule_id",
    "metric",
    "comparison",
    "threshold",
    "accepted_issuer_key_ids",
    "minimum_unique_issuers",
    "maximum_window_seconds",
    "max_age_seconds",
    "recommendation",
  ]);
  const issuers = sortedUniqueShaIds(
    root.accepted_issuer_key_ids,
    `${path}.accepted_issuer_key_ids`,
    MAX_ISSUERS,
  );
  if (issuers.length === 0) {
    invalid(
      `${path}.accepted_issuer_key_ids`,
      "must contain explicit participant-selected issuer keys.",
    );
  }
  const metric = enumValue(root.metric, KARMA_METRICS, `${path}.metric`);
  if (KARMA_SCOPE_BY_METRIC[metric] !== subjectScope) {
    invalid(
      `${path}.metric`,
      `requires policy.subject_scope ${KARMA_SCOPE_BY_METRIC[metric]}.`,
    );
  }
  return {
    rule_id: token(root.rule_id, `${path}.rule_id`),
    metric,
    comparison: enumValue(
      root.comparison,
      KARMA_COMPARISONS,
      `${path}.comparison`,
    ),
    threshold: boundedInteger(root.threshold, `${path}.threshold`, 0, MAX_VALUE),
    accepted_issuer_key_ids: issuers,
    minimum_unique_issuers: boundedInteger(
      root.minimum_unique_issuers,
      `${path}.minimum_unique_issuers`,
      1,
      issuers.length,
    ),
    maximum_window_seconds: boundedInteger(
      root.maximum_window_seconds,
      `${path}.maximum_window_seconds`,
      0,
      MAX_WINDOW_SECONDS,
    ),
    max_age_seconds: root.max_age_seconds === null
      ? null
      : boundedInteger(
        root.max_age_seconds,
        `${path}.max_age_seconds`,
        0,
        MAX_AGE_SECONDS,
      ),
    recommendation: enumValue(
      root.recommendation,
      KARMA_RECOMMENDATIONS,
      `${path}.recommendation`,
    ),
  };
}

export function parseKarmaPolicy(value: unknown): KarmaPolicy {
  const root = exactObject(
    boundedSnapshot(value, "policy", MAX_POLICY_BYTES),
    "policy",
    [
      "schema",
      "policy_id",
      "subject_scope",
      "default_recommendation",
      "rules",
    ],
  );
  literal(root.schema, KARMA_POLICY_SCHEMA, "policy.schema");
  const subjectScope = enumValue(
    root.subject_scope,
    KARMA_SUBJECT_SCOPES,
    "policy.subject_scope",
  );
  const rules = array(root.rules, "policy.rules", MAX_RULES).map(
    (entry, index) => policyRule(
      entry,
      `policy.rules[${index}]`,
      subjectScope,
    ),
  );
  const ruleIds = rules.map(({ rule_id }) => rule_id);
  const sorted = [...ruleIds].sort();
  if (
    new Set(ruleIds).size !== ruleIds.length
    || ruleIds.some((ruleId, index) => ruleId !== sorted[index])
  ) {
    invalid("policy.rules", "must have unique lexicographically sorted rule ids.");
  }
  return {
    schema: KARMA_POLICY_SCHEMA,
    policy_id: token(root.policy_id, "policy.policy_id"),
    subject_scope: subjectScope,
    default_recommendation: enumValue(
      root.default_recommendation,
      KARMA_RECOMMENDATIONS,
      "policy.default_recommendation",
    ),
    rules,
  };
}

export function karmaPolicyHash(value: unknown): Sha256Id {
  return sha256Id(parseKarmaPolicy(value));
}
