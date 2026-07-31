/**
 * Permissionless service publication and participant-selected trust policy.
 *
 * This module is deliberately pure. It does not discover providers, fetch
 * evidence, choose trust roots, rank shops, hold funds, or decide that anyone
 * is legitimate. It parses bounded assertions and explicit local policies.
 * The sibling service-trust-evaluation module is the sole public decision
 * path and first verifies the signed v2 envelopes and parent links.
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

export const SERVICE_PROFILE_SCHEMA = "cashloom.service-profile/v2" as const;
export const SERVICE_ATTESTATION_SCHEMA =
  "cashloom.service-attestation/v2" as const;
export const SERVICE_TRUST_POLICY_SCHEMA =
  "cashloom.service-trust-policy/v2" as const;
export const SERVICE_DISCLOSURE_COMMITMENT_SCHEMA =
  "cashloom.service-disclosure-commitment/v2" as const;

export type ServiceDisclosure =
  | { readonly mode: "public"; readonly value: string }
  | {
      readonly mode: "commitment";
      readonly scheme: typeof SERVICE_DISCLOSURE_COMMITMENT_SCHEMA;
      readonly digest: Sha256Id;
    }
  | { readonly mode: "undisclosed" };

export interface ServiceDisclosureReveal {
  readonly schema: typeof SERVICE_DISCLOSURE_COMMITMENT_SCHEMA;
  readonly claim_type: string;
  readonly value: string;
  /** Secret canonical base64url encoding of at least 128 bits of random salt. */
  readonly nonce: string;
}

export interface ServiceEvidenceReference {
  readonly kind: string;
  readonly sha256: Sha256Id;
  /** Inert locator. CashLoom never fetches it during parsing or evaluation. */
  readonly url?: string;
}

export interface ServiceProfileClaim {
  readonly claim_type: string;
  readonly disclosure: ServiceDisclosure;
}

export interface ServiceProfile {
  readonly schema: typeof SERVICE_PROFILE_SCHEMA;
  /** Self-certifying authority expected to sign the containing v2 record. */
  readonly service_key_id: Sha256Id;
  readonly provenance: {
    readonly kind: "self-assertion";
    readonly asserted_at: string;
  };
  readonly capabilities: readonly string[];
  readonly claims: readonly ServiceProfileClaim[];
  /** Self-asserted relationships; counterparties must attest separately. */
  readonly claimed_settlement_provider_key_ids: readonly Sha256Id[];
  /** Self-asserted relationships; counterparties must attest separately. */
  readonly claimed_dispute_resolver_key_ids: readonly Sha256Id[];
  readonly evidence: readonly ServiceEvidenceReference[];
}

export type ServiceAttestationBasis =
  | "claimed_evidence_references"
  | "claimed_interaction_reference"
  | "unlinked_assertion";
export type ServiceAttestationStance = "disputes" | "neutral" | "supports";
export type ServiceAttestationProfileScope =
  | "exact-profile"
  | "service-key-history";

export interface ServiceAttestation {
  readonly schema: typeof SERVICE_ATTESTATION_SCHEMA;
  /** Self-certifying authority expected to sign the containing v2 record. */
  readonly issuer_key_id: Sha256Id;
  readonly subject_key_id: Sha256Id;
  /** Exact signed profile record, selected independently of any index. */
  readonly profile_record_id: Sha256Id;
  readonly assertion_scope: "issuer-assertion-only";
  readonly claim_type: string;
  readonly stance: ServiceAttestationStance;
  readonly basis: ServiceAttestationBasis;
  readonly interaction_ref: Sha256Id | null;
  readonly observed_at: string;
  readonly evidence: readonly ServiceEvidenceReference[];
}

export interface RequiredServiceClaim {
  readonly claim_type: string;
  readonly accepted_disclosures: readonly ServiceDisclosure["mode"][];
}

