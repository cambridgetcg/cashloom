import { describe, expect, test } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  canonicalJsonBytes,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";

import {
  ASSET_TRUST_POLICY_SCHEMA,
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
  evaluateAssetTrust,
  type AssetTrustManifest,
  type AssetTrustPolicy,
} from "./asset-trust.ts";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  bitcoinMainnetTrustManifest,
} from "./bitcoin-profile.ts";
import {
  V2_PAY_LINK_ACCEPTANCE_SCHEMA,
  V2PayLinkAcceptanceError,
  v2PayLinkAcceptanceProjection,
  verifyV2PayLinkAcceptance,
  type V2PayLinkAcceptanceBundle,
  type V2PayLinkAcceptanceErrorCode,
} from "./pay-link-acceptance.ts";
import {
  V2_PAY_LINK_BUNDLE_SCHEMA,
  createV2PayLinkPurpose,
  v2PayLinkPurposeHash,
} from "./pay-link.ts";
import {
  createAssetTrustManifestRecord,
  createNodeDescriptor,
  createPaymentIntent,
  createPaymentRequest,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  verifyV2Record,
  type AssetTrustBinding,
  type AssetTrustManifestRecordCore,
  type SelfCertifyingAuthority,
  type VerifiedV2Record,
} from "./records.ts";

interface TestAuthority {
  readonly authority: SelfCertifyingAuthority;
  readonly signer: RecordSigner;
}

interface AcceptanceFixtureOptions {
  readonly merchant?: TestAuthority;
  readonly payer?: TestAuthority;
  readonly rail?: string;
  readonly destination?: string;
  readonly amountSats?: string;
  readonly sourceAccount?: string;
  readonly maxFeeSats?: string;
  readonly offerManifest?: AssetTrustManifest;
  readonly offerPolicy?: AssetTrustPolicy;
  readonly payerManifest?: AssetTrustManifest;
  readonly payerPolicy?: AssetTrustPolicy;
  readonly intentIssuedAt?: string;
  readonly intentExpiresAt?: string;
  readonly descriptorNonceByte?: number;
  readonly offerManifestNonceByte?: number;
  readonly requestNonceByte?: number;
  readonly payerManifestNonceByte?: number;
  readonly intentNonceByte?: number;
}

const DESCRIPTOR_ISSUED_AT = "2030-01-01T00:00:00.000Z";
const REQUEST_ISSUED_AT = "2030-01-01T00:01:00.000Z";
const PAYER_MANIFEST_ISSUED_AT = "2030-01-01T00:20:00.000Z";
const INTENT_ISSUED_AT = "2030-01-01T00:30:00.000Z";
const INTENT_EXPIRES_AT = "2030-01-01T00:35:00.000Z";
const FUTURE_CHECK = "2030-01-01T00:29:59.999Z";
const EXPIRED_CHECK = "2030-01-01T02:00:00.000Z";
const ROOT_EXPIRES_AT = "2030-01-08T00:00:00.000Z";
const REQUEST_EXPIRES_AT = "2030-01-01T01:00:00.000Z";
const MERCHANT_ADDRESS =
  "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty";
const PAYER_ADDRESS =
  "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5";

async function testAuthority(seedByte: number): Promise<TestAuthority> {
  const privateKey = new Uint8Array(32).fill(seedByte);
  const publicKey = base64UrlEncode(
    await ed25519.getPublicKeyAsync(privateKey),
  );
  return Object.freeze({
    authority: createSelfCertifyingAuthority(publicKey),
    signer: {
      public_key: publicKey,
      async sign_digest(digest: Uint8Array) {
        return signatureToBase64Url(
          await ed25519.signAsync(digest, privateKey),
        );
      },
    },
  });
}

const merchant = await testAuthority(91);
const payer = await testAuthority(92);

const nonce = (byte: number): string =>
  v2Nonce(new Uint8Array(16).fill(byte));

function bitcoinManifest(rail: string): AssetTrustManifest {
  return {
    ...structuredClone(
      bitcoinMainnetTrustManifest("2029-12-31T23:59:00.000Z"),
    ),
    rail,
  };
}

function centralizedManifest(rail: string): AssetTrustManifest {
  return {
    ...bitcoinManifest(rail),
    settlement: {
      model: "regulated-ledger",
      finality: "provider-attested",
      single_sequencer: true,
    },
    regulated_provider: {
      required: true,
      role: "settlement",
    },
    issuer_controls: {
      mint: true,
      freeze: true,
      denylist: true,
      pause: true,
      upgrade: true,
    },
    bridge_dependency: "third-party",
    identity_requirement: "transaction",
    custody: "provider-custody-required",
    infrastructure: {
      self_hostable_read: false,
      self_hostable_broadcast: false,
    },
    data_egress: {
      categories: ["regulated-provider"],
    },
  };
}

