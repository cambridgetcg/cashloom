import {
  assertCaip19,
  assertCaip2,
  assertSha256Id,
  assertTimestamp,
  chainFromAsset,
  sha256Id,
  type Sha256Id,
} from "@agenttool/wallet";

export const ASSET_TRUST_MANIFEST_SCHEMA = "cashloom.asset-trust/v2" as const;
export const ASSET_TRUST_POLICY_SCHEMA =
  "cashloom.asset-trust-policy/v2" as const;

export type DisclosedBoolean = boolean | "unknown";
export type SettlementModel =
  | "layer-1-proof-of-work"
  | "layer-1-proof-of-stake"
  | "optimistic-rollup"
  | "zk-rollup"
  | "federated-consensus"
  | "regulated-ledger"
  | "other"
  | "unknown";
export type KnownSettlementModel = Exclude<SettlementModel, "unknown">;
export type FinalityModel =
  | "probabilistic"
  | "economic"
  | "deterministic"
  | "provider-attested"
  | "unknown";
export type KnownFinalityModel = Exclude<FinalityModel, "unknown">;
export type RegulatedProviderRole =
  | "none"
  | "issuer"
  | "settlement"
  | "custody"
  | "multiple"
  | "unknown";
export type IssuerControl = "mint" | "freeze" | "denylist" | "pause" | "upgrade";
export type BridgeDependency =
  | "none"
  | "canonical"
  | "third-party"
  | "multiple"
  | "unknown";
export type KnownBridgeDependency = Exclude<BridgeDependency, "unknown">;
export type IdentityRequirement =
  | "none"
  | "issuance-redemption"
  | "provider-account"
  | "transaction"
  | "unknown";
export type CustodyModel =
  | "self-custody-capable"
  | "provider-custody-required"
  | "mixed"
  | "unknown";
export type KnownCustodyModel = Exclude<CustodyModel, "unknown">;
export type DataEgressCategory =
  | "none"
  | "public-ledger"
  | "peer-network"
  | "sequencer-operator"
  | "third-party-infrastructure"
  | "regulated-provider"
  | "unknown";
export type KnownDataEgressCategory = Exclude<DataEgressCategory, "unknown">;

export interface AssetTrustEvidence {
  readonly kind: string;
  readonly sha256: string;
  readonly url?: string;
}

/**
 * A local assertion, not a registry entry or a provider attestation.
 *
 * CashLoom deliberately does not fetch, rank, or bless these manifests. A
 * caller chooses the manifest and policy, and evidence URLs are inert labels
 * bound to caller-supplied digests.
 */
export interface AssetTrustManifest {
  readonly schema: typeof ASSET_TRUST_MANIFEST_SCHEMA;
  /** Exact CashLoom rail context in which the following trust claims apply. */
  readonly rail: string;
  readonly asset_id: string;
  readonly chain_id: string;
  readonly provenance: {
    readonly kind: "unsigned-local-assertion";
    readonly assessed_at: string;
  };
  readonly settlement: {
    readonly model: SettlementModel;
    readonly finality: FinalityModel;
    readonly single_sequencer: DisclosedBoolean;
  };
  readonly regulated_provider: {
    readonly required: DisclosedBoolean;
    readonly role: RegulatedProviderRole;
  };
  readonly issuer_controls: Readonly<Record<IssuerControl, DisclosedBoolean>>;
  readonly bridge_dependency: BridgeDependency;
  readonly identity_requirement: IdentityRequirement;
  readonly custody: CustodyModel;
  readonly infrastructure: {
    readonly self_hostable_read: DisclosedBoolean;
    readonly self_hostable_broadcast: DisclosedBoolean;
  };
  readonly data_egress: {
    readonly categories: readonly DataEgressCategory[];
  };
  readonly evidence: readonly AssetTrustEvidence[];
}