export interface ServiceAttestationRule {
  readonly rule_id: string;
  readonly claim_type: string;
  readonly stance: ServiceAttestationStance;
  /** Explicit consumer-selected roots; an open global count is not supported. */
  readonly accepted_issuer_key_ids: readonly Sha256Id[];
  readonly accepted_bases: readonly ServiceAttestationBasis[];
  /** Empty accepts any evidence kind; references remain issuer assertions. */
  readonly accepted_evidence_kinds: readonly string[];
  readonly minimum_unique_issuers: number;
  readonly minimum_unique_interactions: number;
  readonly maximum_unique_issuers: number | null;
  readonly max_age_seconds: number | null;
}

export interface ServiceTrustPolicy {
  readonly schema: typeof SERVICE_TRUST_POLICY_SCHEMA;
  readonly policy_id: string;
  readonly attestation_profile_scope: ServiceAttestationProfileScope;
  readonly required_capabilities: readonly string[];
  readonly required_claims: readonly RequiredServiceClaim[];
  /** Empty means the policy imposes no settlement-provider condition. */
  readonly accepted_settlement_provider_key_ids: readonly Sha256Id[];
  /** Empty means the policy imposes no dispute-resolver condition. */
  readonly accepted_dispute_resolver_key_ids: readonly Sha256Id[];
  readonly attestation_rules: readonly ServiceAttestationRule[];
}

export type ServiceTrustDecisionKind =
  | "bundle_matches_policy"
  | "bundle_does_not_match_policy"
  | "insufficient_evidence";

export type ServiceTrustFindingCode =
  | "capability-undisclosed"
  | "claim-undisclosed"
  | "claim-disclosure"
  | "settlement-provider"
  | "dispute-resolver"
  | "attestation-quorum"
  | "attestation-interaction-quorum"
  | "attestation-limit";

export interface ServiceTrustFinding {
  readonly code: ServiceTrustFindingCode;
  readonly path: string;
  readonly disposition: "reject" | "insufficient";
  readonly detail: string;
}

export interface ServiceTrustDecision {
  readonly decision: ServiceTrustDecisionKind;
  readonly service_key_id: Sha256Id;
  readonly profile_record_id: Sha256Id;
  readonly profile_record_ids_considered: readonly Sha256Id[];
  readonly attestation_profile_scope: ServiceAttestationProfileScope;
  readonly policy_id: string;
  readonly policy_hash: Sha256Id;
  readonly evaluated_at: string;
  readonly evidence_bundle_hash: Sha256Id;
  readonly supplied_evidence_record_ids: readonly Sha256Id[];
  readonly out_of_scope_evidence_record_ids: readonly Sha256Id[];
  readonly findings: readonly ServiceTrustFinding[];
  readonly evidence_used: readonly Sha256Id[];
  readonly notices: readonly string[];
}

const MAX_TOKEN_BYTES = 128;
const MAX_PUBLIC_VALUE_BYTES = 2_048;
const MAX_URL_BYTES = 2_048;
const MAX_CAPABILITIES = 32;
const MAX_CLAIMS = 64;
const MAX_EVIDENCE = 16;
const MAX_PARTIES = 64;
const MAX_RULES = 64;
const MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const MAX_PROFILE_BYTES = 24 * 1024;
const MAX_ATTESTATION_BYTES = 24 * 1024;
const MAX_POLICY_BYTES = 32 * 1024;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
const RESERVED_AUTHORITY_TOKEN = /^(?:cashloom|cambridgetcg|cambridge)[.:/_-]+(?:verified|approved|certified|legitimate|trusted)(?:[.:/_-]|$)/iu;
const UNSAFE_PUBLIC_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const DISCLOSURE_MODES = ["commitment", "public", "undisclosed"] as const;
const ATTESTATION_BASES = [
  "claimed_evidence_references",
  "claimed_interaction_reference",
  "unlinked_assertion",
] as const;
const ATTESTATION_STANCES = ["disputes", "neutral", "supports"] as const;
const ATTESTATION_PROFILE_SCOPES = [
  "exact-profile",
  "service-key-history",
] as const;

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

