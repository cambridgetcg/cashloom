import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import {
  ASSET_TRUST_MANIFEST_SCHEMA,
  type AssetTrustManifest,
} from "./asset-trust.ts";
import { createV2LocalService } from "./local-service.ts";
import type {
  V2NodeAuthority,
  V2NodeAuthorityProvider,
  V2NodeSigningContext,
} from "./node-authority.ts";
import { createV2RecordStore } from "./record-store.ts";
import {
  mountV2LocalRoutes,
  mountV2PublicRoutes,
} from "./router.ts";
import {
  V2_MAX_RECORD_BYTES,
  createSelfCertifyingAuthority,
  v2RecordBytes,
} from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";
import {
  V2_RECORD_MEDIA_TYPE,
  getPublicV2Record,
  postV2Record,
  type DirectNodeTarget,
  type FetchLike,
} from "./transport.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const BTC_CHAIN = "bip122:000000000019d6689c085ae165831e93";
const BTC_ASSET = `${BTC_CHAIN}/slip44:0`;

const manifest = (): AssetTrustManifest => ({
  schema: ASSET_TRUST_MANIFEST_SCHEMA,
  rail: "bitcoin-mainnet",
  asset_id: BTC_ASSET,
  chain_id: BTC_CHAIN,
  provenance: { kind: "unsigned-local-assertion", assessed_at: NOW },
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

async function authorityProvider(
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
  const node: V2NodeAuthority = {
    vaultKeyId: `router-test-${seedByte}`,
    authority,
  };
  const context: V2NodeSigningContext = { ...node, signer };
  return {
    async ensure() {
      return node;
    },
    async signingContext() {
      return context;
    },
  };
}

async function nodeFixture(seedByte: number, role: "merchant" | "payer") {
  const authority = await authorityProvider(seedByte);
  const node = await authority.ensure();
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  installCashLoomV2Schema(db);
  const store = createV2RecordStore({
    db,
    localNodeKeyId: node.authority.key_id,
    remoteLimits: {
      maxRecordCount: 100,
      maxCanonicalBytes: 2 * 1024 * 1024,
    },
    now: () => NOW,
  });
  let entropy = 1;
  const service = createV2LocalService({
    store,
    authorityProvider: authority,
    now: () => NOW,
    randomBytes(length) {
      const bytes = new Uint8Array(length).fill(entropy);
      entropy += 1;
      return bytes;
    },
  });
  const descriptor = await service.activateNode({ roles: [role] });
  const app = new Hono();
  mountV2PublicRoutes(app, { store: () => store, now: () => NOW });
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer local-test") {
      return c.json({ error: "locked" }, 401);
    }
    await next();
  });
  mountV2LocalRoutes(app, {
    store: () => store,
    service: async () => service,
  });
  return { authority, node, db, store, service, descriptor, app };
}

