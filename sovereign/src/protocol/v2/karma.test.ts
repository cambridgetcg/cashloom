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

import { evaluateV2Karma } from "./karma-evaluation.ts";
import {
  KARMA_OBSERVATION_SCHEMA,
  KARMA_POLICY_SCHEMA,
  KARMA_SUBJECT_COMMITMENT_SCHEMA,
  createKarmaSubjectCommitment,
  parseKarmaObservation,
  type KarmaMetric,
  type KarmaObservation,
  type KarmaPolicy,
  type KarmaSubjectCommitment,
} from "./karma.ts";
import { CashLoomV2RecordStore } from "./record-store.ts";
import {
  createKarmaObservationRecord,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  verifyV2Record,
  verifyV2RecordLink,
  type KarmaObservationRecordCore,
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

const observerA = await testAuthority(61);
const observerB = await testAuthority(62);
const unpinnedObserver = await testAuthority(63);

function nonce(serial: number): string {
  const entropy = new Uint8Array(16);
  new DataView(entropy.buffer).setUint32(12, serial);
  return v2Nonce(entropy);
}

const SUBJECT = createKarmaSubjectCommitment({
  schema: KARMA_SUBJECT_COMMITMENT_SCHEMA,
  scope: "market-trade",
  scope_ref: sha256Id({ market_trade: "trade-local-001" }),
  local_subject_ref: "local-participant-42",
  nonce: nonce(700),
});

const OTHER_SUBJECT = createKarmaSubjectCommitment({
  schema: KARMA_SUBJECT_COMMITMENT_SCHEMA,
  scope: "market-trade",
  scope_ref: sha256Id({ market_trade: "trade-local-002" }),
  local_subject_ref: "local-participant-42",
  nonce: nonce(701),
});

function observation(
  issuer: TestAuthority,
  metric: KarmaMetric,
  value: number,
  subject: KarmaSubjectCommitment = SUBJECT,
): KarmaObservation {
  return {
    schema: KARMA_OBSERVATION_SCHEMA,
    issuer_key_id: issuer.authority.key_id,
    assertion_scope: "issuer-observation-only",
    subject,
    metric,
    value,
    window: {
      started_at: "2030-01-02T00:00:00.000Z",
      ended_at: "2030-01-02T00:05:00.000Z",
    },
    observed_at: "2030-01-02T00:06:00.000Z",
    evidence: [],
  };
}

async function signedObservation(
  issuer: TestAuthority,
  serial: number,
  metric: KarmaMetric,
  value: number,
  subject: KarmaSubjectCommitment = SUBJECT,
  overrides: Partial<KarmaObservation> = {},
  issuedAt = "2030-01-02T00:10:00.000Z",
): Promise<VerifiedV2Record<KarmaObservationRecordCore>> {
  return signV2Record(
    createKarmaObservationRecord({
      authority: issuer.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: "2031-01-01T00:00:00.000Z",
      parent_record_id: null,
      observation: {
        ...observation(issuer, metric, value, subject),
        ...overrides,
      },
    }),
    issuer.signer,
  );
}

function policy(
  threshold = 2,
  accepted: readonly TestAuthority[] = [observerA, observerB],
): KarmaPolicy {
  return {
    schema: KARMA_POLICY_SCHEMA,
    policy_id: `trader/local-market-policy/threshold-${threshold}`,
    subject_scope: "market-trade",
    default_recommendation: "proceed",
    rules: [
      {
        rule_id: "duplicate-recovery-review",
        metric: "market.duplicate-recovery-attempt.count",
        comparison: "at-least",
        threshold,
        accepted_issuer_key_ids: accepted
          .map(({ authority }) => authority.key_id)
          .sort() as Sha256Id[],
        minimum_unique_issuers: accepted.length,
        maximum_window_seconds: 10 * 60,
        max_age_seconds: 30 * 24 * 60 * 60,
        recommendation: "withhold-settlement-handoff",
      },
    ],
  };
}

describe("CashLoom KARMA signed observations and local evaluation", () => {
  test("signs an independent scoped issuer claim without identity or authority verdicts", async () => {
    const record = await signedObservation(
      observerA,
      1,
      "market.completed-trade.count",
      1,
    );
    const verified = verifyV2Record(v2RecordBytes(record));

    expect(verified.schema).toBe("cashloom/karma-observation/v2");
    expect(verified.parent_record_id).toBeNull();
    expect(record.observation.subject.commitment).toBe(SUBJECT.commitment);
    expect(record.observation.assertion_scope).toBe("issuer-observation-only");
    expect(record.observation).not.toHaveProperty("identity");
    expect(record.observation).not.toHaveProperty("guilty");
    expect(record.observation).not.toHaveProperty("blacklist");
    const unrelated = await signedObservation(
      observerB,
      101,
      "market.completed-trade.count",
      1,
    );
    expect(() => verifyV2RecordLink(record, unrelated)).toThrow(/independent root/i);
  });

  test("keeps ordinary behaviour at the explicit local default", async () => {
    const completed = await signedObservation(
      observerA,
      2,
      "market.completed-trade.count",
      1,
    );
    const result = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [completed],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });

    expect(result.recommendation).toBe("proceed");
    expect(result.matched_rule_ids).toEqual([]);
    expect(result.in_scope_observation_record_ids).toEqual([completed.record_id]);
    expect(result.effect_scope).toBe("advisory-only");
    expect(result.capabilities).toEqual({
      can_execute_payment: false,
      can_mutate_account: false,
      can_settle_refund_or_reroute_funds: false,
    });
  });

  test("recognises a bounded traditional abuse pattern only from pinned issuers", async () => {
    const first = await signedObservation(
      observerA,
      3,
      "market.duplicate-recovery-attempt.count",
      3,
    );
    const second = await signedObservation(
      observerB,
      4,
      "market.duplicate-recovery-attempt.count",
      2,
    );
    const result = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [first, second],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });

    expect(result.recommendation).toBe("withhold-settlement-handoff");
    expect(result.matched_rule_ids).toEqual(["duplicate-recovery-review"]);
    expect(result.rule_evaluations[0]?.matching_issuer_key_ids).toHaveLength(2);
    expect(result.rule_evaluations[0]?.matching_record_ids).toEqual(
      [first.record_id, second.record_id].sort(),
    );
    expect(result.notices.join(" ")).toMatch(/issuer claims|participant may disagree/i);
  });

  test("allows two participants to disagree over the exact same signed evidence", async () => {
    const first = await signedObservation(
      observerA,
      5,
      "market.duplicate-recovery-attempt.count",
      3,
    );
    const second = await signedObservation(
      observerB,
      6,
      "market.duplicate-recovery-attempt.count",
      3,
    );
    const input = {
      subject: SUBJECT,
      observation_records: [first, second],
      evaluated_at: "2030-01-03T00:00:00.000Z",
    } as const;

    const lowerTolerance = evaluateV2Karma({ ...input, policy: policy(2) });
    const higherTolerance = evaluateV2Karma({ ...input, policy: policy(10) });

    expect(lowerTolerance.recommendation).toBe("withhold-settlement-handoff");
    expect(higherTolerance.recommendation).toBe("proceed");
    expect(lowerTolerance.supplied_observation_record_ids).toEqual(
      higherTolerance.supplied_observation_record_ids,
    );
    expect(lowerTolerance.policy_hash).not.toBe(higherTolerance.policy_hash);
  });

  test("distinguishes a short burst from the same count over an ordinary long window", async () => {
    const burst = await signedObservation(
      observerA,
      60,
      "market.duplicate-recovery-attempt.count",
      3,
    );
    const longHorizon = await signedObservation(
      observerA,
      61,
      "market.duplicate-recovery-attempt.count",
      3,
      SUBJECT,
      {
        window: {
          started_at: "2030-01-01T00:05:00.000Z",
          ended_at: "2030-01-02T00:05:00.000Z",
        },
      },
    );
    const localPolicy = policy(2, [observerA]);

    const burstResult = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [burst],
      policy: localPolicy,
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });
    const longHorizonResult = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [longHorizon],
      policy: localPolicy,
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });

    expect(burstResult.recommendation).toBe("withhold-settlement-handoff");
    expect(longHorizonResult.recommendation).toBe("proceed");
    expect(burstResult.rule_evaluations[0]?.maximum_window_seconds).toBe(600);
    expect(longHorizonResult.rule_evaluations[0]?.matching_record_ids).toEqual([]);

    const delayedOldClaim = await signedObservation(
      observerA,
      62,
      "market.duplicate-recovery-attempt.count",
      3,
      SUBJECT,
      {
        window: {
          started_at: "2030-01-01T00:00:00.000Z",
          ended_at: "2030-01-01T00:05:00.000Z",
        },
        observed_at: "2030-01-02T00:06:00.000Z",
      },
    );
    const recentOnlyPolicy: KarmaPolicy = {
      ...localPolicy,
      rules: [{ ...localPolicy.rules[0]!, max_age_seconds: 60 * 60 }],
    };
    const delayedResult = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [delayedOldClaim],
      policy: recentOnlyPolicy,
      evaluated_at: "2030-01-02T00:30:00.000Z",
    });
    const recentResult = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [burst],
      policy: recentOnlyPolicy,
      evaluated_at: "2030-01-02T00:30:00.000Z",
    });
    expect(delayedResult.recommendation).toBe("proceed");
    expect(recentResult.recommendation).toBe("withhold-settlement-handoff");
  });

  test("rejects replayed IDs and semantic re-signing while one issuer cannot amplify quorum", async () => {
    const first = await signedObservation(
      observerA,
      7,
      "market.duplicate-recovery-attempt.count",
      3,
    );
    const resignedSameSlot = await signedObservation(
      observerA,
      8,
      "market.duplicate-recovery-attempt.count",
      99,
    );

    expect(() => evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [first, first],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    })).toThrow(/repeats record ID/i);
    expect(() => evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [first, resignedSameSlot],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    })).toThrow(/repeat one issuer\/subject\/metric\/window slot/i);

    const laterWindow = await signedObservation(
      observerA,
      9,
      "market.duplicate-recovery-attempt.count",
      99,
      SUBJECT,
      {
        window: {
          started_at: "2030-01-02T01:00:00.000Z",
          ended_at: "2030-01-02T01:05:00.000Z",
        },
        observed_at: "2030-01-02T01:06:00.000Z",
      },
      "2030-01-02T01:10:00.000Z",
    );
    const result = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [first, laterWindow],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });
    expect(result.recommendation).toBe("proceed");
    expect(result.rule_evaluations[0]?.matching_issuer_key_ids).toEqual([
      observerA.authority.key_id,
    ]);
  });

  test("fails closed on malformed or future claims and ignores unpinned/out-of-scope claims", async () => {
    const malformed = {
      ...observation(
        observerA,
        "market.duplicate-recovery-attempt.count",
        2,
      ),
      guilty: true,
    };
    expect(() => parseKarmaObservation(malformed)).toThrow(/guilty.*not an allowed field/i);
    const opaqueEvidenceHash = sha256Id({ evidence: "opaque" });
    expect(() => parseKarmaObservation({
      ...observation(
        observerA,
        "market.duplicate-recovery-attempt.count",
        2,
      ),
      evidence: [{ sha256: opaqueEvidenceHash }],
    })).not.toThrow();
    expect(() => parseKarmaObservation({
      ...observation(
        observerA,
        "market.duplicate-recovery-attempt.count",
        2,
      ),
      evidence: [{
        kind: "legal-identity.alice-smith",
        sha256: opaqueEvidenceHash,
      }],
    })).toThrow(/kind.*not an allowed field/i);
    expect(() => parseKarmaObservation({
      ...observation(
        observerA,
        "market.duplicate-recovery-attempt.count",
        2,
      ),
      evidence: [{
        sha256: opaqueEvidenceHash,
        url: "https://evidence.invalid/users/alice@example.com",
      }],
    })).toThrow(/url.*not an allowed field/i);
    expect(() => createKarmaObservationRecord({
      authority: observerB.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(10),
      issued_at: "2030-01-02T00:10:00.000Z",
      expires_at: "2031-01-01T00:00:00.000Z",
      parent_record_id: null,
      observation: observation(
        observerA,
        "market.duplicate-recovery-attempt.count",
        2,
      ),
    })).toThrow(/issuer must match/i);

    const future = await signedObservation(
      observerA,
      11,
      "market.duplicate-recovery-attempt.count",
      2,
      SUBJECT,
      {
        window: {
          started_at: "2030-02-01T00:00:00.000Z",
          ended_at: "2030-02-01T00:05:00.000Z",
        },
        observed_at: "2030-02-01T00:06:00.000Z",
      },
      "2030-02-01T00:10:00.000Z",
    );
    expect(() => evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [future],
      policy: policy(),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    })).toThrow(/issued after/i);

    const unpinned = await signedObservation(
      unpinnedObserver,
      12,
      "market.duplicate-recovery-attempt.count",
      99,
    );
    const otherSubject = await signedObservation(
      observerA,
      13,
      "market.duplicate-recovery-attempt.count",
      99,
      OTHER_SUBJECT,
    );
    const result = evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [unpinned, otherSubject],
      policy: policy(2, [observerA]),
      evaluated_at: "2030-01-03T00:00:00.000Z",
    });
    expect(result.recommendation).toBe("proceed");
    expect(result.out_of_scope_observation_record_ids).toEqual([
      otherSubject.record_id,
    ]);
    expect(result.rule_evaluations[0]?.matching_record_ids).toEqual([]);
  });

  test("rejects observation and policy metrics from a different commitment scope", () => {
    expect(() => parseKarmaObservation({
      ...observation(observerA, "market.completed-trade.count", 1),
      metric: "account.authentication-failure.count",
    })).toThrow(/requires subject\.scope account-session/i);

    expect(() => evaluateV2Karma({
      subject: SUBJECT,
      observation_records: [],
      policy: {
        ...policy(2, [observerA]),
        rules: [{
          ...policy(2, [observerA]).rules[0],
          metric: "payment.attempt-failed.count",
        }],
      },
      evaluated_at: "2030-01-03T00:00:00.000Z",
    })).toThrow(/requires policy\.subject_scope payment-attempt/i);
  });

  test("stores the new root idempotently without turning storage into an evaluator", async () => {
    const db = new Database(":memory:", { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    installCashLoomV2Schema(db);
    const store = new CashLoomV2RecordStore({
      db,
      localNodeKeyId: null,
      remoteLimits: {
        maxRecordCount: 10,
        maxCanonicalBytes: 100_000,
      },
      now: () => "2030-01-03T00:00:00.000Z",
    });
    const record = await signedObservation(
      observerA,
      14,
      "market.completed-trade.count",
      1,
    );
    const bytes = v2RecordBytes(record);

    expect(store.append(bytes, "remote").inserted).toBe(true);
    expect(store.append(bytes, "remote").inserted).toBe(false);
    expect(store.getPublic(record.record_id)?.record_id).toBe(record.record_id);
    expect(store).not.toHaveProperty("evaluateKarma");
    db.close();
  });
});
