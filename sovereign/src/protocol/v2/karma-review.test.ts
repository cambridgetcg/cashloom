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

import {
  evaluateV2Karma,
  evaluateV2KarmaReview,
} from "./karma-evaluation.ts";
import {
  KARMA_OBSERVATION_CHALLENGE_SCHEMA,
  KARMA_OBSERVATION_SCHEMA,
  KARMA_OBSERVATION_WITHDRAWAL_SCHEMA,
  KARMA_POLICY_SCHEMA,
  KARMA_SUBJECT_COMMITMENT_SCHEMA,
  createKarmaSubjectCommitment,
  parseKarmaObservationChallenge,
  parseKarmaObservationWithdrawal,
  type KarmaObservation,
  type KarmaObservationChallenge,
  type KarmaObservationWithdrawal,
  type KarmaPolicy,
  type KarmaSubjectCommitment,
} from "./karma.ts";
import { CashLoomV2RecordStore } from "./record-store.ts";
import {
  createKarmaObservationChallengeRecord,
  createKarmaObservationRecord,
  createKarmaObservationWithdrawalRecord,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  verifyV2RecordLink,
  type KarmaObservationChallengeRecordCore,
  type KarmaObservationRecordCore,
  type KarmaObservationWithdrawalRecordCore,
  type SelfCertifyingAuthority,
  type VerifiedV2Record,
} from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";

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

const issuer = await testAuthority(71);
const challengerA = await testAuthority(72);
const challengerB = await testAuthority(73);

function nonce(serial: number): string {
  const entropy = new Uint8Array(16);
  new DataView(entropy.buffer).setUint32(12, serial);
  return v2Nonce(entropy);
}

const SUBJECT = createKarmaSubjectCommitment({
  schema: KARMA_SUBJECT_COMMITMENT_SCHEMA,
  scope: "market-trade",
  scope_ref: sha256Id({ trade: "review-trade-001" }),
  local_subject_ref: "local-review-subject",
  nonce: nonce(900),
});

const OTHER_SUBJECT = createKarmaSubjectCommitment({
  schema: KARMA_SUBJECT_COMMITMENT_SCHEMA,
  scope: "market-trade",
  scope_ref: sha256Id({ trade: "review-trade-002" }),
  local_subject_ref: "local-review-subject",
  nonce: nonce(901),
});

function policy(): KarmaPolicy {
  return {
    schema: KARMA_POLICY_SCHEMA,
    policy_id: "trader/review-test-policy/v1",
    subject_scope: "market-trade",
    default_recommendation: "proceed",
    rules: [{
      rule_id: "duplicate-recovery-review",
      metric: "market.duplicate-recovery-attempt.count",
      comparison: "at-least",
      threshold: 2,
      accepted_issuer_key_ids: [issuer.authority.key_id],
      minimum_unique_issuers: 1,
      maximum_window_seconds: 10 * 60,
      max_age_seconds: 30 * 24 * 60 * 60,
      recommendation: "manual-review",
    }],
  };
}

async function signedObservation(
  serial: number,
  value = 3,
  subject: KarmaSubjectCommitment = SUBJECT,
  authority: TestAuthority = issuer,
): Promise<VerifiedV2Record<KarmaObservationRecordCore>> {
  const observation: KarmaObservation = {
    schema: KARMA_OBSERVATION_SCHEMA,
    issuer_key_id: authority.authority.key_id,
    assertion_scope: "issuer-observation-only",
    subject,
    metric: "market.duplicate-recovery-attempt.count",
    value,
    window: {
      started_at: "2030-01-01T00:00:00.000Z",
      ended_at: "2030-01-01T00:05:00.000Z",
    },
    observed_at: "2030-01-01T00:06:00.000Z",
    evidence: [],
  };
  return signV2Record(
    createKarmaObservationRecord({
      authority: authority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: "2030-01-01T00:10:00.000Z",
      expires_at: "2030-01-02T00:10:00.000Z",
      parent_record_id: null,
      observation,
    }),
    authority.signer,
  );
}

