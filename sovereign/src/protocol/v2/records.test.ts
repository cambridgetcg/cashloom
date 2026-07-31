import { describe, expect, test } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  keyIdForPublicKey,
  sha256Id,
  signatureFromBase64Url,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";

import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
  type AssetTrustManifest,
  type AssetTrustPolicy,
} from "./asset-trust.ts";
import {
  V2_MAX_RECORD_BYTES,
  V2_SCHEMAS,
  createAssetTrustManifestRecord,
  createExecutionCommitment,
  createNodeDescriptor,
  createPaymentIntent,
  createPaymentRequest,
  createSelfCertifyingAuthority,
  createServiceAttestationRecord,
  createServiceProfileRecord,
  createSettlementReceipt,
  createSubmissionReceipt,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  v2RecordDigest,
  verifyV2AssetTrustBinding,
  verifyV2Record,
  verifyV2RecordChain,
  verifyV2RecordLink,
  type AssetTrustManifestRecordCore,
  type ExecutionCommitmentCore,
  type NodeDescriptorCore,
  type PaymentIntentCore,
  type PaymentRequestCore,
  type SelfCertifyingAuthority,
  type SettlementReceiptCore,
  type ServiceProfileRecordCore,
  type SignedV2Record,
  type SubmissionReceiptCore,
  type V2RecordCore,
  type VerifiedV2Record,
} from "./records.ts";
import {
  SERVICE_ATTESTATION_SCHEMA,
  SERVICE_PROFILE_SCHEMA,
} from "./service-trust.ts";

interface TestAuthority {
  authority: SelfCertifyingAuthority;
  signer: RecordSigner;
}

const testAuthority = async (seedByte: number): Promise<TestAuthority> => {
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
};

const merchant = await testAuthority(1);
const payer = await testAuthority(2);
const trustBinding = (authorityKeyId: `sha256:${string}`, label: string) => ({
  manifest_record_id: sha256Id({ manifest: label }),
  manifest_authority_key_id: authorityKeyId,
  policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
  policy_hash: assetTrustPolicyHash(FAIL_CLOSED_ASSET_TRUST_POLICY),
});

const ASSET =
  "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FEE_ASSET = "eip155:8453/slip44:60";
const MERCHANT_ACCOUNT =
  "eip155:8453:0x2222222222222222222222222222222222222222";
const PAYER_ACCOUNT =
  "eip155:8453:0x1111111111111111111111111111111111111111";
const NOW = "2030-01-01T00:06:00.000Z";

const ASSET_MANIFEST = {
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "evm-base",
  asset_id: ASSET,
  chain_id: "eip155:8453",
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: "2029-12-31T23:59:00.000Z",
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
    categories: ["public-ledger", "sequencer-operator", "regulated-provider"],
  },
  evidence: [],
} as const satisfies AssetTrustManifest;

const nonce = (byte: number): string => v2Nonce(new Uint8Array(16).fill(byte));

async function signedAssetManifest(): Promise<
  VerifiedV2Record<AssetTrustManifestRecordCore>
> {
  return signV2Record(
    createAssetTrustManifestRecord({
      authority: merchant.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(10),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-15T00:00:00.000Z",
      parent_record_id: null,
      manifest: ASSET_MANIFEST,
    }),
    merchant.signer,
  );
}

async function signedServiceProfile(): Promise<
  VerifiedV2Record<ServiceProfileRecordCore>
> {
  return signV2Record(
    createServiceProfileRecord({
      authority: merchant.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(12),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-15T00:00:00.000Z",
      parent_record_id: null,
      profile: {
        schema: SERVICE_PROFILE_SCHEMA,
        service_key_id: merchant.authority.key_id,
        provenance: {
          kind: "self-assertion",
          asserted_at: "2030-01-01T00:00:00.000Z",
        },
        capabilities: [],
        claims: [],
        claimed_settlement_provider_key_ids: [],
        claimed_dispute_resolver_key_ids: [],
        evidence: [],
      },
    }),
    merchant.signer,
  );
}

interface ChainOptions {
  intentParent?: `sha256:${string}`;
  intentAudience?: `sha256:${string}`;
  duplicateCommitmentNonce?: boolean;
}