describe("bounded v2 HTTP doors", () => {
  test("enforces media, canonical-byte, streamed-size, idempotency, and privacy boundaries", async () => {
    const fixture = await nodeFixture(51, "merchant");
    const trust = await fixture.service.createAssetTrustManifest({
      manifest: manifest(),
      audience: "public",
      disclosure: "public",
    });
    const request = await fixture.service.createPaymentRequest({
      rail: "bitcoin-mainnet",
      destination: "bc1qroutermerchant",
      asset_id: BTC_ASSET,
      amount_atomic: "1000",
      purpose_hash: sha256Id({ test: "router" }),
      asset_trust: {
        record_id: trust.record_id,
        trusted_authority_key_id: fixture.node.authority.key_id,
      },
    });

    expect(
      (
        await fixture.app.request("/v2/records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(415);

    const pretty = JSON.stringify(request.record, null, 2);
    const noncanonical = await fixture.app.request("/v2/records", {
      method: "POST",
      headers: { "content-type": V2_RECORD_MEDIA_TYPE },
      body: pretty,
    });
    expect(noncanonical.status).toBe(422);

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(V2_MAX_RECORD_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const oversized = await fixture.app.request(
      new Request("http://local.test/v2/records", {
        method: "POST",
        headers: { "content-type": V2_RECORD_MEDIA_TYPE },
        body: oversizedStream,
        // Required by Node-compatible Request implementations; ignored by Bun.
        duplex: "half",
      } as RequestInit),
    );
    expect(oversized.status).toBe(413);

    const duplicate = await fixture.app.request("/v2/records", {
      method: "POST",
      headers: { "content-type": V2_RECORD_MEDIA_TYPE },
      body: Uint8Array.from(v2RecordBytes(request.record)).buffer,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ inserted: false });

    const localPrivate = await fixture.service.createAssetTrustManifest({
      manifest: manifest(),
      audience: fixture.node.authority.key_id,
      disclosure: "private",
    });
    const privateResponse = await fixture.app.request(
      `/v2/records/${localPrivate.record_id}`,
    );
    const missingResponse = await fixture.app.request(
      `/v2/records/sha256:${"0".repeat(64)}`,
    );
    expect(privateResponse.status).toBe(404);
    expect(await privateResponse.text()).toBe(await missingResponse.text());

    const locked = await fixture.app.request(
      `/api/v2/records/${localPrivate.record_id}`,
    );
    expect(locked.status).toBe(401);
    const unlocked = await fixture.app.request(
      `/api/v2/records/${localPrivate.record_id}`,
      { headers: { authorization: "Bearer local-test" } },
    );
    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("content-type")).toBe(V2_RECORD_MEDIA_TYPE);
    fixture.db.close();
  });
});

describe("operatorless two-node loopback transport", () => {
  test("exchanges public terms and a private intent while cashloom.io is unavailable", async () => {
    const merchant = await nodeFixture(52, "merchant");
    const payer = await nodeFixture(53, "payer");
    const merchantTrust = await merchant.service.createAssetTrustManifest({
      manifest: manifest(),
      audience: "public",
      disclosure: "public",
    });
    const payerTrust = await payer.service.createAssetTrustManifest({
      manifest: manifest(),
    });
    const paymentRequest = await merchant.service.createPaymentRequest({
      rail: "bitcoin-mainnet",
      destination: "bc1qloopbackmerchant",
      asset_id: BTC_ASSET,
      amount_atomic: "21000",
      purpose_hash: sha256Id({ ride: "operatorless-loopback" }),
      asset_trust: {
        record_id: merchantTrust.record_id,
        trusted_authority_key_id: merchant.node.authority.key_id,
      },
    });

    const merchantServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: merchant.app.fetch,
    });
    const payerServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: payer.app.fetch,
    });
    const merchantTarget: DirectNodeTarget = {
      descriptorUrl:
        `http://127.0.0.1:${merchantServer.port}/.well-known/cashloom/v2`,
      descriptor: merchant.descriptor,
      expectedNodeKeyId: merchant.descriptor.authority.key_id,
      expectedOrigin: `http://127.0.0.1:${merchantServer.port}`,
    };
    const payerTarget: DirectNodeTarget = {
      descriptorUrl:
        `http://127.0.0.1:${payerServer.port}/.well-known/cashloom/v2`,
      descriptor: payer.descriptor,
      expectedNodeKeyId: payer.descriptor.authority.key_id,
      expectedOrigin: `http://127.0.0.1:${payerServer.port}`,
    };
    let loopbackCalls = 0;
    const noCashLoomDomain: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "cashloom.io") {
        throw new Error("cashloom.io is intentionally unavailable");
      }
      expect(url.hostname).toBe("127.0.0.1");
      loopbackCalls += 1;
      return fetch(input, init);
    };

    try {
      await expect(
        noCashLoomDomain("https://cashloom.io/v2/records"),
      ).rejects.toThrow(/intentionally unavailable/);

      await postV2Record(payerTarget, merchant.descriptor, {
        fetch: noCashLoomDomain,
        now: () => NOW,
      });
      await postV2Record(payerTarget, paymentRequest.record, {
        fetch: noCashLoomDomain,
        now: () => NOW,
      });
      const mirrored = await getPublicV2Record(
        payerTarget,
        paymentRequest.record.record_id,
        { fetch: noCashLoomDomain, now: () => NOW },
      );
      expect(mirrored.record_id).toBe(paymentRequest.record.record_id);

      const intent = await payer.service.createPaymentIntent({
        request_record_id: mirrored.record_id,
        source_account: "bitcoin:bc1qloopbackpayer",
        fee_asset_id: BTC_ASSET,
        max_fee_atomic: "400",
        payment_asset_trust: {
          record_id: payerTrust.record_id,
          trusted_authority_key_id: payer.node.authority.key_id,
        },
        fee_asset_trust: {
          record_id: payerTrust.record_id,
          trusted_authority_key_id: payer.node.authority.key_id,
        },
      });
      await postV2Record(merchantTarget, intent.record, {
        fetch: noCashLoomDomain,
        now: () => NOW,
      });
      expect(
        merchant.store.getLocal(intent.record.record_id)?.record_id,
      ).toBe(intent.record.record_id);
      expect(merchant.store.getPublic(intent.record.record_id)).toBeNull();
      expect(loopbackCalls).toBe(4);
    } finally {
      merchantServer.stop(true);
      payerServer.stop(true);
      merchant.db.close();
      payer.db.close();
    }
  });
});