async function signedWithdrawal(
  target: VerifiedV2Record<KarmaObservationRecordCore>,
  authority: TestAuthority,
  serial: number,
  options: {
    readonly subject?: KarmaSubjectCommitment;
    readonly issued_at?: string;
    readonly withdrawn_at?: string;
    readonly evidence?: readonly Sha256Id[];
  } = {},
): Promise<VerifiedV2Record<KarmaObservationWithdrawalRecordCore>> {
  const issuedAt = options.issued_at ?? "2030-01-03T00:10:00.000Z";
  const withdrawal: KarmaObservationWithdrawal = {
    schema: KARMA_OBSERVATION_WITHDRAWAL_SCHEMA,
    issuer_key_id: authority.authority.key_id,
    assertion_scope: "issuer-withdrawal-only",
    subject: options.subject ?? target.observation.subject,
    target_observation_record_id: target.record_id,
    withdrawn_at: options.withdrawn_at ?? issuedAt,
    evidence: (options.evidence ?? []).map((sha256) => ({ sha256 })),
  };
  return signV2Record(
    createKarmaObservationWithdrawalRecord({
      authority: authority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: "2030-12-31T00:00:00.000Z",
      parent_record_id: target.record_id,
      withdrawal,
    }),
    authority.signer,
  );
}

async function signedChallenge(
  target: VerifiedV2Record<KarmaObservationRecordCore>,
  authority: TestAuthority,
  serial: number,
  options: {
    readonly subject?: KarmaSubjectCommitment;
    readonly issued_at?: string;
    readonly challenged_at?: string;
    readonly evidence?: readonly Sha256Id[];
  } = {},
): Promise<VerifiedV2Record<KarmaObservationChallengeRecordCore>> {
  const issuedAt = options.issued_at ?? "2030-01-03T00:20:00.000Z";
  const challenge: KarmaObservationChallenge = {
    schema: KARMA_OBSERVATION_CHALLENGE_SCHEMA,
    challenger_key_id: authority.authority.key_id,
    assertion_scope: "challenger-report-only",
    subject: options.subject ?? target.observation.subject,
    target_observation_record_id: target.record_id,
    challenged_at: options.challenged_at ?? issuedAt,
    evidence: (options.evidence ?? []).map((sha256) => ({ sha256 })),
  };
  return signV2Record(
    createKarmaObservationChallengeRecord({
      authority: authority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: "2030-12-31T00:00:00.000Z",
      parent_record_id: target.record_id,
      challenge,
    }),
    authority.signer,
  );
}

const REVIEW_TIME = "2030-01-04T00:00:00.000Z";

