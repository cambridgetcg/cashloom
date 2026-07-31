import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  canonicalJsonBytes,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import { createV2LocalService } from "./local-service.ts";
import type {
  V2NodeAuthority,
  V2NodeAuthorityProvider,
  V2NodeSigningContext,
} from "./node-authority.ts";
import {
  V2PayLinkWorkflowError,
  createV2PayLinkService,
  inspectV2PayLink,
  inspectV2PayLinkAcceptance,
} from "./pay-link-service.ts";
import { createV2RecordStore } from "./record-store.ts";
import { createSelfCertifyingAuthority } from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const LATER = "2030-01-01T00:30:00.000Z";
const AFTER_INTENT = "2030-01-01T00:45:00.000Z";
const EXPIRED = "2030-01-01T02:00:00.000Z";
const MERCHANT_ADDRESS =
  "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty";
const PAYER_ADDRESS =
  "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5";

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
    vaultKeyId: `pay-link-test-${seedByte}`,
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

function deterministicEntropy() {
  let next = 1;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length).fill(next);
    next += 1;
    return bytes;
  };
}

async function node(
  seedByte: number,
  now: () => string,
  remoteLimits = {
    maxRecordCount: 100,
    maxCanonicalBytes: 2 * 1024 * 1024,
  },
) {
  const provider = await fakeAuthorityProvider(seedByte);
  const identity = await provider.ensure();
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  installCashLoomV2Schema(db);
  const store = createV2RecordStore({
    db,
    localNodeKeyId: identity.authority.key_id,
    remoteLimits,
    now,
  });
  const localService = createV2LocalService({
    store,
    authorityProvider: provider,
    now,
    randomBytes: deterministicEntropy(),
  });
  const payLinks = createV2PayLinkService({
    store: () => store,
    localService: async () => localService,
    now,
  });
  return { db, identity, store, localService, payLinks };
}

function recordCount(db: Database): number {
  return (
    db.query(
      "SELECT COUNT(*) AS count FROM cashloom_v2_records",
    ).get() as { count: number }
  ).count;
}

