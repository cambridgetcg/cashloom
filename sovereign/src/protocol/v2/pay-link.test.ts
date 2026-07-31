import { describe, expect, test } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  canonicalJsonBytes,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
  type Sha256Id,
} from "@agenttool/wallet";

import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
  type AssetTrustManifest,
} from "./asset-trust.ts";
import {
  V2_PAY_LINK_BUNDLE_SCHEMA,
  V2_PAY_LINK_FILE_EXTENSION,
  V2_PAY_LINK_IDENTITY_ASSURANCE,
  V2_PAY_LINK_MAX_BYTES,
  V2_PAY_LINK_MAX_NESTING_DEPTH,
  V2_PAY_LINK_MEDIA_TYPE,
  V2_PAY_LINK_NOTE_MAX_BYTES,
  V2_PAY_LINK_NOTE_VISIBILITY,
  V2PayLinkError,
  createV2PayLinkBundle,
  createV2PayLinkPurpose,
  v2PayLinkBytes,
  v2PayLinkId,
  v2PayLinkProjection,
  v2PayLinkPurposeHash,
  verifyV2PayLinkBundle,
  type V2PayLinkBundle,
  type V2PayLinkPurpose,
} from "./pay-link.ts";
import {
  createAssetTrustManifestRecord,
  createNodeDescriptor,
  createPaymentRequest,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  type AssetTrustBinding,
  type AssetTrustManifestRecordCore,
  type NodeDescriptorCore,
  type PaymentRequestCore,
  type SelfCertifyingAuthority,
  type V2Audience,
  type V2Disclosure,
  type VerifiedV2Record,
} from "./records.ts";

interface TestAuthority {
  readonly authority: SelfCertifyingAuthority;
  readonly signer: RecordSigner;
}

const testAuthority = async (seedByte: number): Promise<TestAuthority> => {
  const privateKey = new Uint8Array(32).fill(seedByte);
  const publicKey = base64UrlEncode(await ed25519.getPublicKeyAsync(privateKey));
  return {
    authority: createSelfCertifyingAuthority(publicKey),
    signer: {
      public_key: publicKey,
      async sign_digest(digest) {
        return signatureToBase64Url(
          await ed25519.signAsync(digest, privateKey),
        );
      },
    },
  };
};

const merchant = await testAuthority(71);
const otherMerchant = await testAuthority(72);
const payer = await testAuthority(73);

const BTC_CHAIN = "bip122:000000000019d6689c085ae165831e93";
const BTC_ASSET = `${BTC_CHAIN}/slip44:0`;
const RAIL = "bitcoin-mainnet";
const DESTINATION =
  `${BTC_CHAIN}:bc1qcashloompublicplayground000000000000000000`;
const NOW = "2030-01-01T00:30:00.000Z";

const BTC_MANIFEST = {
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: RAIL,
  asset_id: BTC_ASSET,
  chain_id: BTC_CHAIN,
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: "2029-12-31T23:59:00.000Z",
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

const nonce = (byte: number): string =>
  v2Nonce(new Uint8Array(16).fill(byte));

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
      { rel: "record_read", path: "/v2/records/{record_id}" },
      { rel: "records_ingest", path: "/v2/records" },
    ],
  }),
  merchant.signer,
);

async function signedManifest(
  disclosure: V2Disclosure = "public",
  nonceByte = disclosure === "public" ? 2 : 3,
  selectedAudience: V2Audience = disclosure === "public"
    ? "public"
    : merchant.authority.key_id,
): Promise<VerifiedV2Record<AssetTrustManifestRecordCore>> {
  return signV2Record(
    createAssetTrustManifestRecord({
      authority: merchant.authority,
      audience: selectedAudience,
      disclosure,
      nonce: nonce(nonceByte),
      issued_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-15T00:00:00.000Z",
      parent_record_id: null,
      manifest: BTC_MANIFEST,
    }),
    merchant.signer,
  );
}

const manifest = await signedManifest();
const purpose = createV2PayLinkPurpose("Playground ticket #7");

const trustBinding = (
  record = manifest,
  overrides: Partial<AssetTrustBinding> = {},
): AssetTrustBinding => ({
  manifest_record_id: record.record_id,
  manifest_authority_key_id: record.authority.key_id,
  policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
  policy_hash: assetTrustPolicyHash(FAIL_CLOSED_ASSET_TRUST_POLICY),
  ...overrides,
});

