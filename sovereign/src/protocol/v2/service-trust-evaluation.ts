/**
 * Verified, bundle-scoped service trust evaluation.
 *
 * This is the public evaluation boundary. Raw profile and attestation payloads
 * cannot reach the decision engine: every record and every profile parent is
 * first content-addressed, signature-verified, and authority-linked by v2.
 */

import {
  assertTimestamp,
  sha256Id,
  type Sha256Id,
} from "@agenttool/wallet";

import {
  V2_SCHEMAS,
  verifyV2Record,
  verifyV2RecordLink,
  type ServiceAttestationRecordCore,
  type ServiceProfileRecordCore,
  type VerifiedV2Record,
} from "./records.ts";
import {
  parseServiceTrustPolicy,
  serviceTrustPolicyHash,
  type ServiceAttestationRule,
  type ServiceTrustDecision,
  type ServiceTrustDecisionKind,
  type ServiceTrustFinding,
  type ServiceTrustFindingCode,
} from "./service-trust.ts";

export const SERVICE_TRUST_EVIDENCE_BUNDLE_SCHEMA =
  "cashloom.service-trust-evidence-bundle/v2" as const;

export interface EvaluateV2ServiceTrustInput {
  /** Current profile; it must be active at evaluated_at. */
  readonly profile_record: unknown;
  /** Optional expired/superseded profiles signed by the same service key. */
  readonly profile_history_records?: readonly unknown[];
  /** Signed attestations whose exact profile parents are supplied above. */
  readonly attestation_records: readonly unknown[];
  readonly policy: unknown;
  /** Explicit canonical time; no ambient clock enters the decision. */
  readonly evaluated_at: string;
}

const MAX_PROFILE_RECORDS = 64;
const MAX_ATTESTATION_RECORDS = 256;

function denseArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${path} must be an array with at most ${maximum} entries.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError(`${path} must not be sparse.`);
    }
  }
  return value;
}

function expectProfileRecord(
  value: unknown,
  now?: string,
): VerifiedV2Record<ServiceProfileRecordCore> {
  const record = verifyV2Record(value, now === undefined ? {} : { now });
  if (record.schema !== V2_SCHEMAS.service_profile) {
    throw new TypeError("Service trust evidence requires service profile records.");
  }
  return record;
}