describe("human CashLoom Pay Link workflow", () => {
  test("round-trips request and acceptance between two offline sovereign nodes", async () => {
    let clock = NOW;
    const now = () => clock;
    const merchant = await node(71, now);
    const payer = await node(72, now);

    const offer = await merchant.payLinks.createBitcoinPayLink({
      destination: MERCHANT_ADDRESS,
      amount_sats: "25000",
      note: "playground ticket",
      ttl_seconds: 60 * 60,
    });
    expect(offer.filename).toMatch(/\.cashloom-pay$/);
    expect(offer.projection).toMatchObject({
      kind: "request",
      amount_atomic: "25000",
      destination: MERCHANT_ADDRESS,
      note: "playground ticket",
      identity_assurance: "first-contact-key",
      signature_valid: true,
      asset_policy_accepted: true,
      no_money_moved: true,
    });

    const offerBytes = new TextEncoder().encode(offer.bundle);
    const beforeInspect = recordCount(payer.db);
    expect(inspectV2PayLink(offerBytes, { now: NOW }).bundle_id).toBe(
      offer.projection.bundle_id,
    );
    expect(recordCount(payer.db)).toBe(beforeInspect);

    clock = LATER;
    const accepted = await payer.payLinks.acceptBitcoinPayLink({
      bundle: offerBytes,
      source_account: PAYER_ADDRESS,
      max_fee_sats: "1000",
    });
    expect(accepted.reused).toBe(false);
    expect(accepted.filename).toMatch(/\.cashloom-accept$/);
    expect(accepted.projection).toMatchObject({
      kind: "acceptance",
      merchant_key_id: merchant.identity.authority.key_id,
      payer_key_id: payer.identity.authority.key_id,
      source_account: PAYER_ADDRESS,
      max_fee_atomic: "1000",
      no_money_moved: true,
      intent_active_at_verification: true,
      confidentiality: "sensitive-plaintext",
    });
    expect(accepted.bundle).toContain(PAYER_ADDRESS);

    const acceptanceBytes = new TextEncoder().encode(accepted.bundle);
    clock = AFTER_INTENT;
    expect(
      inspectV2PayLinkAcceptance(acceptanceBytes, {
        expectedMerchantKeyId: merchant.identity.authority.key_id,
        now: AFTER_INTENT,
      }),
    ).toMatchObject({
      acceptance_id: accepted.projection.acceptance_id,
      intent_active_at_verification: false,
    });

    const imported =
      merchant.payLinks.importPayLinkAcceptance(acceptanceBytes);
    expect(imported.inserted_count).toBe(2);
    expect(imported.projection.no_money_moved).toBe(true);
    expect(imported.projection.intent_active_at_verification).toBe(false);
    expect(
      merchant.store.getPublic(
        imported.projection.acceptance_id,
      ),
    ).toBeNull();

    const replay =
      merchant.payLinks.importPayLinkAcceptance(acceptanceBytes);
    expect(replay.inserted_count).toBe(0);
    const acceptedReplay = await payer.payLinks.acceptBitcoinPayLink({
      bundle: offerBytes,
      source_account: PAYER_ADDRESS,
      max_fee_sats: "1000",
    });
    expect(acceptedReplay.reused).toBe(true);
    expect(acceptedReplay.bundle).toBe(accepted.bundle);
    expect(
      acceptedReplay.projection.intent_active_at_verification,
    ).toBe(false);

    merchant.db.close();
    payer.db.close();
  });

  test("verifies the whole private carrier before writes and pins the merchant", async () => {
    let clock = NOW;
    const now = () => clock;
    const merchant = await node(73, now);
    const payer = await node(74, now);
    const stranger = await node(75, now);
    const offer = await merchant.payLinks.createBitcoinPayLink({
      destination: MERCHANT_ADDRESS,
      amount_sats: "50000",
    });
    clock = LATER;
    const accepted = await payer.payLinks.acceptBitcoinPayLink({
      bundle: new TextEncoder().encode(offer.bundle),
      source_account: PAYER_ADDRESS,
      max_fee_sats: "2000",
    });
    const acceptanceBytes = new TextEncoder().encode(accepted.bundle);

    await stranger.localService.activateNode();
    expect(() =>
      stranger.payLinks.importPayLinkAcceptance(acceptanceBytes),
    ).toThrow(/merchant key/i);
    expect(() =>
      inspectV2PayLinkAcceptance(new Uint8Array([0xff]), {
        expectedMerchantKeyId: merchant.identity.authority.key_id,
        now: LATER,
      }),
    ).toThrow(/UTF-8/i);
    expect(() =>
      inspectV2PayLinkAcceptance(
        new Uint8Array([...acceptanceBytes, 0x20]),
        {
          expectedMerchantKeyId: merchant.identity.authority.key_id,
          now: LATER,
        },
      ),
    ).toThrow(/canonical/i);
    const excessiveNesting = new TextEncoder().encode(
      `${"[".repeat(41)}0${"]".repeat(41)}`,
    );
    expect(() =>
      inspectV2PayLinkAcceptance(excessiveNesting, {
        expectedMerchantKeyId: merchant.identity.authority.key_id,
        now: LATER,
      }),
    ).toThrow(/nesting/i);
    const withUnknown = JSON.parse(accepted.bundle) as Record<string, unknown>;
    withUnknown.cloud_identity = "not authority";
    expect(() =>
      inspectV2PayLinkAcceptance(canonicalJsonBytes(withUnknown), {
        expectedMerchantKeyId: merchant.identity.authority.key_id,
        now: LATER,
      }),
    ).toThrow(/closed schema/i);

    const tampered = JSON.parse(accepted.bundle) as Record<string, unknown>;
    const records = tampered.records as Record<string, unknown>;
    const intent = records.payment_intent as Record<string, unknown>;
    intent.max_fee_atomic = "2001";
    const tamperedBytes = new TextEncoder().encode(JSON.stringify(tampered));
    const before = recordCount(merchant.db);
    expect(() =>
      merchant.payLinks.importPayLinkAcceptance(tamperedBytes),
    ).toThrow();
    expect(recordCount(merchant.db)).toBe(before);

    merchant.db.close();
    payer.db.close();
    stranger.db.close();
  });

  test("refuses changed acceptance terms and expired public offers", async () => {
    let clock = NOW;
    const now = () => clock;
    const merchant = await node(76, now);
    const payer = await node(77, now);
    const offer = await merchant.payLinks.createBitcoinPayLink({
      destination: MERCHANT_ADDRESS,
      amount_sats: "75000",
      ttl_seconds: 60 * 60,
    });
    const bytes = new TextEncoder().encode(offer.bundle);
    clock = LATER;
    await payer.payLinks.acceptBitcoinPayLink({
      bundle: bytes,
      source_account: PAYER_ADDRESS,
      max_fee_sats: "3000",
    });
    await expect(
      payer.payLinks.acceptBitcoinPayLink({
        bundle: bytes,
        source_account: PAYER_ADDRESS,
        max_fee_sats: "3001",
      }),
    ).rejects.toBeInstanceOf(V2PayLinkWorkflowError);

    clock = EXPIRED;
    expect(() => inspectV2PayLink(bytes, { now: EXPIRED })).toThrow(
      /not active/i,
    );

    merchant.db.close();
    payer.db.close();
  });

  test("rolls a carrier import back when a later remote quota check fails", async () => {
    let clock = NOW;
    const now = () => clock;
    const merchant = await node(78, now, {
      maxRecordCount: 1,
      maxCanonicalBytes: 2 * 1024 * 1024,
    });
    const payer = await node(79, now);
    const offer = await merchant.payLinks.createBitcoinPayLink({
      destination: MERCHANT_ADDRESS,
      amount_sats: "90000",
    });
    clock = LATER;
    const accepted = await payer.payLinks.acceptBitcoinPayLink({
      bundle: new TextEncoder().encode(offer.bundle),
      source_account: PAYER_ADDRESS,
      max_fee_sats: "4000",
    });
    const before = recordCount(merchant.db);
    expect(() =>
      merchant.payLinks.importPayLinkAcceptance(
        new TextEncoder().encode(accepted.bundle),
      ),
    ).toThrow(/remote-record admission budget/i);
    expect(recordCount(merchant.db)).toBe(before);
    expect(merchant.store.remoteUsage().remoteRecordCount).toBe(0);

    merchant.db.close();
    payer.db.close();
  });
});