function publicValue(value: unknown, path: string): string {
  const parsed = boundedString(value, path, MAX_PUBLIC_VALUE_BYTES);
  if (UNSAFE_PUBLIC_CONTROLS.test(parsed)) {
    return invalid(path, "must not contain control or bidirectional override characters.");
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
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return invalid(`${path}[${index}]`, "must be an enumerable data property.");
    }
  }
  return value;
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

function sortedUniqueTokens(value: unknown, path: string, maximum: number): string[] {
  const parsed = array(value, path, maximum).map((entry, index) =>
    token(entry, `${path}[${index}]`));
  const sorted = [...parsed].sort();
  if (
    new Set(parsed).size !== parsed.length
    || parsed.some((entry, index) => entry !== sorted[index])
  ) {
    invalid(path, "must be unique and lexicographically sorted.");
  }
  return parsed;
}

function sortedUniqueEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  maximum: number,
): T[] {
  const parsed = array(value, path, maximum).map((entry, index) =>
    enumValue(entry, allowed, `${path}[${index}]`));
  const sorted = [...parsed].sort();
  if (
    new Set(parsed).size !== parsed.length
    || parsed.some((entry, index) => entry !== sorted[index])
  ) {
    invalid(path, "must be unique and lexicographically sorted.");
  }
  return parsed;
}

function sortedUniqueShaIds(value: unknown, path: string, maximum: number): Sha256Id[] {
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

function evidence(value: unknown, path: string): ServiceEvidenceReference {
  const root = exactObject(value, path, ["kind", "sha256"], ["url"]);
  const result = {
    kind: token(root.kind, `${path}.kind`),
    sha256: shaId(root.sha256, `${path}.sha256`),
  };
  if (root.url !== undefined) {
    const raw = boundedString(root.url, `${path}.url`, MAX_URL_BYTES);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return invalid(`${path}.url`, "must be an absolute HTTPS URL.");
    }
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== ""
    ) {
      return invalid(
        `${path}.url`,
        "must use HTTPS and contain no credentials, query, or fragment.",
      );
    }
    if (parsed.toString() !== raw) {
      return invalid(`${path}.url`, "must already use canonical URL spelling.");
    }
    return { ...result, url: raw };
  }
  return result;
}

function evidenceList(value: unknown, path: string): ServiceEvidenceReference[] {
  const parsed = array(value, path, MAX_EVIDENCE).map((entry, index) =>
    evidence(entry, `${path}[${index}]`));
  const identities = parsed.map((entry) => `${entry.sha256}\0${entry.kind}`);
  const sorted = [...identities].sort();
  if (
    new Set(identities).size !== identities.length
    || identities.some((entry, index) => entry !== sorted[index])
  ) {
    invalid(path, "must be unique and sorted by digest then kind.");
  }
  return parsed;
}

function disclosure(value: unknown, path: string): ServiceDisclosure {
  const root = exactObject(
    value,
    path,
    ["mode"],
    ["value", "scheme", "digest"],
  );
  const mode = enumValue(root.mode, DISCLOSURE_MODES, `${path}.mode`);
  if (mode === "public") {
    if (!own(root, "value") || own(root, "scheme") || own(root, "digest")) {
      invalid(path, "public disclosure requires value and forbids commitment fields.");
    }
    return {
      mode,
      value: publicValue(root.value, `${path}.value`),
    };
  }
  if (mode === "commitment") {
    if (!own(root, "scheme") || !own(root, "digest") || own(root, "value")) {
      invalid(path, "commitment disclosure requires scheme and digest and forbids value.");
    }
    return {
      mode,
      scheme: literal(
        root.scheme,
        SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
        `${path}.scheme`,
      ),
      digest: shaId(root.digest, `${path}.digest`),
    };
  }
  if (own(root, "value") || own(root, "scheme") || own(root, "digest")) {
    invalid(path, "undisclosed disclosure forbids value and commitment fields.");
  }
  return { mode };
}