export interface AssetTrustPolicy {
  readonly schema: typeof ASSET_TRUST_POLICY_SCHEMA;
  readonly policy_id: string;
  readonly allowed_settlement_models: readonly KnownSettlementModel[];
  readonly allowed_finality_models: readonly KnownFinalityModel[];
  readonly reject_single_sequencer: boolean;
  readonly reject_regulated_provider: boolean;
  readonly denied_issuer_controls: readonly IssuerControl[];
  readonly reject_identity_requirement: boolean;
  readonly require_self_hostable_read: boolean;
  readonly require_self_hostable_broadcast: boolean;
  readonly reject_unknowns: boolean;
  readonly allowed_bridge_dependencies: readonly KnownBridgeDependency[];
  readonly allowed_custody_models: readonly KnownCustodyModel[];
  readonly allowed_data_egress_categories: readonly KnownDataEgressCategory[];
}

export type AssetTrustFindingCode =
  | "settlement-model"
  | "finality-model"
  | "single-sequencer"
  | "regulated-provider"
  | "issuer-control"
  | "identity-required"
  | "non-self-hostable-read"
  | "non-self-hostable-broadcast"
  | "bridge-dependency"
  | "custody-model"
  | "data-egress"
  | "unknown";

export interface AssetTrustFinding {
  readonly code: AssetTrustFindingCode;
  readonly path: string;
  readonly detail: string;
}

export interface AssetTrustDecision {
  readonly accepted: boolean;
  readonly asset_id: string;
  readonly policy_id: string;
  /** Content identity of the exact parsed policy, independent of its label. */
  readonly policy_hash: Sha256Id;
  readonly findings: readonly AssetTrustFinding[];
}

const SETTLEMENT_MODELS = [
  "layer-1-proof-of-work",
  "layer-1-proof-of-stake",
  "optimistic-rollup",
  "zk-rollup",
  "federated-consensus",
  "regulated-ledger",
  "other",
  "unknown",
] as const satisfies readonly SettlementModel[];
const FINALITY_MODELS = [
  "probabilistic",
  "economic",
  "deterministic",
  "provider-attested",
  "unknown",
] as const satisfies readonly FinalityModel[];
const REGULATED_PROVIDER_ROLES = [
  "none",
  "issuer",
  "settlement",
  "custody",
  "multiple",
  "unknown",
] as const satisfies readonly RegulatedProviderRole[];
const ISSUER_CONTROLS = [
  "mint",
  "freeze",
  "denylist",
  "pause",
  "upgrade",
] as const satisfies readonly IssuerControl[];
const BRIDGE_DEPENDENCIES = [
  "none",
  "canonical",
  "third-party",
  "multiple",
  "unknown",
] as const satisfies readonly BridgeDependency[];
const IDENTITY_REQUIREMENTS = [
  "none",
  "issuance-redemption",
  "provider-account",
  "transaction",
  "unknown",
] as const satisfies readonly IdentityRequirement[];
const CUSTODY_MODELS = [
  "self-custody-capable",
  "provider-custody-required",
  "mixed",
  "unknown",
] as const satisfies readonly CustodyModel[];
const DATA_EGRESS_CATEGORIES = [
  "none",
  "public-ledger",
  "peer-network",
  "sequencer-operator",
  "third-party-infrastructure",
  "regulated-provider",
  "unknown",
] as const satisfies readonly DataEgressCategory[];

const KNOWN_BRIDGE_DEPENDENCIES = BRIDGE_DEPENDENCIES.filter(
  (value): value is KnownBridgeDependency => value !== "unknown",
);
const KNOWN_SETTLEMENT_MODELS = SETTLEMENT_MODELS.filter(
  (value): value is KnownSettlementModel => value !== "unknown",
);
const KNOWN_FINALITY_MODELS = FINALITY_MODELS.filter(
  (value): value is KnownFinalityModel => value !== "unknown",
);
const KNOWN_CUSTODY_MODELS = CUSTODY_MODELS.filter(
  (value): value is KnownCustodyModel => value !== "unknown",
);
const KNOWN_DATA_EGRESS_CATEGORIES = DATA_EGRESS_CATEGORIES.filter(
  (value): value is KnownDataEgressCategory => value !== "unknown",
);

