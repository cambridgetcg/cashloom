import { describe, expect, it } from "bun:test";
import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
  evaluateAssetTrust,
  parseAssetTrustManifest,
  parseAssetTrustPolicy,
  type AssetTrustManifest,
  type AssetTrustPolicy,
} from "./asset-trust.ts";

const BTC_CHAIN = "bip122:000000000019d6689c085ae165831e93";
const BASE_CHAIN = "eip155:8453";

// These are deliberately unsigned, test-only local assessments. They exercise
// realistic identifiers and trust dimensions; they are not canonical facts,
// registry entries, endorsements, or live claims about any network or issuer.
const BTC_LOCAL_ASSESSMENT = {
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "bitcoin-mainnet",
  asset_id: `${BTC_CHAIN}/slip44:0`,
  chain_id: BTC_CHAIN,
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: "2026-07-31T00:00:00.000Z",
  },
  settlement: {
    model: "layer-1-proof-of-work",
    finality: "probabilistic",
    single_sequencer: false,
  },
  regulated_provider: { required: false, role: "none" },
  issuer_controls: {
    mint: false,
    freeze: false,
    denylist: false,
    pause: false,
    upgrade: false,
  },
  bridge_dependency: "none",
  identity_requirement: "none",
  custody: "self-custody-capable",
  infrastructure: {
    self_hostable_read: true,
    self_hostable_broadcast: true,
  },
  data_egress: { categories: ["public-ledger", "peer-network"] },
  evidence: [],
} as const satisfies AssetTrustManifest;

const BASE_ETH_LOCAL_ASSESSMENT = {
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "evm-base",
  asset_id: `${BASE_CHAIN}/slip44:60`,
  chain_id: BASE_CHAIN,
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: "2026-07-31T00:00:00.000Z",
  },
  settlement: {
    model: "optimistic-rollup",
    finality: "economic",
    single_sequencer: true,
  },
  regulated_provider: { required: false, role: "none" },
  issuer_controls: {
    mint: false,
    freeze: false,
    denylist: false,
    pause: false,
    upgrade: false,
  },
  bridge_dependency: "canonical",
  identity_requirement: "none",
  custody: "self-custody-capable",
  infrastructure: {
    self_hostable_read: true,
    self_hostable_broadcast: false,
  },
  data_egress: { categories: ["public-ledger", "sequencer-operator"] },
  evidence: [],
} as const satisfies AssetTrustManifest;