function expectAttestationRecord(
  value: unknown,
): VerifiedV2Record<ServiceAttestationRecordCore> {
  const record = verifyV2Record(value);
  if (record.schema !== V2_SCHEMAS.service_attestation) {
    throw new TypeError("Service trust evidence requires service attestation records.");
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

function matchesRule(
  record: VerifiedV2Record<ServiceAttestationRecordCore>,
  rule: ServiceAttestationRule,
  evaluatedMs: number,
): boolean {
  const assertion = record.attestation;
  if (
    assertion.claim_type !== rule.claim_type
    || assertion.stance !== rule.stance
    || !rule.accepted_issuer_key_ids.includes(assertion.issuer_key_id)
    || !rule.accepted_bases.includes(assertion.basis)
  ) {
    return false;
  }
  if (
    rule.accepted_evidence_kinds.length > 0
    && !assertion.evidence.some(({ kind }) =>
      rule.accepted_evidence_kinds.includes(kind))
  ) {
    return false;
  }
  const observedMs = Date.parse(assertion.observed_at);
  if (observedMs > evaluatedMs) return false;
  return rule.max_age_seconds === null
    || evaluatedMs - observedMs <= rule.max_age_seconds * 1_000;
}

/**
 * Evaluate one exact, verified evidence bundle against one explicit policy.
 * `bundle_matches_policy` never means that a shop is legitimate or that the
 * bundle is complete; all supplied IDs and the bundle hash are returned.
 */
export function evaluateV2ServiceTrust(
  input: EvaluateV2ServiceTrustInput,
): Readonly<ServiceTrustDecision> {
  assertTimestamp(input.evaluated_at, "input.evaluated_at");
  const evaluatedAt = input.evaluated_at;
  const evaluatedMs = Date.parse(evaluatedAt);
  const policy = parseServiceTrustPolicy(input.policy);
  const policyHash = serviceTrustPolicyHash(policy);
  const currentProfile = expectProfileRecord(input.profile_record, evaluatedAt);
  const historyValues = denseArray(
    input.profile_history_records ?? [],
    "input.profile_history_records",
    MAX_PROFILE_RECORDS - 1,
  );
  const profiles = [
    currentProfile,
    ...historyValues.map((value) => expectProfileRecord(value)),
  ];
  const profilesById = new Map<Sha256Id, VerifiedV2Record<ServiceProfileRecordCore>>();
  for (const profile of profiles) {
    if (profilesById.has(profile.record_id)) {
      throw new TypeError("input profile records must not repeat a record ID.");
    }
    if (profile.authority.key_id !== currentProfile.authority.key_id) {
      throw new TypeError(
        "Every historical profile must have the current profile's service key.",
      );
    }
    if (Date.parse(profile.issued_at) > evaluatedMs) {
      throw new TypeError("A supplied profile cannot postdate input.evaluated_at.");
    }
    profilesById.set(profile.record_id, profile);
  }

  const attestationValues = denseArray(
    input.attestation_records,
    "input.attestation_records",
    MAX_ATTESTATION_RECORDS,
  );
  const attestations = attestationValues.map((value) => {
    const record = expectAttestationRecord(value);
    if (Date.parse(record.issued_at) > evaluatedMs) {
      throw new TypeError(
        `Attestation ${record.record_id} was issued after input.evaluated_at.`,
      );
    }
    const parent = profilesById.get(record.attestation.profile_record_id);
    if (parent === undefined) {
      throw new TypeError(
        `Attestation ${record.record_id} requires its exact profile parent in the evidence bundle.`,
      );
    }
    verifyV2RecordLink(record, parent);
    return record;
  });
  const suppliedIds = attestations.map(({ record_id }) => record_id).sort();
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw new TypeError("input.attestation_records must not repeat a record ID.");
  }

  const consideredProfileIds = policy.attestation_profile_scope === "exact-profile"
    ? [currentProfile.record_id]
    : [...profilesById.keys()].sort();
  const consideredProfileSet = new Set(consideredProfileIds);
  const relevant = attestations.filter(({ attestation }) =>
    consideredProfileSet.has(attestation.profile_record_id));
  const outOfScopeIds = attestations
    .filter(({ attestation }) => !consideredProfileSet.has(attestation.profile_record_id))
    .map(({ record_id }) => record_id)
    .sort();

  const findings: ServiceTrustFinding[] = [];
  const used = new Set<Sha256Id>();
  const add = (
    code: ServiceTrustFindingCode,
    path: string,
    disposition: ServiceTrustFinding["disposition"],
    detail: string,
  ): void => {
    findings.push({ code, path, disposition, detail });
  };

  for (const capability of policy.required_capabilities) {
    if (!currentProfile.profile.capabilities.includes(capability)) {
      add(
        "capability-undisclosed",
        `profile.capabilities.${capability}`,
        "insufficient",
        `The self-published profile does not disclose capability ${capability}.`,
      );
    }
  }
  for (const requirement of policy.required_claims) {
    const claim = currentProfile.profile.claims.find(
      (candidate) => candidate.claim_type === requirement.claim_type,
    );
    if (claim === undefined) {
      add(
        "claim-undisclosed",
        `profile.claims.${requirement.claim_type}`,
        "insufficient",
        `The self-published profile does not include claim ${requirement.claim_type}.`,
      );
    } else if (!requirement.accepted_disclosures.includes(claim.disclosure.mode)) {
      add(
        "claim-disclosure",
        `profile.claims.${requirement.claim_type}.disclosure`,
        "reject",
        `Disclosure mode ${claim.disclosure.mode} is not accepted by this policy.`,
      );
    }
  }

  if (policy.accepted_settlement_provider_key_ids.length > 0) {
    const claimed = currentProfile.profile.claimed_settlement_provider_key_ids;
    if (claimed.length === 0) {
      add(
        "settlement-provider",
        "profile.claimed_settlement_provider_key_ids",
        "insufficient",
        "The profile does not claim a settlement-provider key accepted by this policy.",
      );
    } else if (!claimed.some((keyId) =>
      policy.accepted_settlement_provider_key_ids.includes(keyId))) {
      add(
        "settlement-provider",
        "profile.claimed_settlement_provider_key_ids",
        "reject",
        "The claimed settlement-provider keys do not intersect this policy.",
      );
    }
  }
  if (policy.accepted_dispute_resolver_key_ids.length > 0) {
    const claimed = currentProfile.profile.claimed_dispute_resolver_key_ids;
    if (claimed.length === 0) {
      add(
        "dispute-resolver",
        "profile.claimed_dispute_resolver_key_ids",
        "insufficient",
        "The profile does not claim a dispute-resolver key accepted by this policy.",
      );
    } else if (!claimed.some((keyId) =>
      policy.accepted_dispute_resolver_key_ids.includes(keyId))) {
      add(
        "dispute-resolver",
        "profile.claimed_dispute_resolver_key_ids",
        "reject",
        "The claimed dispute-resolver keys do not intersect this policy.",
      );
    }
  }

  for (const rule of policy.attestation_rules) {
    const matches = relevant.filter((record) =>
      matchesRule(record, rule, evaluatedMs));
    const uniqueIssuers = new Set(matches.map(({ attestation }) =>
      attestation.issuer_key_id));
    const uniqueInteractions = new Set(matches.flatMap(({ attestation }) =>
      attestation.interaction_ref === null ? [] : [attestation.interaction_ref]));
    for (const match of matches) used.add(match.record_id);
    if (uniqueIssuers.size < rule.minimum_unique_issuers) {
      add(
        "attestation-quorum",
        `policy.attestation_rules.${rule.rule_id}`,
        "insufficient",
        `The bundle has ${uniqueIssuers.size} accepted unique issuer(s); ${rule.minimum_unique_issuers} required.`,
      );
    }
    if (uniqueInteractions.size < rule.minimum_unique_interactions) {
      add(
        "attestation-interaction-quorum",
        `policy.attestation_rules.${rule.rule_id}`,
        "insufficient",
        `The bundle has ${uniqueInteractions.size} accepted unique interaction reference(s); ${rule.minimum_unique_interactions} required.`,
      );
    }
    if (
      rule.maximum_unique_issuers !== null
      && uniqueIssuers.size > rule.maximum_unique_issuers
    ) {
      add(
        "attestation-limit",
        `policy.attestation_rules.${rule.rule_id}`,
        "reject",
        `The bundle has ${uniqueIssuers.size} accepted unique issuer(s); maximum is ${rule.maximum_unique_issuers}.`,
      );
    }
  }

  const decision: ServiceTrustDecisionKind = findings.some(
    ({ disposition }) => disposition === "reject",
  )
    ? "bundle_does_not_match_policy"
    : findings.length > 0
      ? "insufficient_evidence"
      : "bundle_matches_policy";
  const allProfileIds = [...profilesById.keys()].sort();
  const evidenceBundleHash = sha256Id({
    schema: SERVICE_TRUST_EVIDENCE_BUNDLE_SCHEMA,
    current_profile_record_id: currentProfile.record_id,
    profile_record_ids: allProfileIds,
    attestation_record_ids: suppliedIds,
    evaluated_at: evaluatedAt,
  });

  return deepFreeze({
    decision,
    service_key_id: currentProfile.profile.service_key_id,
    profile_record_id: currentProfile.record_id,
    profile_record_ids_considered: consideredProfileIds,
    attestation_profile_scope: policy.attestation_profile_scope,
    policy_id: policy.policy_id,
    policy_hash: policyHash,
    evaluated_at: evaluatedAt,
    evidence_bundle_hash: evidenceBundleHash,
    supplied_evidence_record_ids: suppliedIds,
    out_of_scope_evidence_record_ids: outOfScopeIds,
    findings,
    evidence_used: [...used].sort(),
    notices: [
      "This result applies only to the exact supplied evidence bundle and caller-selected policy; it is not a CashLoom endorsement or a completeness claim.",
      "Signatures and content IDs prove authorship and integrity, not truth, independence, insurance, solvency, competence, or regulatory status.",
      "Absence from this bundle is not proof that no adverse or contradictory assertion exists; consult independently selected mirrors and direct sources.",
      "Profiled settlement-provider and resolver relationships are self-claims unless separately supported by an accepted counterparty attestation.",
      "Interaction and evidence references are issuer-claimed digests; this evaluator does not fetch or prove the referenced event or material.",
    ],
  });
}