const MAX_EVIDENCE = 16;
const MAX_EVIDENCE_KIND_LENGTH = 64;
const MAX_POLICY_ID_LENGTH = 128;
const MAX_RAIL_LENGTH = 64;
const MAX_URL_LENGTH = 2_048;
const RAIL = /^[a-z][a-z0-9._:-]{0,63}$/u;

export const FAIL_CLOSED_ASSET_TRUST_POLICY: AssetTrustPolicy = Object.freeze({
  schema: ASSET_TRUST_POLICY_SCHEMA,
  policy_id: "cashloom-local-fail-closed/v2",
  allowed_settlement_models: Object.freeze([
    "layer-1-proof-of-work",
    "layer-1-proof-of-stake",
  ] as const),
  allowed_finality_models: Object.freeze([
    "probabilistic",
    "economic",
    "deterministic",
  ] as const),
  reject_single_sequencer: true,
  reject_regulated_provider: true,
  denied_issuer_controls: Object.freeze([...ISSUER_CONTROLS]),
  reject_identity_requirement: true,
  require_self_hostable_read: true,
  require_self_hostable_broadcast: true,
  reject_unknowns: true,
  allowed_bridge_dependencies: Object.freeze(["none"] as const),
  allowed_custody_models: Object.freeze(["self-custody-capable"] as const),
  allowed_data_egress_categories: Object.freeze([
    "none",
    "public-ledger",
    "peer-network",
  ] as const),
});

const own = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalid = (path: string, detail: string): never => {
  throw new TypeError(`${path} ${detail}`);
};

function exactObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "must be a plain object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, "is not an allowed field.");
    }
  }
  for (const key of required) {
    if (!own(record, key)) {
      invalid(`${path}.${key}`, "is required.");
    }
  }
  return record;
}

function exactLiteral<T extends string>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) {
    return invalid(path, `must equal ${JSON.stringify(expected)}.`);
  }
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

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return invalid(path, "must be boolean.");
  }
  return value;
}

function disclosedBoolean(value: unknown, path: string): DisclosedBoolean {
  if (value !== true && value !== false && value !== "unknown") {
    return invalid(path, 'must be true, false, or "unknown".');
  }
  return value;
}

function boundedToken(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
  ) {
    return invalid(path, `must be a bounded token of at most ${maximum} bytes.`);
  }
  return value;
}

