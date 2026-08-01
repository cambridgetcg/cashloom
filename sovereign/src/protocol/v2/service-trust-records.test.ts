import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
  type Sha256Id,
} from "@agenttool/wallet";

import { CashLoomV2RecordStore } from "./record-store.ts";
import {
  createSelfCertifyingAuthority,
  createServiceAttestationRecord,
  createServiceProfileRecord,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  verifyV2Record,
  verifyV2RecordLink,
  type SelfCertifyingAuthority,
  type ServiceAttestationRecordCore,
  type ServiceProfileRecordCore,
  type VerifiedV2Record,
} from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";
import { evaluateV2ServiceTrust } from "./service-trust-evaluation.ts";
import {
  SERVICE_ATTESTATION_SCHEMA,
  SERVICE_PROFILE_SCHEMA,
  SERVICE_TRUST_POLICY_SCHEMA,
  type ServiceAttestation,
  type ServiceProfile,
  type ServiceTrustPolicy,
} from "./service-trust.ts";

interface TestAuthority {
  readonly authority: SelfCertifyingAuthority;
  readonly signer: RecordSigner;
}

async function testAuthority(seedByte: number): Promise<TestAuthority> {
  const privateKey = new Uint8Array(32).fill(seedByte);
  const publicKey = base64UrlEncode(await ed25519.getPublicKeyAsync(privateKey));
  return {
    authority: createSelfCertifyingAuthority(publicKey),
    signer: {
      public_key: publicKey,
      async sign_digest(digest) {
        return signatureToBase64Url(await ed25519.signAsync(digest, privateKey));
      },
    },
  };
}

const shop = await testAuthority(41);
const traderA = await testAuthority(42);
const traderB = await testAuthority(43);
const otherShop = await testAuthority(44);

function nonce(serial: number): string {
  const entropy = new Uint8Array(16);
  new DataView(entropy.buffer).setUint32(12, serial);
  return v2Nonce(entropy);
}

const PROFILE: ServiceProfile = {
  schema: SERVICE_PROFILE_SCHEMA,
  service_key_id: shop.authority.key_id,
  provenance: {
    kind: "self-assertion",
    asserted_at: "2030-01-01T00:00:00.000Z",
  },
  capabilities: ["physical_intake"],
  claims: [
    {
      claim_type: "location",
      disclosure: { mode: "public", value: "Cambridge, GB" },
    },
  ],
  claimed_settlement_provider_key_ids: [],
  claimed_dispute_resolver_key_ids: [],
  evidence: [],
};

async function signedProfile(
  profile: ServiceProfile = PROFILE,
): Promise<VerifiedV2Record<ServiceProfileRecordCore>> {
  return signV2Record(
    createServiceProfileRecord({
      authority: shop.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(1),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-31T00:00:00.000Z",
      parent_record_id: null,
      profile,
    }),
    shop.signer,
  );
}

async function signedHistoricalProfile(): Promise<
  VerifiedV2Record<ServiceProfileRecordCore>
> {
  return signV2Record(
    createServiceProfileRecord({
      authority: shop.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(20),
      issued_at: "2029-12-01T00:00:00.000Z",
      expires_at: "2029-12-31T00:00:00.000Z",
      parent_record_id: null,
      profile: {
        ...PROFILE,
        provenance: {
          kind: "self-assertion",
          asserted_at: "2029-12-01T00:00:00.000Z",
        },
      },
    }),
    shop.signer,
  );
}

async function signedAttestation(
  profile: VerifiedV2Record<ServiceProfileRecordCore>,
  issuer: TestAuthority,
  serial: number,
  overrides: Partial<ServiceAttestation> = {},
  issuedAt = "2030-01-02T00:00:00.000Z",
): Promise<VerifiedV2Record<ServiceAttestationRecordCore>> {
  const attestation: ServiceAttestation = {
    schema: SERVICE_ATTESTATION_SCHEMA,
    issuer_key_id: issuer.authority.key_id,
    subject_key_id: shop.authority.key_id,
    profile_record_id: profile.record_id,
    assertion_scope: "issuer-assertion-only",
    claim_type: "custody.trade_completed",
    stance: "supports",
    basis: "claimed_interaction_reference",
    interaction_ref: sha256Id({ trade: serial }),
    observed_at: issuedAt,
    evidence: [],
    ...overrides,
  };
  return signV2Record(
    createServiceAttestationRecord({
      authority: issuer.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: "2030-06-01T00:00:00.000Z",
      parent_record_id: profile.record_id,
      attestation,
    }),
    issuer.signer,
  );
}