interface SignedRequestOptions {
  readonly authority?: TestAuthority;
  readonly parent_record_id?: Sha256Id;
  readonly audience?: V2Audience;
  readonly disclosure?: V2Disclosure;
  readonly asset_trust?: AssetTrustBinding;
  readonly selectedPurpose?: V2PayLinkPurpose;
  readonly nonceByte?: number;
}

async function signedRequest(
  options: SignedRequestOptions = {},
): Promise<VerifiedV2Record<PaymentRequestCore>> {
  const authority = options.authority ?? merchant;
  return signV2Record(
    createPaymentRequest({
      authority: authority.authority,
      audience: options.audience ?? "public",
      disclosure: options.disclosure ?? "public",
      nonce: nonce(options.nonceByte ?? 4),
      issued_at: "2030-01-01T00:01:00.000Z",
      expires_at: "2030-01-01T01:00:00.000Z",
      parent_record_id: options.parent_record_id ?? descriptor.record_id,
      rail: RAIL,
      destination: DESTINATION,
      asset_id: BTC_ASSET,
      amount_atomic: "125000",
      purpose_hash: v2PayLinkPurposeHash(
        options.selectedPurpose ?? purpose,
      ),
      asset_trust: options.asset_trust ?? trustBinding(),
    }),
    authority.signer,
  );
}

const request = await signedRequest();

const rawBundle = (
  paymentRequest = request,
  assetManifest = manifest,
  nodeDescriptor = descriptor,
  selectedPurpose = purpose,
): V2PayLinkBundle => ({
  schema: V2_PAY_LINK_BUNDLE_SCHEMA,
  purpose: selectedPurpose,
  records: {
    node_descriptor: nodeDescriptor,
    asset_trust_manifest: assetManifest,
    payment_request: paymentRequest,
  },
});

const clone = <T>(value: T): T => structuredClone(value);