export function parseServiceDisclosureReveal(
  value: unknown,
): ServiceDisclosureReveal {
  const root = exactObject(
    boundedSnapshot(value, "reveal", MAX_PUBLIC_VALUE_BYTES + 512),
    "reveal",
    ["schema", "claim_type", "value", "nonce"],
  );
  const nonceValue = boundedString(root.nonce, "reveal.nonce", 64);
  decodeFixedBase64Url(nonceValue, 16, "reveal.nonce");
  return {
    schema: literal(
      root.schema,
      SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
      "reveal.schema",
    ),
    claim_type: token(root.claim_type, "reveal.claim_type"),
    value: publicValue(root.value, "reveal.value"),
    nonce: nonceValue,
  };
}

export function serviceDisclosureCommitmentHash(value: unknown): Sha256Id {
  return sha256Id(parseServiceDisclosureReveal(value));
}

function profileClaim(value: unknown, path: string): ServiceProfileClaim {
  const root = exactObject(value, path, ["claim_type", "disclosure"]);
  return {
    claim_type: token(root.claim_type, `${path}.claim_type`),
    disclosure: disclosure(root.disclosure, `${path}.disclosure`),
  };
}

export function parseServiceProfile(value: unknown): ServiceProfile {
  const root = exactObject(
    boundedSnapshot(value, "profile", MAX_PROFILE_BYTES),
    "profile",
    [
    "schema",
    "service_key_id",
    "provenance",
    "capabilities",
    "claims",
    "claimed_settlement_provider_key_ids",
    "claimed_dispute_resolver_key_ids",
    "evidence",
    ],
  );
  literal(root.schema, SERVICE_PROFILE_SCHEMA, "profile.schema");
  const provenance = exactObject(root.provenance, "profile.provenance", [
    "kind",
    "asserted_at",
  ]);
  literal(provenance.kind, "self-assertion", "profile.provenance.kind");

  const claims = array(root.claims, "profile.claims", MAX_CLAIMS).map(
    (entry, index) => profileClaim(entry, `profile.claims[${index}]`),
  );
  const claimTypes = claims.map((claim) => claim.claim_type);
  const sortedClaimTypes = [...claimTypes].sort();
  if (
    new Set(claimTypes).size !== claimTypes.length
    || claimTypes.some((entry, index) => entry !== sortedClaimTypes[index])
  ) {
    invalid("profile.claims", "must have unique lexicographically sorted claim types.");
  }

  return {
    schema: SERVICE_PROFILE_SCHEMA,
    service_key_id: shaId(root.service_key_id, "profile.service_key_id"),
    provenance: {
      kind: "self-assertion",
      asserted_at: timestamp(
        provenance.asserted_at,
        "profile.provenance.asserted_at",
      ),
    },
    capabilities: sortedUniqueTokens(
      root.capabilities,
      "profile.capabilities",
      MAX_CAPABILITIES,
    ),
    claims,
    claimed_settlement_provider_key_ids: sortedUniqueShaIds(
      root.claimed_settlement_provider_key_ids,
      "profile.claimed_settlement_provider_key_ids",
      MAX_PARTIES,
    ),
    claimed_dispute_resolver_key_ids: sortedUniqueShaIds(
      root.claimed_dispute_resolver_key_ids,
      "profile.claimed_dispute_resolver_key_ids",
      MAX_PARTIES,
    ),
    evidence: evidenceList(root.evidence, "profile.evidence"),
  };
}

export function serviceProfileHash(value: unknown): Sha256Id {
  return sha256Id(parseServiceProfile(value));
}

