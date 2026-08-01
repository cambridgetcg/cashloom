import { describe, expect, test } from "bun:test";
import { base64UrlEncode, type Sha256Id } from "@agenttool/wallet";

import * as serviceTrustModule from "./service-trust.ts";
import {
  SERVICE_ATTESTATION_SCHEMA,
  SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
  SERVICE_PROFILE_SCHEMA,
  SERVICE_TRUST_POLICY_SCHEMA,
  parseServiceAttestation,
  parseServiceProfile,
  parseServiceTrustPolicy,
  serviceDisclosureCommitmentHash,
  serviceProfileHash,
  serviceTrustPolicyHash,
  type ServiceAttestation,
  type ServiceProfile,
  type ServiceTrustPolicy,
} from "./service-trust.ts";

const id = (character: string): Sha256Id =>
  `sha256:${character.repeat(64)}` as Sha256Id;
const nonce = (character: number): string =>
  base64UrlEncode(new Uint8Array(16).fill(character));

const SERVICE_KEY = id("a");
const TRADER_A = id("b");
const TRADER_B = id("c");
const PROFILE_RECORD = id("e");

const PROFILE = {
  schema: SERVICE_PROFILE_SCHEMA,
  service_key_id: SERVICE_KEY,
  provenance: {
    kind: "self-assertion",
    asserted_at: "2026-07-01T00:00:00.000Z",
  },
  capabilities: ["authentication", "physical_intake"],
  claims: [
    {
      claim_type: "insurance",
      disclosure: {
        mode: "commitment",
        scheme: SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
        digest: id("1"),
      },
    },
    {
      claim_type: "location",
      disclosure: { mode: "public", value: "Cambridge, GB" },
    },
  ],
  claimed_settlement_provider_key_ids: [id("8")],
  claimed_dispute_resolver_key_ids: [id("9")],
  evidence: [],
} as const satisfies ServiceProfile;

const POLICY = {
  schema: SERVICE_TRUST_POLICY_SCHEMA,
  policy_id: "trader:alice/custody-under-500/v1",
  attestation_profile_scope: "service-key-history",
  required_capabilities: ["physical_intake"],
  required_claims: [
    {
      claim_type: "insurance",
      accepted_disclosures: ["commitment", "public"],
    },
  ],
  accepted_settlement_provider_key_ids: [id("8")],
  accepted_dispute_resolver_key_ids: [id("9")],
  attestation_rules: [
    {
      rule_id: "adverse-loss",
      claim_type: "custody.loss_reported",
      stance: "disputes",
      accepted_issuer_key_ids: [TRADER_A, TRADER_B],
      accepted_bases: [
        "claimed_evidence_references",
        "claimed_interaction_reference",
      ],
      accepted_evidence_kinds: [],
      minimum_unique_issuers: 0,
      minimum_unique_interactions: 0,
      maximum_unique_issuers: 0,
      max_age_seconds: 31_536_000,
    },
    {
      rule_id: "completed-trades",
      claim_type: "custody.trade_completed",
      stance: "supports",
      accepted_issuer_key_ids: [TRADER_A, TRADER_B],
      accepted_bases: ["claimed_interaction_reference"],
      accepted_evidence_kinds: [],
      minimum_unique_issuers: 2,
      minimum_unique_interactions: 2,
      maximum_unique_issuers: null,
      max_age_seconds: 31_536_000,
    },
  ],
} as const satisfies ServiceTrustPolicy;

function completed(
  issuer: Sha256Id,
  interaction: Sha256Id,
): ServiceAttestation {
  return {
    schema: SERVICE_ATTESTATION_SCHEMA,
    issuer_key_id: issuer,
    subject_key_id: SERVICE_KEY,
    profile_record_id: PROFILE_RECORD,
    assertion_scope: "issuer-assertion-only",
    claim_type: "custody.trade_completed",
    stance: "supports",
    basis: "claimed_interaction_reference",
    interaction_ref: interaction,
    observed_at: "2026-07-20T12:00:00.000Z",
    evidence: [],
  };
}

