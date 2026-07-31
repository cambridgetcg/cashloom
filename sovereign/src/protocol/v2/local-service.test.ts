import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  type AssetTrustManifest,
} from "./asset-trust.ts";
import {
  createV2LocalService,
  V2LocalServiceError,
} from "./local-service.ts";
import type {
  V2NodeAuthority,
  V2NodeAuthorityProvider,
  V2NodeSigningContext,
} from "./node-authority.ts";
import { createV2RecordStore } from "./record-store.ts";
import {
  createSelfCertifyingAuthority,
  v2RecordBytes,
} from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";

const BTC_CHAIN = "bip122:000000000019d6689c085ae165831e93";
const BTC_ASSET = `${BTC_CHAIN}/slip44:0`;
const NOW = "2030-01-01T00:00:00.000Z";

const btcManifest = (): AssetTrustManifest => ({
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "bitcoin-mainnet",
  asset_id: BTC_ASSET,
  chain_id: BTC_CHAIN,
  provenance: {
    kind: "unsigned-local-assertion",
    assessed_at: NOW,
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
});

const baseManifest = (): AssetTrustManifest => ({
  ...btcManifest(),
  rail: "evm-base",
  asset_id: "eip155:8453/slip44:60",
  chain_id: "eip155:8453",
  settlement: {
    model: "optimistic-rollup",
    finality: "economic",
    single_sequencer: true,
  },
  bridge_dependency: "canonical",
  infrastructure: {
    self_hostable_read: true,
    self_hostable_broadcast: false,
  },
  data_egress: { categories: ["public-ledger", "sequencer-operator"] },
});

async function fakeAuthorityProvider(
  seedByte: number,
): Promise<V2NodeAuthorityProvider> {
  const seed = new Uint8Array(32).fill(seedByte);
  const publicKey = base64UrlEncode(await ed25519.getPublicKeyAsync(seed));
  const authority = createSelfCertifyingAuthority(publicKey);
  const signer: RecordSigner = {
    public_key: publicKey,
    async sign_digest(digest) {
      return signatureToBase64Url(await ed25519.signAsync(digest, seed));
    },
  };
  const node: V2NodeAuthority = Object.freeze({
    vaultKeyId: `test-vault-${seedByte}`,
    authority,
  });
  const context: V2NodeSigningContext = Object.freeze({ ...node, signer });
  return Object.freeze({
    async ensure() {
      return node;
    },
    async signingContext() {
      return context;
    },
  });
}

function testStore(localNodeKeyId: string) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  installCashLoomV2Schema(db);
  return {
    db,
    store: createV2RecordStore({
      db,
      localNodeKeyId,
      remoteLimits: {
        maxRecordCount: 100,
        maxCanonicalBytes: 2 * 1024 * 1024,
      },
      now: () => NOW,
    }),
  };
}

function deterministicEntropy() {
  let next = 1;
  return (length: number): Uint8Array => {
    const result = new Uint8Array(length).fill(next);
    next += 1;
    return result;
  };
}