describe("portable public CashLoom pay links", () => {
  test("round-trips exact canonical bytes with stable IDs and an identity-honest projection", () => {
    const created = createV2PayLinkBundle(
      { purpose, records: rawBundle().records },
      { now: NOW },
    );
    const bytes = v2PayLinkBytes(created.bundle);
    const verified = verifyV2PayLinkBundle(bytes, { now: NOW });
    const projection = v2PayLinkProjection(verified);

    expect(bytes).toEqual(canonicalJsonBytes(created.bundle));
    expect(bytes.byteLength).toBeLessThanOrEqual(V2_PAY_LINK_MAX_BYTES);
    expect(verified.bundle_id).toBe(created.bundle_id);
    expect(v2PayLinkId(verified.bundle)).toBe(verified.bundle_id);
    expect(verified.purpose_hash).toBe(request.purpose_hash);
    expect(verified.usable_until).toBe(request.expires_at);
    expect(verified.merchant_key_status).toBe("first-contact");
    expect(verified.asset_trust.accepted).toBe(true);

    expect(projection).toMatchObject({
      bundle_id: verified.bundle_id,
      request_record_id: request.record_id,
      merchant_key_id: merchant.authority.key_id,
      merchant_key_status: "first-contact",
      identity_assurance: V2_PAY_LINK_IDENTITY_ASSURANCE,
      note: "Playground ticket #7",
      note_visibility: V2_PAY_LINK_NOTE_VISIBILITY,
      rail: RAIL,
      destination: DESTINATION,
      asset_id: BTC_ASSET,
      amount_atomic: "125000",
      usable_until: request.expires_at,
    });
    expect(V2_PAY_LINK_MEDIA_TYPE).toBe(
      "application/cashloom-pay-link+json",
    );
    expect(V2_PAY_LINK_FILE_EXTENSION).toBe(".cashloom-pay");
  });

  test("labels a caller-selected matching key pin without claiming identity", () => {
    const verified = verifyV2PayLinkBundle(rawBundle(), {
      now: NOW,
      expectedMerchantKeyId: merchant.authority.key_id,
    });
    const projection = v2PayLinkProjection(verified);

    expect(verified.merchant_key_status).toBe("matched-pin");
    expect(projection.merchant_key_status).toBe("matched-pin");
    expect(projection.identity_assurance).toBe(
      "self-certifying-key-only",
    );
    expect(Object.keys(projection)).not.toContain("merchant_identity");
    expect(Object.keys(projection)).not.toContain("verified_merchant");
  });

  test("binds the exact public purpose preimage", () => {
    const changed = clone(rawBundle()) as {
      purpose: { note: string | null };
    } & V2PayLinkBundle;
    changed.purpose.note = "Attacker changed the public note";

    expect(() =>
      verifyV2PayLinkBundle(changed, { now: NOW }),
    ).toThrow(/purpose preimage does not match/);
  });

  test("deduplicates records before rejecting same-authority nonce reuse", async () => {
    const duplicate = clone(rawBundle()) as unknown as {
      records: Record<string, unknown>;
    };
    duplicate.records.asset_trust_manifest =
      duplicate.records.node_descriptor;
    expect(() =>
      verifyV2PayLinkBundle(duplicate, { now: NOW }),
    ).toThrow(/three distinct signed records/);

    const descriptorManifestCollision = await signedManifest("public", 1);
    const requestForCollision = await signedRequest({
      asset_trust: trustBinding(descriptorManifestCollision),
      nonceByte: 10,
    });
    expect(() =>
      verifyV2PayLinkBundle(
        rawBundle(requestForCollision, descriptorManifestCollision),
        { now: NOW },
      ),
    ).toThrow(/reused a replay nonce/);

    const descriptorRequestCollision = await signedRequest({ nonceByte: 1 });
    expect(() =>
      verifyV2PayLinkBundle(
        rawBundle(descriptorRequestCollision),
        { now: NOW },
      ),
    ).toThrow(/reused a replay nonce/);

    const manifestRequestCollision = await signedRequest({ nonceByte: 2 });
    expect(() =>
      verifyV2PayLinkBundle(
        rawBundle(manifestRequestCollision),
        { now: NOW },
      ),
    ).toThrow(/reused a replay nonce/);
  });

  test("rejects swapped schemas and valid records from the wrong authority or parent", async () => {
    const swapped = clone(rawBundle()) as unknown as {
      records: Record<string, unknown>;
    };
    const originalDescriptor = swapped.records.node_descriptor;
    swapped.records.node_descriptor =
      swapped.records.asset_trust_manifest;
    swapped.records.asset_trust_manifest = originalDescriptor;

    expect(() =>
      verifyV2PayLinkBundle(swapped, { now: NOW }),
    ).toThrow(V2PayLinkError);

    const wrongAuthority = await signedRequest({
      authority: otherMerchant,
      nonceByte: 5,
    });
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(wrongAuthority), { now: NOW }),
    ).toThrow(/authority does not match/);

    const wrongParent = await signedRequest({
      parent_record_id: sha256Id({ parent: "elsewhere" }),
      nonceByte: 6,
    });
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(wrongParent), { now: NOW }),
    ).toThrow(/does not name the supplied parent/);
  });

  test("rejects a signed request whose bound trust record is not the bundled manifest", async () => {
    const wrongTrust = await signedRequest({
      asset_trust: trustBinding(manifest, {
        manifest_record_id: sha256Id({ manifest: "substituted" }),
      }),
      nonceByte: 7,
    });

    expect(() =>
      verifyV2PayLinkBundle(rawBundle(wrongTrust), { now: NOW }),
    ).toThrow(/does not match the bound content ID/);
  });

  test("refuses private components and targeted requests in the public profile", async () => {
    const privateRequest = await signedRequest({
      disclosure: "private",
      nonceByte: 8,
    });
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(privateRequest), { now: NOW }),
    ).toThrow(/public pay-link requires/);

    const targetedRequest = await signedRequest({
      audience: payer.authority.key_id,
      nonceByte: 9,
    });
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(targetedRequest), { now: NOW }),
    ).toThrow(/public pay-link requires/);

    const privateManifest = await signedManifest("private");
    expect(() =>
      verifyV2PayLinkBundle(
        rawBundle(request, privateManifest),
        { now: NOW },
      ),
    ).toThrow(/public pay-link requires/);

    const targetedPublicManifest = await signedManifest(
      "public",
      10,
      payer.authority.key_id,
    );
    expect(() =>
      verifyV2PayLinkBundle(
        rawBundle(request, targetedPublicManifest),
        { now: NOW },
      ),
    ).toThrow(/public pay-link requires/);

    expect(() =>
      createNodeDescriptor({
        authority: merchant.authority,
        audience: payer.authority.key_id,
        disclosure: "public",
        nonce: nonce(11),
        issued_at: "2030-01-01T00:00:00.000Z",
        expires_at: "2030-01-08T00:00:00.000Z",
        parent_record_id: null,
        roles: ["merchant"],
        endpoints: [
          { rel: "record_read", path: "/v2/records/{record_id}" },
          { rel: "records_ingest", path: "/v2/records" },
        ],
      }),
    ).toThrow(/audience must be public/i);
  });

  test("requires every component to be active at the verification clock", () => {
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(), {
        now: request.expires_at,
      }),
    ).toThrow(/not active/);
  });

  test("fails closed when the optional merchant key pin differs", () => {
    expect(() =>
      verifyV2PayLinkBundle(rawBundle(), {
        now: NOW,
        expectedMerchantKeyId: otherMerchant.authority.key_id,
      }),
    ).toThrow(/does not match the caller-selected key pin/);

    expect(() =>
      verifyV2PayLinkBundle(rawBundle(), {
        now: NOW,
        expectedMerchantKeyId: "not-a-key-id",
      }),
    ).toThrow(/not a valid SHA-256 key id/);
  });

  test("bounds the public note by UTF-8 bytes", () => {
    expect(
      new TextEncoder().encode(createV2PayLinkPurpose("é".repeat(80)).note!)
        .byteLength,
    ).toBe(V2_PAY_LINK_NOTE_MAX_BYTES);
    expect(() =>
      createV2PayLinkPurpose("é".repeat(81)),
    ).toThrow(/at most 160 well-formed public UTF-8 bytes/);
  });

  test("rejects oversized, noncanonical, duplicate-key, and unknown-field inputs", () => {
    expect(() =>
      verifyV2PayLinkBundle(
        new Uint8Array(V2_PAY_LINK_MAX_BYTES + 1),
        { now: NOW },
      ),
    ).toThrow(/must not exceed 65536 canonical bytes/);

    const canonical = v2PayLinkBytes(
      createV2PayLinkBundle(
        { purpose, records: rawBundle().records },
        { now: NOW },
      ).bundle,
    );
    const noncanonical = new Uint8Array(canonical.byteLength + 1);
    noncanonical[0] = 0x20;
    noncanonical.set(canonical, 1);
    expect(() =>
      verifyV2PayLinkBundle(noncanonical, { now: NOW }),
    ).toThrow();

    const trailing = new Uint8Array(canonical.byteLength + 1);
    trailing.set(canonical);
    trailing[canonical.byteLength] = 0x0a;
    expect(() =>
      verifyV2PayLinkBundle(trailing, { now: NOW }),
    ).toThrow();

    expect(() =>
      verifyV2PayLinkBundle(
        new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
        { now: NOW },
      ),
    ).toThrow(/valid UTF-8/);

    const excessiveNesting = new TextEncoder().encode(
      `${"[".repeat(V2_PAY_LINK_MAX_NESTING_DEPTH + 1)}0${
        "]".repeat(V2_PAY_LINK_MAX_NESTING_DEPTH + 1)
      }`,
    );
    expect(() =>
      verifyV2PayLinkBundle(excessiveNesting, { now: NOW }),
    ).toThrow(/nesting must not exceed/);

    const canonicalText = new TextDecoder().decode(canonical);
    const duplicateSchema = new TextEncoder().encode(
      `{"schema":"${V2_PAY_LINK_BUNDLE_SCHEMA}",${canonicalText.slice(1)}`,
    );
    expect(() =>
      verifyV2PayLinkBundle(duplicateSchema, { now: NOW }),
    ).toThrow();

    const unknown = clone(rawBundle()) as unknown as Record<string, unknown>;
    unknown.identity = "not-a-pay-link-field";
    expect(() =>
      verifyV2PayLinkBundle(unknown, { now: NOW }),
    ).toThrow(/closed schema/);
  });

  test("performs no fetch while creating, verifying, or projecting", () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      throw new Error("pay-link carrier must not fetch");
    }) as unknown as typeof fetch;

    try {
      const created = createV2PayLinkBundle(
        { purpose, records: rawBundle().records },
        { now: NOW },
      );
      const verified = verifyV2PayLinkBundle(
        v2PayLinkBytes(created.bundle),
        { now: NOW },
      );
      v2PayLinkProjection(verified);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