const BASE_USDC_LOCAL_ASSESSMENT = {
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "evm-base",
  asset_id:
    `${BASE_CHAIN}/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
  chain_id: BASE_CHAIN,
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: "2026-07-31T00:00:00.000Z",
  },
  settlement: {
    model: "optimistic-rollup",
    finality: "economic",
    single_sequencer: true,
  },
  regulated_provider: { required: true, role: "issuer" },
  issuer_controls: {
    mint: true,
    freeze: true,
    denylist: true,
    pause: true,
    upgrade: true,
  },
  bridge_dependency: "none",
  identity_requirement: "issuance-redemption",
  custody: "self-custody-capable",
  infrastructure: {
    self_hostable_read: true,
    self_hostable_broadcast: false,
  },
  data_egress: {
    categories: [
      "public-ledger",
      "sequencer-operator",
      "regulated-provider",
    ],
  },
  evidence: [],
} as const satisfies AssetTrustManifest;

const clone = <T>(value: T): T => structuredClone(value);

describe("CAIP-19 asset trust manifests", () => {
  it("accepts a strict local BTC assessment and fails closed on extra authority-looking fields", () => {
    const parsed = parseAssetTrustManifest(BTC_LOCAL_ASSESSMENT);
    expect(parsed.asset_id).toBe(`${BTC_CHAIN}/slip44:0`);
    expect(parsed.provenance.kind).toBe("unsigned-local-assertion");

    expect(() =>
      parseAssetTrustManifest({
        ...BTC_LOCAL_ASSESSMENT,
        signature: "not-a-local-manifest-field",
      }),
    ).toThrow(/manifest\.signature is not an allowed field/);
  });

  it("reuses Agent Wallet CAIP validation and binds the asset to its chain", () => {
    expect(() =>
      parseAssetTrustManifest({
        ...BTC_LOCAL_ASSESSMENT,
        asset_id: "BTC",
      }),
    ).toThrow(/CAIP-2\/asset_namespace:asset_reference/);

    expect(() =>
      parseAssetTrustManifest({
        ...BTC_LOCAL_ASSESSMENT,
        chain_id: BASE_CHAIN,
      }),
    ).toThrow(/must equal the CAIP-2 chain/);
    expect(() =>
      parseAssetTrustManifest({
        ...BTC_LOCAL_ASSESSMENT,
        rail: "Stripe Connect",
      }),
    ).toThrow(/manifest\.rail/);
  });

  it("strictly validates nested disclosures and bounded digest-linked evidence", () => {
    expect(() =>
      parseAssetTrustManifest({
        ...BTC_LOCAL_ASSESSMENT,
        settlement: {
          ...BTC_LOCAL_ASSESSMENT.settlement,
          validator_count: 1,
        },
      }),
    ).toThrow(/validator_count is not an allowed field/);

    const withEvidence = {
      ...BTC_LOCAL_ASSESSMENT,
      evidence: [
        {
          kind: "local-doc-snapshot",
          sha256: `sha256:${"1".repeat(64)}`,
          url: "https://example.invalid/local-btc-assessment.json",
        },
      ],
    };
    expect(parseAssetTrustManifest(withEvidence).evidence).toEqual(
      withEvidence.evidence,
    );
    expect(() =>
      parseAssetTrustManifest({
        ...withEvidence,
        evidence: [
          {
            ...withEvidence.evidence[0],
            url: "http://example.invalid/not-bounded-by-https",
          },
        ],
      }),
    ).toThrow(/must use HTTPS/);
  });
});

describe("local asset trust policy", () => {
  it("accepts the BTC fixture under the built-in fail-closed policy", () => {
    expect(evaluateAssetTrust(BTC_LOCAL_ASSESSMENT)).toEqual({
      accepted: true,
      asset_id: BTC_LOCAL_ASSESSMENT.asset_id,
      policy_id: FAIL_CLOSED_ASSET_TRUST_POLICY.policy_id,
      policy_hash: assetTrustPolicyHash(FAIL_CLOSED_ASSET_TRUST_POLICY),
      findings: [],
    });
  });

  it("rejects the Base ETH fixture at each disclosed central dependency", () => {
    const decision = evaluateAssetTrust(BASE_ETH_LOCAL_ASSESSMENT);
    expect(decision.accepted).toBe(false);
    expect(decision.findings.map((finding) => finding.code)).toEqual([
      "settlement-model",
      "single-sequencer",
      "non-self-hostable-broadcast",
      "bridge-dependency",
      "data-egress",
    ]);
  });

  it("also rejects Base USDC issuer controls, provider, and identity boundaries", () => {
    const decision = evaluateAssetTrust(BASE_USDC_LOCAL_ASSESSMENT);
    const codes = decision.findings.map((finding) => finding.code);
    expect(codes).toContain("settlement-model");
    expect(codes).toContain("single-sequencer");
    expect(codes).toContain("regulated-provider");
    expect(codes.filter((code) => code === "issuer-control")).toHaveLength(5);
    expect(codes).toContain("identity-required");
    expect(codes).toContain("non-self-hostable-broadcast");
    expect(codes).toContain("data-egress");
  });

  it("fails closed on unknown facts without silently treating them as false", () => {
    const unknown = clone(BTC_LOCAL_ASSESSMENT) as AssetTrustManifest;
    (unknown.settlement as { single_sequencer: boolean | "unknown" })
      .single_sequencer = "unknown";
    (unknown.issuer_controls as { freeze: boolean | "unknown" }).freeze =
      "unknown";

    const decision = evaluateAssetTrust(unknown);
    expect(decision.accepted).toBe(false);
    expect(
      decision.findings
        .filter((finding) => finding.code === "unknown")
        .map((finding) => finding.path),
    ).toEqual(["settlement.single_sequencer", "issuer_controls.freeze"]);
  });

  it("cannot disguise a regulated provider-attested ledger as decentralized", () => {
    const centralized = {
      ...clone(BTC_LOCAL_ASSESSMENT),
      settlement: {
        model: "regulated-ledger",
        finality: "provider-attested",
        single_sequencer: false,
      },
      regulated_provider: {
        required: true,
        role: "settlement",
      },
      data_egress: { categories: ["none"] },
    } as const satisfies AssetTrustManifest;

    expect(
      evaluateAssetTrust(centralized).findings.map(({ code }) => code),
    ).toEqual([
      "settlement-model",
      "finality-model",
      "regulated-provider",
    ]);
    expect(() =>
      parseAssetTrustManifest({
        ...centralized,
        regulated_provider: { required: false, role: "none" },
      }),
    ).toThrow(/must be true when settlement\.model is regulated-ledger/);
  });

  it("allows a caller to make an explicit local policy choice without a registry", () => {
    const localBasePolicy = {
      ...FAIL_CLOSED_ASSET_TRUST_POLICY,
      policy_id: "test-local-base-policy/v2",
      allowed_settlement_models: [
        ...FAIL_CLOSED_ASSET_TRUST_POLICY.allowed_settlement_models,
        "optimistic-rollup",
      ],
      reject_single_sequencer: false,
      require_self_hostable_broadcast: false,
      allowed_bridge_dependencies: ["none", "canonical"],
      allowed_data_egress_categories: [
        "none",
        "public-ledger",
        "peer-network",
        "sequencer-operator",
      ],
    } as const satisfies AssetTrustPolicy;

    expect(evaluateAssetTrust(BASE_ETH_LOCAL_ASSESSMENT, localBasePolicy)).toEqual(
      {
        accepted: true,
        asset_id: BASE_ETH_LOCAL_ASSESSMENT.asset_id,
        policy_id: localBasePolicy.policy_id,
        policy_hash: assetTrustPolicyHash(localBasePolicy),
        findings: [],
      },
    );
  });

  it("strictly rejects malformed policy input", () => {
    expect(() =>
      parseAssetTrustPolicy({
        ...FAIL_CLOSED_ASSET_TRUST_POLICY,
        allowed_bridge_dependencies: ["none", "none"],
      }),
    ).toThrow(/must not contain duplicates/);
    expect(() =>
      parseAssetTrustPolicy({
        ...FAIL_CLOSED_ASSET_TRUST_POLICY,
        central_registry: "https://registry.invalid",
      }),
    ).toThrow(/central_registry is not an allowed field/);
    expect(() =>
      parseAssetTrustPolicy({
        ...FAIL_CLOSED_ASSET_TRUST_POLICY,
        reject_regulated_provider: false,
      }),
    ).toThrow(/reserved for the built-in fail-closed policy bytes/);
  });
});