export function parseServiceAttestation(value: unknown): ServiceAttestation {
  const root = exactObject(
    boundedSnapshot(value, "attestation", MAX_ATTESTATION_BYTES),
    "attestation",
    [
    "schema",
    "issuer_key_id",
    "subject_key_id",
    "profile_record_id",
    "assertion_scope",
    "claim_type",
    "stance",
    "basis",
    "interaction_ref",
    "observed_at",
    "evidence",
    ],
  );
  literal(root.schema, SERVICE_ATTESTATION_SCHEMA, "attestation.schema");
  const basis = enumValue(root.basis, ATTESTATION_BASES, "attestation.basis");
  const interactionRef = root.interaction_ref === null
    ? null
    : shaId(root.interaction_ref, "attestation.interaction_ref");
  const parsedEvidence = evidenceList(root.evidence, "attestation.evidence");
  if (basis === "claimed_interaction_reference" && interactionRef === null) {
    invalid(
      "attestation.interaction_ref",
      "is required for claimed_interaction_reference provenance.",
    );
  }
  if (
    basis === "unlinked_assertion"
    && (interactionRef !== null || parsedEvidence.length > 0)
  ) {
    invalid(
      "attestation",
      "unlinked_assertion provenance forbids interaction and evidence references.",
    );
  }
  if (basis === "claimed_evidence_references" && parsedEvidence.length === 0) {
    invalid(
      "attestation.evidence",
      "must not be empty for claimed_evidence_references provenance.",
    );
  }

  return {
    schema: SERVICE_ATTESTATION_SCHEMA,
    issuer_key_id: shaId(root.issuer_key_id, "attestation.issuer_key_id"),
    subject_key_id: shaId(root.subject_key_id, "attestation.subject_key_id"),
    profile_record_id: shaId(
      root.profile_record_id,
      "attestation.profile_record_id",
    ),
    assertion_scope: literal(
      root.assertion_scope,
      "issuer-assertion-only",
      "attestation.assertion_scope",
    ),
    claim_type: token(root.claim_type, "attestation.claim_type"),
    stance: enumValue(root.stance, ATTESTATION_STANCES, "attestation.stance"),
    basis,
    interaction_ref: interactionRef,
    observed_at: timestamp(root.observed_at, "attestation.observed_at"),
    evidence: parsedEvidence,
  };
}

export function serviceAttestationHash(value: unknown): Sha256Id {
  return sha256Id(parseServiceAttestation(value));
}