describe("permissionless service profiles", () => {
  test("accepts optional self-disclosure without deriving platform authority", () => {
    const parsed = parseServiceProfile(PROFILE);
    expect(parsed.provenance.kind).toBe("self-assertion");
    expect(parsed.claims[0]?.disclosure.mode).toBe("commitment");

    const minimal = parseServiceProfile({
      ...PROFILE,
      capabilities: [],
      claims: [],
      claimed_settlement_provider_key_ids: [],
      claimed_dispute_resolver_key_ids: [],
      evidence: [],
    });
    expect(minimal.capabilities).toEqual([]);
    expect(minimal.claims).toEqual([]);
  });

  test("rejects authority-looking extensions and unsafe evidence locators", () => {
    expect(() => parseServiceProfile({ ...PROFILE, verified: true })).toThrow(
      /profile\.verified is not an allowed field/,
    );
    expect(() => parseServiceProfile({
      ...PROFILE,
      evidence: [{
        kind: "insurance-document",
        sha256: id("2"),
        url: "http://example.invalid/insurance.pdf",
      }],
    })).toThrow(/must use HTTPS/);
    expect(() => parseServiceProfile({
      ...PROFILE,
      evidence: [{
        kind: "insurance-document",
        sha256: id("2"),
        url: "https://EXAMPLE.com:443/insurance.pdf",
      }],
    })).toThrow(/canonical URL spelling/);
    expect(() => parseServiceProfile({
      ...PROFILE,
      claims: [
        PROFILE.claims[0],
        {
          claim_type: "location",
          disclosure: { mode: "public", value: "safe\u202eevil" },
        },
      ],
    })).toThrow(/bidirectional override/);
    expect(() => parseServiceProfile({
      ...PROFILE,
      capabilities: ["cashloom.verified"],
    })).toThrow(/reserved platform-authority phrase/);
  });

  test("uses salted, domain-separated disclosure commitments", () => {
    const first = {
      schema: SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
      claim_type: "insurance",
      value: "insured",
      nonce: nonce(1),
    } as const;
    const second = { ...first, nonce: nonce(2) };

    expect(serviceDisclosureCommitmentHash(first)).not.toBe(
      serviceDisclosureCommitmentHash(second),
    );
    expect(parseServiceProfile({
      ...PROFILE,
      claims: [
        {
          claim_type: "insurance",
          disclosure: {
            mode: "commitment",
            scheme: SERVICE_DISCLOSURE_COMMITMENT_SCHEMA,
            digest: serviceDisclosureCommitmentHash(first),
          },
        },
        PROFILE.claims[1],
      ],
    }).claims[0]?.disclosure.mode).toBe("commitment");
  });

  test("content-addresses canonical assertions and enforces aggregate bounds", () => {
    expect(serviceProfileHash(PROFILE)).not.toBe(serviceProfileHash({
      ...PROFILE,
      claims: [
        PROFILE.claims[0],
        {
          ...PROFILE.claims[1],
          disclosure: { mode: "public", value: "London, GB" },
        },
      ],
    }));

    const oversizedClaims = Array.from({ length: 16 }, (_, index) => ({
      claim_type: `large.${String(index).padStart(2, "0")}`,
      disclosure: { mode: "public", value: "x".repeat(2_048) },
    }));
    expect(() => parseServiceProfile({
      ...PROFILE,
      claims: oversizedClaims,
    })).toThrow(/canonical bytes/);
  });
});

describe("participant attestations", () => {
  test("labels reference provenance as issuer-claimed and enforces its shape", () => {
    expect(parseServiceAttestation(completed(TRADER_A, id("3"))).basis).toBe(
      "claimed_interaction_reference",
    );
    expect(() => parseServiceAttestation({
      ...completed(TRADER_A, id("3")),
      interaction_ref: null,
    })).toThrow(/required for claimed_interaction_reference/);
    expect(() => parseServiceAttestation({
      ...completed(TRADER_A, id("3")),
      basis: "claimed_evidence_references",
      interaction_ref: null,
      evidence: [],
    })).toThrow(/must not be empty/);
    expect(() => parseServiceAttestation({
      ...completed(TRADER_A, id("3")),
      basis: "unlinked_assertion",
      interaction_ref: null,
      evidence: [{ kind: "case", sha256: id("0") }],
    })).toThrow(/forbids interaction and evidence/);
  });

  test("rejects sparse evidence and platform-verification language", () => {
    const sparse = new Array(1);
    expect(() => parseServiceAttestation({
      ...completed(TRADER_A, id("3")),
      basis: "claimed_evidence_references",
      interaction_ref: null,
      evidence: sparse,
    })).toThrow(/safe canonical JSON|sparse/);
    expect(() => parseServiceAttestation({
      ...completed(TRADER_A, id("3")),
      assertion_scope: "cashloom-verified",
    })).toThrow(/issuer-assertion-only/);
  });
});

describe("trader-selected service policy", () => {
  test("requires explicit attester roots and has no open global-count mode", () => {
    expect(() => parseServiceTrustPolicy({
      ...POLICY,
      attestation_rules: [
        POLICY.attestation_rules[0],
        {
          ...POLICY.attestation_rules[1],
          accepted_issuer_key_ids: [],
          minimum_unique_issuers: 0,
        },
      ],
    })).toThrow(/explicit consumer-selected issuer keys/);
  });

  test("content-addresses history scope, interaction rules, and exact roots", () => {
    const parsed = parseServiceTrustPolicy(POLICY);
    expect(parsed.attestation_profile_scope).toBe("service-key-history");
    expect(parsed.attestation_rules[1]?.minimum_unique_interactions).toBe(2);
    expect(serviceTrustPolicyHash(POLICY)).not.toBe(serviceTrustPolicyHash({
      ...POLICY,
      attestation_profile_scope: "exact-profile",
    }));
  });

  test("exports no unsigned assertion evaluator", () => {
    expect("evaluateServiceTrust" in serviceTrustModule).toBe(false);
  });
});