async function buildChain(options: ChainOptions = {}): Promise<{
  values: [
    VerifiedV2Record<NodeDescriptorCore>,
    VerifiedV2Record<PaymentRequestCore>,
    VerifiedV2Record<PaymentIntentCore>,
    VerifiedV2Record<ExecutionCommitmentCore>,
    VerifiedV2Record<SubmissionReceiptCore>,
    VerifiedV2Record<SettlementReceiptCore>,
  ];
}> {
  const descriptor = await signV2Record(
    createNodeDescriptor({
      authority: merchant.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(1),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-08T00:00:00.000Z",
      parent_record_id: null,
      roles: ["merchant"],
      endpoints: [
        {
          rel: "record_read",
          path: "/v2/records/{record_id}",
        },
        {
          rel: "records_ingest",
          path: "/v2/records",
        },
      ],
    }),
    merchant.signer,
  );

  const request = await signV2Record(
    createPaymentRequest({
      authority: merchant.authority,
      audience: payer.authority.key_id,
      disclosure: "public",
      nonce: nonce(2),
      issued_at: "2030-01-01T00:01:00.000Z",
      expires_at: "2030-01-01T01:00:00.000Z",
      parent_record_id: descriptor.record_id,
      rail: "evm-base",
      destination: MERCHANT_ACCOUNT,
      asset_id: ASSET,
      amount_atomic: "2500000",
      purpose_hash: sha256Id({ order: "order-7" }),
      asset_trust: trustBinding(merchant.authority.key_id, "merchant-payment"),
    }),
    merchant.signer,
  );

  const intent = await signV2Record(
    createPaymentIntent({
      authority: payer.authority,
      audience: options.intentAudience ?? merchant.authority.key_id,
      disclosure: "private",
      nonce: nonce(3),
      issued_at: "2030-01-01T00:02:00.000Z",
      expires_at: "2030-01-01T00:10:00.000Z",
      parent_record_id: options.intentParent ?? request.record_id,
      rail: "evm-base",
      destination: MERCHANT_ACCOUNT,
      source_account: PAYER_ACCOUNT,
      asset_id: ASSET,
      amount_atomic: "2500000",
      fee_asset_id: FEE_ASSET,
      fee_limit_scope: "total_fee_asset_exposure",
      max_fee_atomic: "50000000000000",
      payment_asset_trust: trustBinding(
        payer.authority.key_id,
        "payer-payment",
      ),
      fee_asset_trust: trustBinding(payer.authority.key_id, "payer-fee"),
    }),
    payer.signer,
  );

  const commitment = await signV2Record(
    createExecutionCommitment({
      authority: payer.authority,
      audience: merchant.authority.key_id,
      disclosure: "private",
      nonce: options.duplicateCommitmentNonce ? intent.nonce : nonce(4),
      issued_at: "2030-01-01T00:03:00.000Z",
      expires_at: "2030-01-01T00:09:00.000Z",
      parent_record_id: intent.record_id,
      rail: "evm-base",
      source_account: PAYER_ACCOUNT,
      destination: MERCHANT_ACCOUNT,
      asset_id: ASSET,
      amount_atomic: "2500000",
      fee_asset_id: FEE_ASSET,
      fee_limit_scope: "total_fee_asset_exposure",
      max_fee_atomic: "50000000000000",
      reservation_id: sha256Id({ chain: 8453, address: PAYER_ACCOUNT, nonce: 17 }),
      unsigned_payload_hash: sha256Id({ unsigned: "02f8..." }),
    }),
    payer.signer,
  );

  const submission = await signV2Record(
    createSubmissionReceipt({
      authority: payer.authority,
      audience: merchant.authority.key_id,
      disclosure: "private",
      nonce: nonce(5),
      issued_at: "2030-01-01T00:04:00.000Z",
      expires_at: "2030-01-02T00:04:00.000Z",
      parent_record_id: commitment.record_id,
      signed_payload_hash: sha256Id({ signed: "02f901..." }),
      operation_id: `0x${"ab".repeat(32)}`,
      state: "submitted",
      submitted_at: "2030-01-01T00:04:00.000Z",
    }),
    payer.signer,
  );

  const settlement = await signV2Record(
    createSettlementReceipt({
      authority: merchant.authority,
      audience: payer.authority.key_id,
      disclosure: "private",
      nonce: nonce(6),
      issued_at: "2030-01-01T00:05:00.000Z",
      expires_at: "2030-02-01T00:05:00.000Z",
      parent_record_id: submission.record_id,
      asserted_outcome: "settled",
      attestation_scope: "issuer_assertion_only",
      evidence_kind: "chain_finality_reference",
      evidence_hash: sha256Id({ block: 12345, transaction: submission.operation_id }),
      observed_at: "2030-01-01T00:05:00.000Z",
    }),
    merchant.signer,
  );

  const values = [
    descriptor,
    request,
    intent,
    commitment,
    submission,
    settlement,
  ] satisfies [
    VerifiedV2Record<NodeDescriptorCore>,
    VerifiedV2Record<PaymentRequestCore>,
    VerifiedV2Record<PaymentIntentCore>,
    VerifiedV2Record<ExecutionCommitmentCore>,
    VerifiedV2Record<SubmissionReceiptCore>,
    VerifiedV2Record<SettlementReceiptCore>,
  ];

  return { values };
}