function requiredClaim(value: unknown, path: string): RequiredServiceClaim {
  const root = exactObject(value, path, [
    "claim_type",
    "accepted_disclosures",
  ]);
  const accepted = sortedUniqueEnum(
    root.accepted_disclosures,
    DISCLOSURE_MODES,
    `${path}.accepted_disclosures`,
    DISCLOSURE_MODES.length,
  );
  if (accepted.length === 0) {
    invalid(`${path}.accepted_disclosures`, "must not be empty.");
  }
  return {
    claim_type: token(root.claim_type, `${path}.claim_type`),
    accepted_disclosures: accepted,
  };
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number") {
    return invalid(path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    return invalid(path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function attestationRule(value: unknown, path: string): ServiceAttestationRule {
  const root = exactObject(value, path, [
    "rule_id",
    "claim_type",
    "stance",
    "accepted_issuer_key_ids",
    "accepted_bases",
    "accepted_evidence_kinds",
    "minimum_unique_issuers",
    "minimum_unique_interactions",
    "maximum_unique_issuers",
    "max_age_seconds",
  ]);
  const issuers = sortedUniqueShaIds(
    root.accepted_issuer_key_ids,
    `${path}.accepted_issuer_key_ids`,
    MAX_PARTIES,
  );
  if (issuers.length === 0) {
    invalid(
      `${path}.accepted_issuer_key_ids`,
      "must contain explicit consumer-selected issuer keys.",
    );
  }
  const bases = sortedUniqueEnum(
    root.accepted_bases,
    ATTESTATION_BASES,
    `${path}.accepted_bases`,
    ATTESTATION_BASES.length,
  );
  if (bases.length === 0) invalid(`${path}.accepted_bases`, "must not be empty.");
  const evidenceKinds = sortedUniqueTokens(
    root.accepted_evidence_kinds,
    `${path}.accepted_evidence_kinds`,
    MAX_EVIDENCE,
  );
  const minimum = boundedInteger(
    root.minimum_unique_issuers,
    `${path}.minimum_unique_issuers`,
    0,
    issuers.length,
  );
  const minimumInteractions = boundedInteger(
    root.minimum_unique_interactions,
    `${path}.minimum_unique_interactions`,
    0,
    MAX_PARTIES,
  );
  const maximum = root.maximum_unique_issuers === null
    ? null
    : boundedInteger(
      root.maximum_unique_issuers,
      `${path}.maximum_unique_issuers`,
      0,
      issuers.length,
    );
  if (maximum !== null && maximum < minimum) {
    invalid(path, "maximum_unique_issuers must be null or at least the minimum.");
  }
  const maxAge = root.max_age_seconds === null
    ? null
    : boundedInteger(
      root.max_age_seconds,
      `${path}.max_age_seconds`,
      0,
      MAX_AGE_SECONDS,
    );
  return {
    rule_id: token(root.rule_id, `${path}.rule_id`),
    claim_type: token(root.claim_type, `${path}.claim_type`),
    stance: enumValue(root.stance, ATTESTATION_STANCES, `${path}.stance`),
    accepted_issuer_key_ids: issuers,
    accepted_bases: bases,
    accepted_evidence_kinds: evidenceKinds,
    minimum_unique_issuers: minimum,
    minimum_unique_interactions: minimumInteractions,
    maximum_unique_issuers: maximum,
    max_age_seconds: maxAge,
  };
}

export function parseServiceTrustPolicy(value: unknown): ServiceTrustPolicy {
  const root = exactObject(
    boundedSnapshot(value, "policy", MAX_POLICY_BYTES),
    "policy",
    [
    "schema",
    "policy_id",
    "attestation_profile_scope",
    "required_capabilities",
    "required_claims",
    "accepted_settlement_provider_key_ids",
    "accepted_dispute_resolver_key_ids",
    "attestation_rules",
    ],
  );
  literal(root.schema, SERVICE_TRUST_POLICY_SCHEMA, "policy.schema");
  const claims = array(root.required_claims, "policy.required_claims", MAX_CLAIMS)
    .map((entry, index) => requiredClaim(entry, `policy.required_claims[${index}]`));
  const claimTypes = claims.map((claim) => claim.claim_type);
  if (
    new Set(claimTypes).size !== claimTypes.length
    || claimTypes.some((entry, index) => entry !== [...claimTypes].sort()[index])
  ) {
    invalid("policy.required_claims", "must have unique sorted claim types.");
  }
  const rules = array(root.attestation_rules, "policy.attestation_rules", MAX_RULES)
    .map((entry, index) => attestationRule(entry, `policy.attestation_rules[${index}]`));
  const ruleIds = rules.map((rule) => rule.rule_id);
  if (
    new Set(ruleIds).size !== ruleIds.length
    || ruleIds.some((entry, index) => entry !== [...ruleIds].sort()[index])
  ) {
    invalid("policy.attestation_rules", "must have unique sorted rule ids.");
  }
  return {
    schema: SERVICE_TRUST_POLICY_SCHEMA,
    policy_id: token(root.policy_id, "policy.policy_id"),
    attestation_profile_scope: enumValue(
      root.attestation_profile_scope,
      ATTESTATION_PROFILE_SCOPES,
      "policy.attestation_profile_scope",
    ),
    required_capabilities: sortedUniqueTokens(
      root.required_capabilities,
      "policy.required_capabilities",
      MAX_CAPABILITIES,
    ),
    required_claims: claims,
    accepted_settlement_provider_key_ids: sortedUniqueShaIds(
      root.accepted_settlement_provider_key_ids,
      "policy.accepted_settlement_provider_key_ids",
      MAX_PARTIES,
    ),
    accepted_dispute_resolver_key_ids: sortedUniqueShaIds(
      root.accepted_dispute_resolver_key_ids,
      "policy.accepted_dispute_resolver_key_ids",
      MAX_PARTIES,
    ),
    attestation_rules: rules,
  };
}

export function serviceTrustPolicyHash(value: unknown): Sha256Id {
  return sha256Id(parseServiceTrustPolicy(value));
}