function policy(): ServiceTrustPolicy {
  return {
    schema: SERVICE_TRUST_POLICY_SCHEMA,
    policy_id: "trader/local-custody-policy/v1",
    attestation_profile_scope: "service-key-history",
    required_capabilities: ["physical_intake"],
    required_claims: [],
    accepted_settlement_provider_key_ids: [],
    accepted_dispute_resolver_key_ids: [],
    attestation_rules: [
      {
        rule_id: "completed-trades",
        claim_type: "custody.trade_completed",
        stance: "supports",
        accepted_issuer_key_ids: [
          traderA.authority.key_id,
          traderB.authority.key_id,
        ].sort() as Sha256Id[],
        accepted_bases: ["claimed_interaction_reference"],
        accepted_evidence_kinds: [],
        minimum_unique_issuers: 2,
        minimum_unique_interactions: 2,
        maximum_unique_issuers: null,
        max_age_seconds: 365 * 24 * 60 * 60,
      },
    ],
  };
}

describe("signed permissionless service trust records", () => {
  test("publishes a self-certifying profile without a platform identity", async () => {
    const profile = await signedProfile();
    const verified = verifyV2Record(v2RecordBytes(profile));
    if (verified.schema !== "cashloom/service-profile/v2") {
      throw new Error("Expected a service profile record.");
    }

    expect(verified.record_id).toBe(profile.record_id);
    expect(verified.authority.key_id).toBe(PROFILE.service_key_id);
    expect(verified.profile.provenance.kind).toBe("self-assertion");
    expect(verified).not.toHaveProperty("account_id");
    expect(verified).not.toHaveProperty("verified");

    const {
      schema: _profileSchema,
      signature: _profileSignature,
      record_id: _profileRecordId,
      ...profileInput
    } = profile;
    expect(() => createServiceProfileRecord({
      ...profileInput,
      profile: { ...PROFILE, service_key_id: otherShop.authority.key_id },
    })).toThrow(/service profile key/i);
  });

  test("supports direct private profiles without permitting public metadata leaks", async () => {
    const privateProfile = await signV2Record(
      createServiceProfileRecord({
        authority: shop.authority,
        audience: traderA.authority.key_id,
        disclosure: "private",
        nonce: nonce(30),
        issued_at: "2030-01-01T00:00:00.000Z",
        expires_at: "2030-01-31T00:00:00.000Z",
        parent_record_id: null,
        profile: PROFILE,
      }),
      shop.signer,
    );
    const publicChild = await signedAttestation(privateProfile, traderA, 31);
    expect(() => verifyV2RecordLink(publicChild, privateProfile)).toThrow(
      /public record cannot depend on a private parent/i,
    );

    const {
      schema: _publicSchema,
      signature: _publicSignature,
      record_id: _publicRecordId,
      ...publicChildCore
    } = publicChild;
    const privateChild = await signV2Record(
      createServiceAttestationRecord({
        ...publicChildCore,
        audience: traderA.authority.key_id,
        disclosure: "private",
      }),
      traderA.signer,
    );
    expect(verifyV2RecordLink(privateChild, privateProfile).child.record_id).toBe(
      privateChild.record_id,
    );
  });

  test("counts only valid trader signatures selected by the caller's policy", async () => {
    const profile = await signedProfile();
    const first = await signedAttestation(profile, traderA, 2);
    const second = await signedAttestation(profile, traderB, 3);
    const decision = evaluateV2ServiceTrust({
      profile_record: profile,
      attestation_records: [first, second],
      policy: policy(),
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });

    expect(decision.decision).toBe("bundle_matches_policy");
    expect(decision.evidence_used).toEqual([first.record_id, second.record_id].sort());
    expect(decision.supplied_evidence_record_ids).toEqual(
      [first.record_id, second.record_id].sort(),
    );
    expect(decision.evaluated_at).toBe("2030-01-15T00:00:00.000Z");
    expect(decision.evidence_bundle_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decision.notices.join(" ")).toMatch(/not a CashLoom endorsement/);
    expect(decision).not.toHaveProperty("score");
    expect(decision).not.toHaveProperty("verified");
  });

  test("makes profile-history scope explicit instead of silently resetting reputation", async () => {
    const current = await signedProfile();
    const historical = await signedHistoricalProfile();
    const first = await signedAttestation(historical, traderA, 21);
    const second = await signedAttestation(historical, traderB, 22);

    const exact = evaluateV2ServiceTrust({
      profile_record: current,
      profile_history_records: [historical],
      attestation_records: [first, second],
      policy: { ...policy(), attestation_profile_scope: "exact-profile" },
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });
    expect(exact.decision).toBe("insufficient_evidence");
    expect(exact.out_of_scope_evidence_record_ids).toEqual(
      [first.record_id, second.record_id].sort(),
    );

    const history = evaluateV2ServiceTrust({
      profile_record: current,
      profile_history_records: [historical],
      attestation_records: [first, second],
      policy: policy(),
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });
    expect(history.decision).toBe("bundle_matches_policy");
    expect(history.profile_record_ids_considered).toEqual(
      [current.record_id, historical.record_id].sort(),
    );
  });

  test("reports curated adverse evidence without claiming bundle completeness", async () => {
    const profileRecord = await signedProfile();
    const first = await signedAttestation(profileRecord, traderA, 23);
    const second = await signedAttestation(profileRecord, traderB, 24);
    const adverse = await signedAttestation(profileRecord, traderA, 25, {
      claim_type: "custody.loss_reported",
      stance: "disputes",
      basis: "claimed_evidence_references",
      interaction_ref: null,
      evidence: [{ kind: "case", sha256: sha256Id({ case: 25 }) }],
    });
    const adverseRule = {
      rule_id: "adverse-loss",
      claim_type: "custody.loss_reported",
      stance: "disputes",
      accepted_issuer_key_ids: [traderA.authority.key_id],
      accepted_bases: ["claimed_evidence_references"],
      accepted_evidence_kinds: ["case"],
      minimum_unique_issuers: 0,
      minimum_unique_interactions: 0,
      maximum_unique_issuers: 0,
      max_age_seconds: 365 * 24 * 60 * 60,
    } as const;
    const adversePolicy: ServiceTrustPolicy = {
      ...policy(),
      attestation_rules: [adverseRule, ...policy().attestation_rules],
    };

    const disclosed = evaluateV2ServiceTrust({
      profile_record: profileRecord,
      attestation_records: [first, second, adverse],
      policy: adversePolicy,
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });
    const omitted = evaluateV2ServiceTrust({
      profile_record: profileRecord,
      attestation_records: [first, second],
      policy: adversePolicy,
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });

    expect(disclosed.decision).toBe("bundle_does_not_match_policy");
    expect(disclosed.findings.map(({ code }) => code)).toContain(
      "attestation-limit",
    );
    expect(omitted.decision).toBe("bundle_matches_policy");
    expect(omitted.evidence_bundle_hash).not.toBe(disclosed.evidence_bundle_hash);
    expect(omitted.notices.join(" ")).toMatch(/not a completeness claim|Absence/);
  });

  test("requires distinct claimed interactions when the trader policy says so", async () => {
    const profileRecord = await signedProfile();
    const first = await signedAttestation(profileRecord, traderA, 26);
    const second = await signedAttestation(profileRecord, traderB, 27, {
      interaction_ref: first.attestation.interaction_ref,
    });
    const decision = evaluateV2ServiceTrust({
      profile_record: profileRecord,
      attestation_records: [first, second],
      policy: policy(),
      evaluated_at: "2030-01-15T00:00:00.000Z",
    });

    expect(decision.decision).toBe("insufficient_evidence");
    expect(decision.findings.map(({ code }) => code)).toContain(
      "attestation-interaction-quorum",
    );
  });

  test("rejects unsigned payloads at the only evaluation boundary", () => {
    expect(() => evaluateV2ServiceTrust({
      profile_record: PROFILE,
      attestation_records: [],
      policy: policy(),
      evaluated_at: "2030-01-15T00:00:00.000Z",
    })).toThrow(/unknown CashLoom v2 schema|closed schema|signature|record_id/i);
  });

  test("rejects after-the-fact records from an earlier as-of bundle", async () => {
    const profileRecord = await signedProfile();
    const futureRecord = await signedAttestation(
      profileRecord,
      traderA,
      32,
      { observed_at: "2030-01-10T00:00:00.000Z" },
      "2030-02-01T00:00:00.000Z",
    );

    expect(() => evaluateV2ServiceTrust({
      profile_record: profileRecord,
      attestation_records: [futureRecord],
      policy: policy(),
      evaluated_at: "2030-01-15T00:00:00.000Z",
    })).toThrow(/issued after input\.evaluated_at/);
  });

  test("rejects wrong issuers, subjects, and profile references", async () => {
    const profile = await signedProfile();
    const otherIssuerAttestation = await signedAttestation(profile, traderB, 5);
    expect(() => createServiceAttestationRecord({
      authority: traderA.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(4),
      issued_at: "2030-01-02T00:00:00.000Z",
      expires_at: "2030-06-01T00:00:00.000Z",
      parent_record_id: profile.record_id,
      attestation: {
        ...otherIssuerAttestation.attestation,
        profile_record_id: profile.record_id,
      },
    })).toThrow(/issuer key/i);

    const wrongSubject = await signedAttestation(profile, traderA, 6, {
      subject_key_id: otherShop.authority.key_id,
    });
    expect(() => verifyV2RecordLink(wrongSubject, profile)).toThrow(/subject/i);

    const {
      schema: _attestationSchema,
      signature: _attestationSignature,
      record_id: _attestationRecordId,
      ...attestationInput
    } = wrongSubject;
    expect(() => createServiceAttestationRecord({
      ...attestationInput,
      parent_record_id: sha256Id({ profile: "different" }),
    })).toThrow(/same profile record/i);
  });

  test("allows many independent attestations and requires the profile first", async () => {
    const profile = await signedProfile();
    const first = await signedAttestation(profile, traderA, 7);
    const second = await signedAttestation(profile, traderB, 8);
    const db = new Database(":memory:");
    installCashLoomV2Schema(db);
    const store = new CashLoomV2RecordStore({
      db,
      localNodeKeyId: null,
      remoteLimits: {
        maxRecordCount: 10,
        maxCanonicalBytes: 1024 * 1024,
      },
      now: () => "2030-01-15T00:00:00.000Z",
    });

    try {
      expect(() => store.append(v2RecordBytes(first), "remote")).toThrow(
        /must be admitted first/i,
      );
      expect(store.append(v2RecordBytes(profile), "remote").inserted).toBe(true);
      expect(store.append(v2RecordBytes(first), "remote").inserted).toBe(true);
      expect(store.append(v2RecordBytes(second), "remote").inserted).toBe(true);
      expect(store.getPublic(first.record_id)?.record_id).toBe(first.record_id);
      expect(store.getPublic(second.record_id)?.record_id).toBe(second.record_id);

      const kinds = db.query(
        "SELECT kind FROM cashloom_v2_records ORDER BY kind",
      ).all() as { kind: string }[];
      expect(kinds.map(({ kind }) => kind)).toEqual([
        "service_attestation",
        "service_attestation",
        "service_profile",
      ]);
      expect("list" in store).toBe(false);
    } finally {
      db.close();
    }
  });
});