function railIdentifier(value: unknown, path: string): string {
  const rail = boundedToken(value, path, MAX_RAIL_LENGTH);
  if (!RAIL.test(rail)) {
    return invalid(path, "must be a canonical lowercase rail identifier.");
  }
  return rail;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    return invalid(path, "must be an array.");
  }
  return value;
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  maximum: number,
): T[] {
  const input = arrayValue(value, path);
  if (input.length > maximum) {
    return invalid(path, `must contain at most ${maximum} entries.`);
  }
  const result = input.map((entry, index) =>
    enumValue(entry, allowed, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    return invalid(path, "must not contain duplicates.");
  }
  return result;
}

function evidenceUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    return invalid(path, `must be an HTTPS URL of at most ${MAX_URL_LENGTH} bytes.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(path, "must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return invalid(
      path,
      "must use HTTPS without credentials or a fragment.",
    );
  }
  return value;
}

function parseEvidence(value: unknown, index: number): AssetTrustEvidence {
  const path = `manifest.evidence[${index}]`;
  const item = exactObject(value, path, ["kind", "sha256"], ["url"]);
  const kind = boundedToken(item.kind, `${path}.kind`, MAX_EVIDENCE_KIND_LENGTH);
  const sha256 = item.sha256;
  assertSha256Id(sha256, `${path}.sha256`);
  if (item.url === undefined) {
    return { kind, sha256 };
  }
  return { kind, sha256, url: evidenceUrl(item.url, `${path}.url`) };
}

export function parseAssetTrustManifest(value: unknown): AssetTrustManifest {
  const root = exactObject(value, "manifest", [
    "schema",
    "rail",
    "asset_id",
    "chain_id",
    "provenance",
    "settlement",
    "regulated_provider",
    "issuer_controls",
    "bridge_dependency",
    "identity_requirement",
    "custody",
    "infrastructure",
    "data_egress",
    "evidence",
  ]);
  exactLiteral(root.schema, ASSET_TRUST_MANIFEST_SCHEMA, "manifest.schema");

  const rail = railIdentifier(root.rail, "manifest.rail");
  const assetId = root.asset_id;
  const chainId = root.chain_id;
  assertCaip19(assetId, "manifest.asset_id");
  assertCaip2(chainId, "manifest.chain_id");
  if (chainFromAsset(assetId) !== chainId) {
    invalid(
      "manifest.chain_id",
      "must equal the CAIP-2 chain encoded by manifest.asset_id.",
    );
  }

  const provenance = exactObject(root.provenance, "manifest.provenance", [
    "kind",
    "assessed_at",
  ]);
  exactLiteral(
    provenance.kind,
    "unsigned-local-assertion",
    "manifest.provenance.kind",
  );
  const assessedAt = provenance.assessed_at;
  assertTimestamp(assessedAt, "manifest.provenance.assessed_at");

  const settlement = exactObject(root.settlement, "manifest.settlement", [
    "model",
    "finality",
    "single_sequencer",
  ]);
  const settlementModel = enumValue(
    settlement.model,
    SETTLEMENT_MODELS,
    "manifest.settlement.model",
  );
  const finality = enumValue(
    settlement.finality,
    FINALITY_MODELS,
    "manifest.settlement.finality",
  );
  const singleSequencer = disclosedBoolean(
    settlement.single_sequencer,
    "manifest.settlement.single_sequencer",
  );

  const regulatedProvider = exactObject(
    root.regulated_provider,
    "manifest.regulated_provider",
    ["required", "role"],
  );
  const providerRequired = disclosedBoolean(
    regulatedProvider.required,
    "manifest.regulated_provider.required",
  );
  const providerRole = enumValue(
    regulatedProvider.role,
    REGULATED_PROVIDER_ROLES,
    "manifest.regulated_provider.role",
  );
  if (providerRequired === false && providerRole !== "none") {
    invalid(
      "manifest.regulated_provider.role",
      'must be "none" when required is false.',
    );
  }
  if (providerRequired === true && (providerRole === "none" || providerRole === "unknown")) {
    invalid(
      "manifest.regulated_provider.role",
      "must disclose a known provider role when required is true.",
    );
  }
  if (providerRequired === "unknown" && providerRole !== "unknown") {
    invalid(
      "manifest.regulated_provider.role",
      'must be "unknown" when required is unknown.',
    );
  }
  if (settlementModel === "regulated-ledger" && providerRequired !== true) {
    invalid(
      "manifest.regulated_provider.required",
      "must be true when settlement.model is regulated-ledger.",
    );
  }

  const issuerControls = exactObject(
    root.issuer_controls,
    "manifest.issuer_controls",
    ISSUER_CONTROLS,
  );
  const parsedIssuerControls = Object.fromEntries(
    ISSUER_CONTROLS.map((control) => [
      control,
      disclosedBoolean(
        issuerControls[control],
        `manifest.issuer_controls.${control}`,
      ),
    ]),
  ) as Record<IssuerControl, DisclosedBoolean>;

  const bridgeDependency = enumValue(
    root.bridge_dependency,
    BRIDGE_DEPENDENCIES,
    "manifest.bridge_dependency",
  );
  const identityRequirement = enumValue(
    root.identity_requirement,
    IDENTITY_REQUIREMENTS,
    "manifest.identity_requirement",
  );
  const custody = enumValue(
    root.custody,
    CUSTODY_MODELS,
    "manifest.custody",
  );

  const infrastructure = exactObject(
    root.infrastructure,
    "manifest.infrastructure",
    ["self_hostable_read", "self_hostable_broadcast"],
  );
  const selfHostableRead = disclosedBoolean(
    infrastructure.self_hostable_read,
    "manifest.infrastructure.self_hostable_read",
  );
  const selfHostableBroadcast = disclosedBoolean(
    infrastructure.self_hostable_broadcast,
    "manifest.infrastructure.self_hostable_broadcast",
  );

  const dataEgress = exactObject(root.data_egress, "manifest.data_egress", [
    "categories",
  ]);
  const categories = uniqueEnumArray(
    dataEgress.categories,
    DATA_EGRESS_CATEGORIES,
    "manifest.data_egress.categories",
    DATA_EGRESS_CATEGORIES.length,
  );
  if (categories.length === 0) {
    invalid("manifest.data_egress.categories", "must not be empty.");
  }
  if (categories.includes("none") && categories.length !== 1) {
    invalid(
      "manifest.data_egress.categories",
      '"none" cannot be combined with another category.',
    );
  }

  const evidenceInput = arrayValue(root.evidence, "manifest.evidence");
  if (evidenceInput.length > MAX_EVIDENCE) {
    invalid(
      "manifest.evidence",
      `must contain at most ${MAX_EVIDENCE} entries.`,
    );
  }
  const evidence = evidenceInput.map(parseEvidence);
  if (new Set(evidence.map((entry) => entry.sha256)).size !== evidence.length) {
    invalid("manifest.evidence", "must not repeat an evidence digest.");
  }

  return {
    schema: ASSET_TRUST_MANIFEST_SCHEMA,
    rail,
    asset_id: assetId,
    chain_id: chainId,
    provenance: {
      kind: "unsigned-local-assertion",
      assessed_at: assessedAt,
    },
    settlement: {
      model: settlementModel,
      finality,
      single_sequencer: singleSequencer,
    },
    regulated_provider: {
      required: providerRequired,
      role: providerRole,
    },
    issuer_controls: parsedIssuerControls,
    bridge_dependency: bridgeDependency,
    identity_requirement: identityRequirement,
    custody,
    infrastructure: {
      self_hostable_read: selfHostableRead,
      self_hostable_broadcast: selfHostableBroadcast,
    },
    data_egress: { categories },
    evidence,
  };
}

export function assertAssetTrustManifest(
  value: unknown,
): asserts value is AssetTrustManifest {
  parseAssetTrustManifest(value);
}

export function parseAssetTrustPolicy(value: unknown): AssetTrustPolicy {
  const root = exactObject(value, "policy", [
    "schema",
    "policy_id",
    "allowed_settlement_models",
    "allowed_finality_models",
    "reject_single_sequencer",
    "reject_regulated_provider",
    "denied_issuer_controls",
    "reject_identity_requirement",
    "require_self_hostable_read",
    "require_self_hostable_broadcast",
    "reject_unknowns",
    "allowed_bridge_dependencies",
    "allowed_custody_models",
    "allowed_data_egress_categories",
  ]);
  exactLiteral(root.schema, ASSET_TRUST_POLICY_SCHEMA, "policy.schema");

  const parsed: AssetTrustPolicy = {
    schema: ASSET_TRUST_POLICY_SCHEMA,
    policy_id: boundedToken(
      root.policy_id,
      "policy.policy_id",
      MAX_POLICY_ID_LENGTH,
    ),
    allowed_settlement_models: uniqueEnumArray(
      root.allowed_settlement_models,
      KNOWN_SETTLEMENT_MODELS,
      "policy.allowed_settlement_models",
      KNOWN_SETTLEMENT_MODELS.length,
    ),
    allowed_finality_models: uniqueEnumArray(
      root.allowed_finality_models,
      KNOWN_FINALITY_MODELS,
      "policy.allowed_finality_models",
      KNOWN_FINALITY_MODELS.length,
    ),
    reject_single_sequencer: booleanValue(
      root.reject_single_sequencer,
      "policy.reject_single_sequencer",
    ),
    reject_regulated_provider: booleanValue(
      root.reject_regulated_provider,
      "policy.reject_regulated_provider",
    ),
    denied_issuer_controls: uniqueEnumArray(
      root.denied_issuer_controls,
      ISSUER_CONTROLS,
      "policy.denied_issuer_controls",
      ISSUER_CONTROLS.length,
    ),
    reject_identity_requirement: booleanValue(
      root.reject_identity_requirement,
      "policy.reject_identity_requirement",
    ),
    require_self_hostable_read: booleanValue(
      root.require_self_hostable_read,
      "policy.require_self_hostable_read",
    ),
    require_self_hostable_broadcast: booleanValue(
      root.require_self_hostable_broadcast,
      "policy.require_self_hostable_broadcast",
    ),
    reject_unknowns: booleanValue(
      root.reject_unknowns,
      "policy.reject_unknowns",
    ),
    allowed_bridge_dependencies: uniqueEnumArray(
      root.allowed_bridge_dependencies,
      KNOWN_BRIDGE_DEPENDENCIES,
      "policy.allowed_bridge_dependencies",
      KNOWN_BRIDGE_DEPENDENCIES.length,
    ),
    allowed_custody_models: uniqueEnumArray(
      root.allowed_custody_models,
      KNOWN_CUSTODY_MODELS,
      "policy.allowed_custody_models",
      KNOWN_CUSTODY_MODELS.length,
    ),
    allowed_data_egress_categories: uniqueEnumArray(
      root.allowed_data_egress_categories,
      KNOWN_DATA_EGRESS_CATEGORIES,
      "policy.allowed_data_egress_categories",
      KNOWN_DATA_EGRESS_CATEGORIES.length,
    ),
  };
  if (
    parsed.policy_id === FAIL_CLOSED_ASSET_TRUST_POLICY.policy_id
    && sha256Id(parsed) !== sha256Id(FAIL_CLOSED_ASSET_TRUST_POLICY)
  ) {
    invalid(
      "policy.policy_id",
      `${JSON.stringify(FAIL_CLOSED_ASSET_TRUST_POLICY.policy_id)} is reserved for the built-in fail-closed policy bytes.`,
    );
  }
  return parsed;
}

export function assetTrustPolicyHash(policyValue: unknown): Sha256Id {
  return sha256Id(parseAssetTrustPolicy(policyValue));
}

export function evaluateAssetTrust(
  manifestValue: unknown,
  policyValue: unknown = FAIL_CLOSED_ASSET_TRUST_POLICY,
): AssetTrustDecision {
  const manifest = parseAssetTrustManifest(manifestValue);
  const policy = parseAssetTrustPolicy(policyValue);
  const findings: AssetTrustFinding[] = [];
  const add = (
    code: AssetTrustFindingCode,
    path: string,
    detail: string,
  ): void => {
    findings.push({ code, path, detail });
  };

  if (
    manifest.settlement.model !== "unknown"
    && !policy.allowed_settlement_models.includes(manifest.settlement.model)
  ) {
    add(
      "settlement-model",
      "settlement.model",
      `Settlement model ${manifest.settlement.model} is not allowed.`,
    );
  }
  if (
    manifest.settlement.finality !== "unknown"
    && !policy.allowed_finality_models.includes(manifest.settlement.finality)
  ) {
    add(
      "finality-model",
      "settlement.finality",
      `Finality model ${manifest.settlement.finality} is not allowed.`,
    );
  }
  if (
    manifest.settlement.single_sequencer === true &&
    policy.reject_single_sequencer
  ) {
    add(
      "single-sequencer",
      "settlement.single_sequencer",
      "The selected policy rejects a single sequencer.",
    );
  }
  if (
    manifest.regulated_provider.required === true &&
    policy.reject_regulated_provider
  ) {
    add(
      "regulated-provider",
      "regulated_provider.required",
      `The selected policy rejects a required regulated provider (${manifest.regulated_provider.role}).`,
    );
  }
  for (const control of ISSUER_CONTROLS) {
    if (
      manifest.issuer_controls[control] === true &&
      policy.denied_issuer_controls.includes(control)
    ) {
      add(
        "issuer-control",
        `issuer_controls.${control}`,
        `The selected policy rejects issuer ${control} control.`,
      );
    }
  }
  if (
    manifest.identity_requirement !== "none" &&
    manifest.identity_requirement !== "unknown" &&
    policy.reject_identity_requirement
  ) {
    add(
      "identity-required",
      "identity_requirement",
      `The selected policy rejects identity requirement ${manifest.identity_requirement}.`,
    );
  }
  if (
    manifest.infrastructure.self_hostable_read === false &&
    policy.require_self_hostable_read
  ) {
    add(
      "non-self-hostable-read",
      "infrastructure.self_hostable_read",
      "The selected policy requires self-hostable reads.",
    );
  }
  if (
    manifest.infrastructure.self_hostable_broadcast === false &&
    policy.require_self_hostable_broadcast
  ) {
    add(
      "non-self-hostable-broadcast",
      "infrastructure.self_hostable_broadcast",
      "The selected policy requires self-hostable broadcast.",
    );
  }
  if (
    manifest.bridge_dependency !== "unknown" &&
    !policy.allowed_bridge_dependencies.includes(manifest.bridge_dependency)
  ) {
    add(
      "bridge-dependency",
      "bridge_dependency",
      `Bridge dependency ${manifest.bridge_dependency} is not allowed.`,
    );
  }
  if (
    manifest.custody !== "unknown" &&
    !policy.allowed_custody_models.includes(manifest.custody)
  ) {
    add(
      "custody-model",
      "custody",
      `Custody model ${manifest.custody} is not allowed.`,
    );
  }
  for (const category of manifest.data_egress.categories) {
    if (
      category !== "unknown" &&
      !policy.allowed_data_egress_categories.includes(category)
    ) {
      add(
        "data-egress",
        "data_egress.categories",
        `Data-egress category ${category} is not allowed.`,
      );
    }
  }

  if (policy.reject_unknowns) {
    const unknowns: Array<readonly [string, unknown]> = [
      ["settlement.model", manifest.settlement.model],
      ["settlement.finality", manifest.settlement.finality],
      ["settlement.single_sequencer", manifest.settlement.single_sequencer],
      ["regulated_provider.required", manifest.regulated_provider.required],
      ["regulated_provider.role", manifest.regulated_provider.role],
      ...ISSUER_CONTROLS.map(
        (control) =>
          [
            `issuer_controls.${control}`,
            manifest.issuer_controls[control],
          ] as const,
      ),
      ["bridge_dependency", manifest.bridge_dependency],
      ["identity_requirement", manifest.identity_requirement],
      ["custody", manifest.custody],
      [
        "infrastructure.self_hostable_read",
        manifest.infrastructure.self_hostable_read,
      ],
      [
        "infrastructure.self_hostable_broadcast",
        manifest.infrastructure.self_hostable_broadcast,
      ],
    ];
    for (const [path, disclosed] of unknowns) {
      if (disclosed === "unknown") {
        add("unknown", path, "The selected policy rejects unknown values.");
      }
    }
    if (manifest.data_egress.categories.includes("unknown")) {
      add(
        "unknown",
        "data_egress.categories",
        "The selected policy rejects unknown data egress.",
      );
    }
  }

  return {
    accepted: findings.length === 0,
    asset_id: manifest.asset_id,
    policy_id: policy.policy_id,
    policy_hash: sha256Id(policy),
    findings,
  };
}