describe("CashLoom KARMA signed review records", () => {
  test("links digest-only withdrawal and report-only challenge to a historical parent", async () => {
    const target = await signedObservation(1);
    const withdrawal = await signedWithdrawal(
      target,
      issuer,
      2,
      { evidence: [sha256Id({ correction: 1 })] },
    );
    const challenge = await signedChallenge(
      target,
      challengerA,
      3,
      { evidence: [sha256Id({ report: 1 })] },
    );

    expect(Date.parse(target.expires_at)).toBeLessThan(Date.parse(withdrawal.issued_at));
    expect(verifyV2RecordLink(withdrawal, target).parent.record_id).toBe(
      target.record_id,
    );
    expect(verifyV2RecordLink(challenge, target).parent.record_id).toBe(
      target.record_id,
    );
    expect(withdrawal.withdrawal.issuer_key_id).toBe(issuer.authority.key_id);
    expect(challenge.challenge.challenger_key_id).toBe(
      challengerA.authority.key_id,
    );
    expect(challenge.challenge.assertion_scope).toBe("challenger-report-only");

    expect(() => parseKarmaObservationWithdrawal({
      ...withdrawal.withdrawal,
      legal_identity: "Alice Smith",
    })).toThrow(/legal_identity.*not an allowed field/i);
    expect(() => parseKarmaObservationChallenge({
      ...challenge.challenge,
      reason: "fraud by Alice Smith",
    })).toThrow(/reason.*not an allowed field/i);
    expect(() => parseKarmaObservationChallenge({
      ...challenge.challenge,
      evidence: [{
        sha256: sha256Id({ private: "opaque" }),
        url: "https://evidence.invalid/alice@example.com",
      }],
    })).toThrow(/url.*not an allowed field/i);
  });

  test("surfaces challenges without changing matching or recommendation", async () => {
    const target = await signedObservation(10);
    const first = await signedChallenge(target, challengerA, 11, {
      evidence: [sha256Id({ challenge: "first" })],
    });
    const second = await signedChallenge(target, challengerB, 12, {
      evidence: [sha256Id({ challenge: "second" })],
    });
    const base = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [target],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    const reviewed = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [first, second],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    const reversed = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [second, first],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    const oneChallenge = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [first],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });

    expect(reviewed.recommendation).toBe(base.recommendation);
    expect(reviewed.matched_rule_ids).toEqual(base.matched_rule_ids);
    expect(reviewed.evidence_bundle_hash).toBe(base.evidence_bundle_hash);
    expect(reviewed.withdrawn_observation_record_ids).toEqual([]);
    expect(reviewed.challenges).toHaveLength(2);
    expect(reviewed.challenges.every(({ effect_scope }) =>
      effect_scope === "report-only")).toBe(true);
    expect(reviewed.review_bundle_hash).toBe(reversed.review_bundle_hash);
    expect(reviewed.review_bundle_hash).not.toBe(oneChallenge.review_bundle_hash);
    expect(reviewed.capabilities.can_mutate_account).toBe(false);
  });

  test("withdraws only the original before checking a same-slot replacement", async () => {
    const original = await signedObservation(20, 3);
    const replacement = await signedObservation(21, 0);
    const withdrawal = await signedWithdrawal(original, issuer, 22);

    expect(() => evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [original, replacement],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/repeat one issuer\/subject\/metric\/window slot/i);
    const tamperedOriginal = {
      ...original,
      observation: { ...original.observation, value: 999 },
    };
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [tamperedOriginal, replacement],
      withdrawal_records: [withdrawal],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/record_id does not match/i);

    const reviewed = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [original, replacement],
      withdrawal_records: [withdrawal],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    expect(reviewed.recommendation).toBe("proceed");
    expect(reviewed.withdrawn_observation_record_ids).toEqual([
      original.record_id,
    ]);
    expect(reviewed.active_observation_record_ids).toEqual([
      replacement.record_id,
    ]);
    expect(reviewed.original_observation_record_ids).toEqual(
      [original.record_id, replacement.record_id].sort(),
    );
    expect(reviewed.withdrawals[0]?.target_observation_record_id).toBe(
      original.record_id,
    );
  });

  test("rejects cross-issuer withdrawal while a challenge grants no withdrawal authority", async () => {
    const target = await signedObservation(30);
    const unauthorized = await signedWithdrawal(target, challengerA, 31);
    const report = await signedChallenge(target, challengerA, 32);

    expect(() => verifyV2RecordLink(unauthorized, target)).toThrow(
      /only the exact observation issuer/i,
    );
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      withdrawal_records: [unauthorized],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/only the exact observation issuer/i);

    const reviewed = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [report],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    expect(reviewed.active_observation_record_ids).toEqual([target.record_id]);
    expect(reviewed.recommendation).toBe("manual-review");
    expect(reviewed.withdrawal_record_ids).toEqual([]);
  });

  test("rejects review replay and semantic duplicate review records", async () => {
    const target = await signedObservation(40);
    const withdrawal = await signedWithdrawal(target, issuer, 41);
    const secondWithdrawal = await signedWithdrawal(target, issuer, 42);
    const challenge = await signedChallenge(target, challengerA, 43);
    const resignedChallenge = await signedChallenge(target, challengerA, 44, {
      evidence: [sha256Id({ second: true })],
    });

    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      withdrawal_records: [withdrawal, withdrawal],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/repeats record ID/i);
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      withdrawal_records: [withdrawal, secondWithdrawal],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/repeat one target slot/i);
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [challenge, resignedChallenge],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/repeat one challenger\/target slot/i);
  });

  test("rejects orphan, wrong-schema, cross-subject, future, and time-invalid review", async () => {
    const target = await signedObservation(50);
    const challenge = await signedChallenge(target, challengerA, 51);
    const otherTarget = await signedObservation(52, 3, OTHER_SUBJECT);
    const crossSubject = await signedChallenge(otherTarget, challengerA, 53);
    const wrongSubject = await signedChallenge(target, challengerA, 54, {
      subject: OTHER_SUBJECT,
    });
    const future = await signedChallenge(target, challengerB, 55, {
      issued_at: "2030-01-05T00:00:00.000Z",
    });
    const predating = await signedWithdrawal(target, issuer, 56, {
      withdrawn_at: "2029-12-31T00:00:00.000Z",
    });

    expect(() => createKarmaObservationWithdrawalRecord({
      authority: challengerA.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(57),
      issued_at: "2030-01-03T00:30:00.000Z",
      expires_at: "2030-12-31T00:00:00.000Z",
      parent_record_id: target.record_id,
      withdrawal: predating.withdrawal,
    })).toThrow(/withdrawal issuer must match/i);
    expect(() => createKarmaObservationChallengeRecord({
      authority: challengerB.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(58),
      issued_at: "2030-01-03T00:30:00.000Z",
      expires_at: "2030-12-31T00:00:00.000Z",
      parent_record_id: target.record_id,
      challenge: challenge.challenge,
    })).toThrow(/challenge signer must match/i);
    expect(() => createKarmaObservationChallengeRecord({
      authority: challengerA.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(59),
      issued_at: "2030-01-03T00:30:00.000Z",
      expires_at: "2030-12-31T00:00:00.000Z",
      parent_record_id: target.record_id,
      challenge: {
        ...challenge.challenge,
        target_observation_record_id: sha256Id({ orphan: "different" }),
      },
    })).toThrow(/payload and envelope must name the same observation/i);

    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [],
      challenge_records: [challenge],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/orphan target/i);
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      withdrawal_records: [challenge],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/withdrawal input requires/i);
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [otherTarget],
      challenge_records: [crossSubject],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/different scoped subject/i);
    expect(() => verifyV2RecordLink(wrongSubject, target)).toThrow(
      /retain its exact observation subject/i,
    );
    expect(() => evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [future],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    })).toThrow(/issued after/i);
    expect(() => verifyV2RecordLink(predating, target)).toThrow(/cannot predate/i);
  });

  test("binds exact subject, policy, time, IDs, and target mappings in the review hash", async () => {
    const target = await signedObservation(60);
    const report = await signedChallenge(target, challengerA, 61);
    const reviewed = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [report],
      policy: policy(),
      evaluated_at: REVIEW_TIME,
    });
    const later = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [report],
      policy: policy(),
      evaluated_at: "2030-01-04T00:00:01.000Z",
    });
    const stricterPolicy: KarmaPolicy = {
      ...policy(),
      rules: [{ ...policy().rules[0]!, threshold: 4 }],
    };
    const stricter = evaluateV2KarmaReview({
      subject: SUBJECT,
      observation_records: [target],
      challenge_records: [report],
      policy: stricterPolicy,
      evaluated_at: REVIEW_TIME,
    });

    expect(reviewed.review_bundle_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(reviewed.review_bundle_hash).not.toBe(later.review_bundle_hash);
    expect(reviewed.review_bundle_hash).not.toBe(stricter.review_bundle_hash);
    expect(reviewed.challenge_record_ids).toEqual([report.record_id]);
    expect(reviewed.challenges[0]).toMatchObject({
      review_record_id: report.record_id,
      target_observation_record_id: target.record_id,
    });
  });

  test("stores one exclusive withdrawal while retaining multiple reports", async () => {
    const db = new Database(":memory:", { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    installCashLoomV2Schema(db);
    const store = new CashLoomV2RecordStore({
      db,
      localNodeKeyId: null,
      remoteLimits: { maxRecordCount: 20, maxCanonicalBytes: 200_000 },
      now: () => REVIEW_TIME,
    });
    const target = await signedObservation(70);
    const withdrawal = await signedWithdrawal(target, issuer, 71);
    const secondWithdrawal = await signedWithdrawal(target, issuer, 72);
    const firstReport = await signedChallenge(target, challengerA, 73);
    const secondReport = await signedChallenge(target, challengerB, 74);

    store.append(v2RecordBytes(target), "remote");
    expect(store.append(v2RecordBytes(withdrawal), "remote").inserted).toBe(true);
    expect(() => store.append(v2RecordBytes(secondWithdrawal), "remote")).toThrow(
      /already has cashloom\/karma-observation-withdrawal\/v2 successor/i,
    );
    expect(store.append(v2RecordBytes(firstReport), "remote").inserted).toBe(true);
    expect(store.append(v2RecordBytes(secondReport), "remote").inserted).toBe(true);
    db.close();
  });
});