const PERMISSIVE_CENTRALIZED_POLICY: AssetTrustPolicy = {
  schema: ASSET_TRUST_POLICY_SCHEMA,
  policy_id: "cashloom-test/permissive-centralized",
  allowed_settlement_models: ["regulated-ledger"],
  allowed_finality_models: ["provider-attested"],
  reject_single_sequencer: false,
  reject_regulated_provider: false,
  denied_issuer_controls: [],
  reject_identity_requirement: false,
  require_self_hostable_read: false,
  require_self_hostable_broadcast: false,
  reject_unknowns: false,
  allowed_bridge_dependencies: ["third-party"],
  allowed_custody_models: ["provider-custody-required"],
  allowed_data_egress_categories: ["regulated-provider"],
};

function binding(
  manifest: VerifiedV2Record<AssetTrustManifestRecordCore>,
  policy: AssetTrustPolicy,
): AssetTrustBinding {
  return {
    manifest_record_id: manifest.record_id,
    manifest_authority_key_id: manifest.authority.key_id,
    policy,
    policy_hash: assetTrustPolicyHash(policy),
  };
}

async function acceptanceFixture(
  options: AcceptanceFixtureOptions = {},
): Promise<{
  readonly bundle: V2PayLinkAcceptanceBundle;
  readonly merchantKeyId: string;
  readonly intent: ReturnType<typeof verifyV2Record>;
}> {
  const merchantAuthority = options.merchant ?? merchant;
  const payerAuthority = options.payer ?? payer;
  const rail = options.rail ?? BITCOIN_MAINNET_RAIL;
  const purpose = createV2PayLinkPurpose("acceptance audit");
  const descriptor = await signV2Record(
    createNodeDescriptor({
      authority: merchantAuthority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(options.descriptorNonceByte ?? 1),
      issued_at: DESCRIPTOR_ISSUED_AT,
      expires_at: ROOT_EXPIRES_AT,
      parent_record_id: null,
      roles: ["merchant"],
      endpoints: [
        { rel: "record_read", path: "/v2/records/{record_id}" },
        { rel: "records_ingest", path: "/v2/records" },
      ],
    }),
    merchantAuthority.signer,
  );
  const offerManifest = await signV2Record(
    createAssetTrustManifestRecord({
      authority: merchantAuthority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(options.offerManifestNonceByte ?? 2),
      issued_at: DESCRIPTOR_ISSUED_AT,
      expires_at: ROOT_EXPIRES_AT,
      parent_record_id: null,
      manifest: options.offerManifest ?? bitcoinManifest(rail),
    }),
    merchantAuthority.signer,
  );
  const request = await signV2Record(
    createPaymentRequest({
      authority: merchantAuthority.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(options.requestNonceByte ?? 3),
      issued_at: REQUEST_ISSUED_AT,
      expires_at: REQUEST_EXPIRES_AT,
      parent_record_id: descriptor.record_id,
      rail,
      destination: options.destination ?? MERCHANT_ADDRESS,
      asset_id: BITCOIN_MAINNET_ASSET_ID,
      amount_atomic: options.amountSats ?? "25000",
      purpose_hash: v2PayLinkPurposeHash(purpose),
      asset_trust: binding(
        offerManifest,
        options.offerPolicy ?? FAIL_CLOSED_ASSET_TRUST_POLICY,
      ),
    }),
    merchantAuthority.signer,
  );
  const privateManifest = await signV2Record(
    createAssetTrustManifestRecord({
      authority: payerAuthority.authority,
      audience: merchantAuthority.authority.key_id,
      disclosure: "private",
      nonce: nonce(options.payerManifestNonceByte ?? 4),
      issued_at: PAYER_MANIFEST_ISSUED_AT,
      expires_at: ROOT_EXPIRES_AT,
      parent_record_id: null,
      manifest: options.payerManifest ?? bitcoinManifest(rail),
    }),
    payerAuthority.signer,
  );
  const intent = await signV2Record(
    createPaymentIntent({
      authority: payerAuthority.authority,
      audience: merchantAuthority.authority.key_id,
      disclosure: "private",
      nonce: nonce(options.intentNonceByte ?? 5),
      issued_at: options.intentIssuedAt ?? INTENT_ISSUED_AT,
      expires_at: options.intentExpiresAt ?? INTENT_EXPIRES_AT,
      parent_record_id: request.record_id,
      rail,
      destination: request.destination,
      source_account: options.sourceAccount ?? PAYER_ADDRESS,
      asset_id: request.asset_id,
      amount_atomic: request.amount_atomic,
      fee_asset_id: BITCOIN_MAINNET_ASSET_ID,
      fee_limit_scope: "total_fee_asset_exposure",
      max_fee_atomic: options.maxFeeSats ?? "1000",
      payment_asset_trust: binding(
        privateManifest,
        options.payerPolicy ?? FAIL_CLOSED_ASSET_TRUST_POLICY,
      ),
      fee_asset_trust: binding(
        privateManifest,
        options.payerPolicy ?? FAIL_CLOSED_ASSET_TRUST_POLICY,
      ),
    }),
    payerAuthority.signer,
  );

  return Object.freeze({
    merchantKeyId: merchantAuthority.authority.key_id,
    intent,
    bundle: {
      schema: V2_PAY_LINK_ACCEPTANCE_SCHEMA,
      pay_link: {
        schema: V2_PAY_LINK_BUNDLE_SCHEMA,
        purpose,
        records: {
          node_descriptor: descriptor,
          asset_trust_manifest: offerManifest,
          payment_request: request,
        },
      },
      records: {
        asset_trust_manifest: privateManifest,
        payment_intent: intent,
      },
    },
  });
}