function unsigned<T extends V2RecordCore>(record: SignedV2Record<T>): T {
  const { record_id: _recordId, signature: _signature, ...core } = record;
  return core as unknown as T;
}

function withRecomputedId(record: Record<string, any>): Record<string, any> {
  const { record_id: _recordId, ...withoutId } = record;
  return { ...withoutId, record_id: sha256Id(withoutId) };
}

describe("CashLoom v2 signed records", () => {
  test("constructs, signs, canonically transports, and verifies the full authority chain", async () => {
    const { values } = await buildChain();
    const verified = verifyV2RecordChain(values, { now: NOW });

    expect(verified.payment_request.parent_record_id).toBe(
      verified.node_descriptor.record_id,
    );
    expect(verified.payment_intent.parent_record_id).toBe(
      verified.payment_request.record_id,
    );
    expect(verified.execution_commitment.parent_record_id).toBe(
      verified.payment_intent.record_id,
    );
    expect(verified.submission_receipt.parent_record_id).toBe(
      verified.execution_commitment.record_id,
    );
    expect(verified.settlement_receipt.parent_record_id).toBe(
      verified.submission_receipt.record_id,
    );
    expect(verified.payment_intent.authority.key_id).toBe(payer.authority.key_id);
    expect(verified.settlement_receipt.authority.key_id).toBe(
      merchant.authority.key_id,
    );
    expect(verified.settlement_receipt.attestation_scope).toBe(
      "issuer_assertion_only",
    );
    expect(verified.payment_request.disclosure).toBe("public");
    expect(verified.payment_request.audience).toBe(payer.authority.key_id);
    expect(verified.payment_intent.asset_id).not.toBe(
      verified.payment_intent.fee_asset_id,
    );
    expect(verified.payment_intent.rail).toBe(verified.payment_request.rail);
    expect(verified.payment_intent.destination).toBe(
      verified.payment_request.destination,
    );
    expect(verified.payment_request.asset_trust.policy_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(verified.payment_intent.payment_asset_trust.policy_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(verified.execution_commitment.fee_asset_id).toBe(FEE_ASSET);
    expect(verified.payment_intent.fee_limit_scope).toBe(
      "total_fee_asset_exposure",
    );
    expect(verified.node_descriptor.endpoints.map(({ rel }) => rel)).toEqual([
      "record_read",
      "records_ingest",
    ]);
    expect(Object.isFrozen(verified)).toBe(true);

    for (const record of values) {
      expect(verifyV2Record(v2RecordBytes(record)).record_id).toBe(record.record_id);
    }
  });

  test("verifies each parent edge independently for append-only ingest", async () => {
    const { values } = await buildChain();
    for (let index = 1; index < values.length; index += 1) {
      const link = verifyV2RecordLink(values[index], values[index - 1]);
      expect(link.child.parent_record_id).toBe(link.parent.record_id);
    }

    expect(() => verifyV2RecordLink(values[2], values[0])).toThrow(
      /payment request/i,
    );

    const commitmentCore = unsigned(values[3]);
    const {
      schema: _commitmentSchema,
      ...commitmentInput
    } = commitmentCore;
    const wrongFeeAsset = await signV2Record(
      createExecutionCommitment({
        ...commitmentInput,
        fee_asset_id: ASSET,
      }),
      payer.signer,
    );
    expect(() => verifyV2RecordLink(wrongFeeAsset, values[2])).toThrow(
      /fee_asset_id/i,
    );

    const redirected = await signV2Record(
      createExecutionCommitment({
        ...commitmentInput,
        destination: `${MERCHANT_ACCOUNT}-redirected`,
      }),
      payer.signer,
    );
    expect(() => verifyV2RecordLink(redirected, values[2])).toThrow(
      /destination/i,
    );
  });

  test("refuses public children of private parents while allowing targeted public requests", async () => {
    const { values } = await buildChain();
    expect(values[1].disclosure).toBe("public");
    expect(values[1].audience).toBe(payer.authority.key_id);

    const requestCore = unsigned(values[1]);
    const { schema: _requestSchema, ...requestInput } = requestCore;
    const privateRequest = await signV2Record(
      createPaymentRequest({ ...requestInput, disclosure: "private" }),
      merchant.signer,
    );

    const intentCore = unsigned(values[2]);
    const { schema: _intentSchema, ...intentInput } = intentCore;
    const publicIntent = await signV2Record(
      createPaymentIntent({
        ...intentInput,
        disclosure: "public",
        parent_record_id: privateRequest.record_id,
      }),
      payer.signer,
    );

    expect(() => verifyV2RecordLink(publicIntent, privateRequest)).toThrow(
      /public record cannot depend on a private parent/i,
    );
  });

  test("uses a distinct signing domain for every closed record schema", async () => {
    const { values } = await buildChain();
    const assetManifest = await signedAssetManifest();
    const serviceProfile = await signedServiceProfile();
    const serviceAttestation = await signV2Record(
      createServiceAttestationRecord({
        authority: payer.authority,
        audience: "public",
        disclosure: "public",
        nonce: nonce(13),
        issued_at: "2030-01-01T00:01:00.000Z",
        expires_at: "2030-02-01T00:00:00.000Z",
        parent_record_id: serviceProfile.record_id,
        attestation: {
          schema: SERVICE_ATTESTATION_SCHEMA,
          issuer_key_id: payer.authority.key_id,
          subject_key_id: merchant.authority.key_id,
          profile_record_id: serviceProfile.record_id,
          assertion_scope: "issuer-assertion-only",
          claim_type: "service.observed",
          stance: "neutral",
          basis: "unlinked_assertion",
          interaction_ref: null,
          observed_at: "2030-01-01T00:01:00.000Z",
          evidence: [],
        },
      }),
      payer.signer,
    );
    const digests = [
      ...values,
      assetManifest,
      serviceProfile,
      serviceAttestation,
    ].map((record) =>
      Buffer.from(v2RecordDigest(unsigned(record))).toString("hex"));
    expect(new Set(digests).size).toBe(Object.keys(V2_SCHEMAS).length);
  });

  test("signs the strict local asset assessment as an independent authority claim", async () => {
    const record = await signedAssetManifest();

    expect(record.schema).toBe(V2_SCHEMAS.asset_trust_manifest);
    expect(record.manifest.asset_id).toBe(ASSET);
    expect(record.parent_record_id).toBeNull();
    expect(verifyV2Record(v2RecordBytes(record)).record_id).toBe(record.record_id);
    expect(V2_MAX_RECORD_BYTES).toBe(32 * 1024);

    const withPii = {
      ...record,
      manifest: { ...record.manifest, issuer_name: "A global identity" },
    };
    expect(() => verifyV2Record(withPii)).toThrow(/not an allowed field|closed schema/i);
  });

  test("replays an exact embedded policy against its signed manifest reference", async () => {
    const manifest = await signedAssetManifest();
    const localBasePolicy = {
      ...FAIL_CLOSED_ASSET_TRUST_POLICY,
      policy_id: "records-test-base-policy/v2",
      allowed_settlement_models: [
        ...FAIL_CLOSED_ASSET_TRUST_POLICY.allowed_settlement_models,
        "optimistic-rollup",
      ],
      reject_single_sequencer: false,
      reject_regulated_provider: false,
      denied_issuer_controls: [],
      reject_identity_requirement: false,
      require_self_hostable_broadcast: false,
      allowed_data_egress_categories: [
        "none",
        "public-ledger",
        "peer-network",
        "sequencer-operator",
        "regulated-provider",
      ],
    } as const satisfies AssetTrustPolicy;
    const binding = {
      manifest_record_id: manifest.record_id,
      manifest_authority_key_id: manifest.authority.key_id,
      policy: localBasePolicy,
      policy_hash: assetTrustPolicyHash(localBasePolicy),
    };

    expect(
      verifyV2AssetTrustBinding(binding, manifest, {
        asset_id: ASSET,
        rail: "evm-base",
      }),
    ).toMatchObject({
      accepted: true,
      policy_hash: binding.policy_hash,
    });
    expect(() =>
      verifyV2AssetTrustBinding(
        { ...binding, policy_hash: sha256Id({ wrong: "policy" }) },
        manifest,
        { asset_id: ASSET, rail: "evm-base" },
      ),
    ).toThrow(/policy_hash/i);
  });

  test("rejects signed-field tampering through canonical identity", async () => {
    const { values } = await buildChain();
    const changed = structuredClone(values[2]) as Record<string, any>;
    changed.amount_atomic = "2500001";

    expect(() => verifyV2Record(changed)).toThrow(/record_id/i);
  });

  test("rejects unknown fields, including PII-shaped additions", async () => {
    const { values } = await buildChain();
    const topLevel = { ...values[0], name: "A merchant name" };
    const nested = {
      ...values[1],
      authority: {
        ...values[1].authority,
        email: "identity@example.test",
        company: "Global CashLoom Identity Inc",
      },
    };

    expect(() => verifyV2Record(topLevel)).toThrow(/closed schema/i);
    expect(() => verifyV2Record(nested)).toThrow(/closed schema/i);
  });

  test("requires transport-neutral relative discovery relations", () => {
    const base = {
      authority: merchant.authority,
      audience: "public" as const,
      disclosure: "public" as const,
      nonce: nonce(11),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-02T00:00:00.000Z",
      parent_record_id: null,
      roles: ["merchant"] as Array<"merchant">,
    };

    expect(() =>
      createNodeDescriptor({
        ...base,
        endpoints: [
          { rel: "record_read", path: "https://cashloom.io/v2/records/x" },
          { rel: "records_ingest", path: "/v2/records" },
        ],
      }),
    ).toThrow(/origin-relative path/i);
    expect(() =>
      createNodeDescriptor({
        ...base,
        endpoints: [{ rel: "record_read", path: "/v2/records/{record_id}" }],
      }),
    ).toThrow(/records_ingest/i);
  });

  test("rejects mismatched, malformed, and unusable self-certifying keys", async () => {
    expect(() =>
      createSelfCertifyingAuthority(`${merchant.authority.public_key}=`),
    ).toThrow(/canonical unpadded base64url/i);

    expect(() =>
      createNodeDescriptor({
        authority: {
          ...merchant.authority,
          key_id: payer.authority.key_id,
        },
        audience: "public",
        disclosure: "public",
        nonce: nonce(7),
        issued_at: "2030-01-01T00:00:00.000Z",
        expires_at: "2030-01-02T00:00:00.000Z",
        parent_record_id: null,
        roles: ["merchant"],
        endpoints: [
          { rel: "record_read", path: "/v2/records/{record_id}" },
          { rel: "records_ingest", path: "/v2/records" },
        ],
      }),
    ).toThrow(/self-certifying/i);

    const { values } = await buildChain();
    const zeroPublicKey = base64UrlEncode(new Uint8Array(32));
    const badKey = withRecomputedId({
      ...structuredClone(values[0]),
      authority: {
        algorithm: "Ed25519",
        public_key: zeroPublicKey,
        key_id: keyIdForPublicKey(zeroPublicKey),
      },
    });
    expect(() => verifyV2Record(badKey)).toThrow(/signature is invalid/i);
  });

  test("rejects a canonical but invalid signature", async () => {
    const { values } = await buildChain();
    const changed = structuredClone(values[0]) as Record<string, any>;
    const bytes = signatureFromBase64Url(changed.signature.value);
    bytes[63] ^= 1;
    changed.signature.value = signatureToBase64Url(bytes);

    expect(() => verifyV2Record(withRecomputedId(changed))).toThrow(
      /signature is invalid/i,
    );
  });

  test("rejects noncanonical JSON and base64url encodings", async () => {
    const { values } = await buildChain();
    const prettyJson = new TextEncoder().encode(JSON.stringify(values[0], null, 2));
    expect(() => verifyV2Record(prettyJson)).toThrow(/not canonical JSON/i);

    const canonicalText = new TextDecoder().decode(v2RecordBytes(values[0]));
    const duplicateKey = new TextEncoder().encode(
      canonicalText.replace(
        '"audience":"public"',
        '"audience":"public","audience":"public"',
      ),
    );
    expect(() => verifyV2Record(duplicateKey)).toThrow(/not canonical JSON/i);

    const padded = structuredClone(values[0]) as Record<string, any>;
    padded.signature.value = `${padded.signature.value}==`;
    expect(() => verifyV2Record(withRecomputedId(padded))).toThrow(
      /canonical unpadded base64url/i,
    );
  });

  test("rejects valid signatures over a wrong parent, audience, or replay nonce", async () => {
    const wrongParent = await buildChain({
      intentParent: sha256Id({ missing: "request" }),
    });
    expect(() => verifyV2RecordChain(wrongParent.values)).toThrow(/parent/i);

    const wrongAudience = await buildChain({
      intentAudience: payer.authority.key_id,
    });
    expect(() => verifyV2RecordChain(wrongAudience.values)).toThrow(/does not address/i);

    const duplicateNonce = await buildChain({ duplicateCommitmentNonce: true });
    expect(() => verifyV2RecordChain(duplicateNonce.values)).toThrow(/replay nonce/i);
  });

  test("enforces canonical expiry intervals and optional active-time verification", async () => {
    expect(() =>
      createPaymentRequest({
        authority: merchant.authority,
        audience: "public",
        disclosure: "public",
        nonce: nonce(8),
        issued_at: "2030-01-01T01:00:00.000Z",
        expires_at: "2030-01-01T01:00:00.000Z",
        parent_record_id: sha256Id({ descriptor: 1 }),
        rail: "evm-base",
        destination: MERCHANT_ACCOUNT,
        asset_id: ASSET,
        amount_atomic: "1",
        purpose_hash: sha256Id({ purpose: 1 }),
        asset_trust: trustBinding(merchant.authority.key_id, "expiry"),
      }),
    ).toThrow(/later than/i);

    const { values } = await buildChain();
    expect(() =>
      verifyV2Record(values[2], { now: "2030-01-01T00:10:00.000Z" }),
    ).toThrow(/not active/i);
    // Expiry does not erase historical cryptographic evidence.
    expect(verifyV2Record(values[2]).record_id).toBe(values[2].record_id);
  });

  test("refuses a submission receipt that claims a future submission", async () => {
    const { values } = await buildChain();
    const submission = unsigned(values[4]) as SubmissionReceiptCore;
    expect(() =>
      createSubmissionReceipt({
        ...submission,
        submitted_at: "2030-01-01T00:04:00.001Z",
      }),
    ).toThrow(/cannot be later than the receipt/i);
  });

  test("refuses an authority-mismatched signing helper", async () => {
    const core = createNodeDescriptor({
      authority: merchant.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(9),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-02T00:00:00.000Z",
      parent_record_id: null,
      roles: ["merchant"],
      endpoints: [
        { rel: "record_read", path: "/v2/records/{record_id}" },
        { rel: "records_ingest", path: "/v2/records" },
      ],
    });

    await expect(signV2Record(core, payer.signer)).rejects.toMatchObject({
      code: "AUTHORITY_MISMATCH",
    });
  });
});