describe("closed local CashLoom v2 workflows", () => {
  test("builds a two-node request/intent exchange with independent keys and no domain", async () => {
    const merchantAuthority = await fakeAuthorityProvider(41);
    const payerAuthority = await fakeAuthorityProvider(42);
    const merchantNode = await merchantAuthority.ensure();
    const payerNode = await payerAuthority.ensure();
    const merchantDb = testStore(merchantNode.authority.key_id);
    const payerDb = testStore(payerNode.authority.key_id);
    const merchant = createV2LocalService({
      store: merchantDb.store,
      authorityProvider: merchantAuthority,
      now: () => NOW,
      randomBytes: deterministicEntropy(),
    });
    const payer = createV2LocalService({
      store: payerDb.store,
      authorityProvider: payerAuthority,
      now: () => NOW,
      randomBytes: deterministicEntropy(),
    });

    const merchantDescriptor = await merchant.activateNode({
      roles: ["merchant"],
    });
    const payerDescriptor = await payer.activateNode({ roles: ["payer"] });
    expect(merchantDescriptor.authority.key_id).not.toBe(
      payerDescriptor.authority.key_id,
    );

    const merchantTrust = await merchant.createAssetTrustManifest({
      manifest: btcManifest(),
      audience: "public",
      disclosure: "public",
    });
    const payerTrust = await payer.createAssetTrustManifest({
      manifest: btcManifest(),
      audience: payerNode.authority.key_id,
      disclosure: "private",
    });
    const request = await merchant.createPaymentRequest({
      rail: "bitcoin-mainnet",
      destination: "bc1qmerchantcoordinate",
      asset_id: BTC_ASSET,
      amount_atomic: "25000",
      purpose_hash: sha256Id({ order: "playground-1" }),
      asset_trust: {
        record_id: merchantTrust.record_id,
        trusted_authority_key_id: merchantNode.authority.key_id,
      },
    });
    expect(request.asset_trust.accepted).toBe(true);
    expect(request.record.asset_trust).toEqual({
      manifest_record_id: merchantTrust.record_id,
      manifest_authority_key_id: merchantNode.authority.key_id,
      policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
      policy_hash: request.asset_trust.policy_hash,
    });

    // Direct byte handoff: neither node knows or contacts cashloom.io.
    payerDb.store.append(v2RecordBytes(merchantDescriptor), "remote");
    payerDb.store.append(v2RecordBytes(request.record), "remote");
    const intent = await payer.createPaymentIntent({
      request_record_id: request.record.record_id,
      source_account: "bitcoin:bc1qpayercoordinate",
      fee_asset_id: BTC_ASSET,
      max_fee_atomic: "500",
      payment_asset_trust: {
        record_id: payerTrust.record_id,
        trusted_authority_key_id: payerNode.authority.key_id,
      },
      fee_asset_trust: {
        record_id: payerTrust.record_id,
        trusted_authority_key_id: payerNode.authority.key_id,
      },
    });
    expect(intent.record.audience).toBe(merchantNode.authority.key_id);
    expect(intent.record.disclosure).toBe("private");
    expect(intent.record.asset_id).toBe(BTC_ASSET);
    expect(intent.record.fee_asset_id).toBe(BTC_ASSET);
    expect(intent.record.rail).toBe("bitcoin-mainnet");
    expect(intent.record.destination).toBe("bc1qmerchantcoordinate");
    expect(intent.record.payment_asset_trust).toEqual({
      manifest_record_id: payerTrust.record_id,
      manifest_authority_key_id: payerNode.authority.key_id,
      policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
      policy_hash: intent.payment_asset_trust.policy_hash,
    });

    const admitted = merchantDb.store.append(
      v2RecordBytes(intent.record),
      "remote",
    );
    expect(admitted.inserted).toBe(true);
    expect(
      merchantDb.store.getLocal(intent.record.record_id)?.record_id,
    ).toBe(intent.record.record_id);
    expect(
      merchantDb.store.getPublic(intent.record.record_id),
    ).toBeNull();

    merchantDb.db.close();
    payerDb.db.close();
  });

  test("requires an explicit manifest-authority pin and fails closed on central dependencies", async () => {
    const provider = await fakeAuthorityProvider(43);
    const node = await provider.ensure();
    const database = testStore(node.authority.key_id);
    const service = createV2LocalService({
      store: database.store,
      authorityProvider: provider,
      now: () => NOW,
      randomBytes: deterministicEntropy(),
    });
    await service.activateNode();

    const btc = await service.createAssetTrustManifest({
      manifest: btcManifest(),
    });
    expect(() =>
      service.evaluateAssetTrust(
        {
          record_id: btc.record_id,
          trusted_authority_key_id: `sha256:${"0".repeat(64)}`,
        },
        BTC_ASSET,
        "bitcoin-mainnet",
      ),
    ).toThrow(V2LocalServiceError);
    await expect(
      service.createPaymentRequest({
        rail: "bitcoin-mainnet",
        destination: "bc1qprivateassessment",
        asset_id: BTC_ASSET,
        amount_atomic: "1",
        purpose_hash: sha256Id({ test: "private-public-binding" }),
        asset_trust: {
          record_id: btc.record_id,
          trusted_authority_key_id: node.authority.key_id,
        },
      }),
    ).rejects.toMatchObject({
      code: "ASSET_TRUST_DISCLOSURE_MISMATCH",
    });
    await expect(
      service.createPaymentRequest({
        rail: "stripe-connect",
        destination: "provider:merchant",
        asset_id: BTC_ASSET,
        amount_atomic: "1",
        purpose_hash: sha256Id({ test: "rail-context-mismatch" }),
        asset_trust: {
          record_id: btc.record_id,
          trusted_authority_key_id: node.authority.key_id,
        },
      }),
    ).rejects.toMatchObject({ code: "ASSET_TRUST_RAIL_MISMATCH" });

    const base = await service.createAssetTrustManifest({
      manifest: baseManifest(),
    });
    try {
      service.evaluateAssetTrust(
        {
          record_id: base.record_id,
          trusted_authority_key_id: node.authority.key_id,
          policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
        },
        base.manifest.asset_id,
        "evm-base",
      );
      throw new Error("expected fail-closed policy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(V2LocalServiceError);
      expect((error as V2LocalServiceError).code).toBe(
        "ASSET_POLICY_REJECTED",
      );
      expect(
        (error as V2LocalServiceError).decision?.findings.map(
          ({ code }) => code,
        ),
      ).toEqual([
        "settlement-model",
        "single-sequencer",
        "non-self-hostable-broadcast",
        "bridge-dependency",
        "data-egress",
      ]);
    }
    database.db.close();
  });

  test("reuses an active descriptor and exposes no generic sign method", async () => {
    const provider = await fakeAuthorityProvider(44);
    const node = await provider.ensure();
    const database = testStore(node.authority.key_id);
    const service = createV2LocalService({
      store: database.store,
      authorityProvider: provider,
      now: () => NOW,
      randomBytes: deterministicEntropy(),
    });
    const first = await service.activateNode();
    const second = await service.activateNode();
    expect(second.record_id).toBe(first.record_id);
    expect(
      (service as unknown as Record<string, unknown>).sign,
    ).toBeUndefined();
    expect(
      (service as unknown as Record<string, unknown>).signRecord,
    ).toBeUndefined();
    database.db.close();
  });
});