function verifyFixture(
  fixture: Awaited<ReturnType<typeof acceptanceFixture>>,
  now = INTENT_ISSUED_AT,
) {
  return verifyV2PayLinkAcceptance(canonicalJsonBytes(fixture.bundle), {
    expectedMerchantKeyId: fixture.merchantKeyId,
    now,
  });
}

function expectAcceptanceError(
  fixture: Awaited<ReturnType<typeof acceptanceFixture>>,
  code: V2PayLinkAcceptanceErrorCode,
  now = INTENT_ISSUED_AT,
): V2PayLinkAcceptanceError {
  let thrown: unknown;
  try {
    verifyFixture(fixture, now);
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof V2PayLinkAcceptanceError)) {
    throw thrown ?? new Error(`Expected acceptance error ${code}.`);
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

describe("portable Pay Link acceptance regression boundaries", () => {
  test("rejects malformed and non-mainnet payer sources", async () => {
    for (const sourceAccount of [
      "not-a-bitcoin-address",
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    ]) {
      const fixture = await acceptanceFixture({ sourceAccount });
      expectAcceptanceError(fixture, "WRONG_BITCOIN_PROFILE");
    }
  });

  test("rejects wrong rail, destination, and amount profiles", async () => {
    const cases: readonly AcceptanceFixtureOptions[] = [
      { rail: "bitcoin-sidechain" },
      { destination: "not-a-bitcoin-destination" },
      { amountSats: "293" },
    ];
    for (const selected of cases) {
      expectAcceptanceError(
        await acceptanceFixture(selected),
        "WRONG_BITCOIN_PROFILE",
      );
    }
  });

  test("rejects a fee ceiling above 100,000,000 satoshis", async () => {
    const fixture = await acceptanceFixture({
      maxFeeSats: "100000001",
    });
    expectAcceptanceError(fixture, "WRONG_BITCOIN_PROFILE");
  });

  test("replays the built-in fail-closed policy over both asset manifests", async () => {
    const centralized = centralizedManifest(BITCOIN_MAINNET_RAIL);
    expect(
      evaluateAssetTrust(centralized, PERMISSIVE_CENTRALIZED_POLICY).accepted,
    ).toBe(true);
    expect(
      evaluateAssetTrust(centralized, FAIL_CLOSED_ASSET_TRUST_POLICY).accepted,
    ).toBe(false);

    const centralizedOffer = await acceptanceFixture({
      offerManifest: centralized,
      offerPolicy: PERMISSIVE_CENTRALIZED_POLICY,
    });
    expectAcceptanceError(centralizedOffer, "WRONG_BITCOIN_PROFILE");

    const centralizedPayer = await acceptanceFixture({
      payerManifest: centralized,
      payerPolicy: PERMISSIVE_CENTRALIZED_POLICY,
    });
    expectAcceptanceError(centralizedPayer, "WRONG_BITCOIN_PROFILE");
  });

  test("rejects a future-dated intent", async () => {
    const fixture = await acceptanceFixture();
    expectAcceptanceError(fixture, "INVALID_ACCEPTANCE", FUTURE_CHECK);
  });

  test("retains expired intent as historical evidence without calling it active", async () => {
    const fixture = await acceptanceFixture();
    expect(() =>
      verifyV2Record(fixture.intent, { now: EXPIRED_CHECK }),
    ).toThrow(/not active/i);

    const verified = verifyFixture(fixture, EXPIRED_CHECK);
    expect(verified.intent_active_at_verification).toBe(false);
    expect(v2PayLinkAcceptanceProjection(verified)).toMatchObject({
      intent_active_at_verification: false,
      intent_expires_at: INTENT_EXPIRES_AT,
      no_money_moved: true,
    });
  });

  test("rejects a same-authority nonce reused across offer and acceptance", async () => {
    const fixture = await acceptanceFixture({
      payer: merchant,
      descriptorNonceByte: 1,
      payerManifestNonceByte: 1,
    });
    expectAcceptanceError(fixture, "ISSUER_NONCE_REUSE");
  });
});
