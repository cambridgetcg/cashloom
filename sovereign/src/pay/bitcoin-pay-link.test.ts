import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  equalBytes,
  sha256BytesId,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  bitcoinMainnetTrustManifest,
} from "../protocol/v2/bitcoin-profile.ts";
import { createV2LocalService } from "../protocol/v2/local-service.ts";
import type {
  V2NodeAuthority,
  V2NodeAuthorityProvider,
  V2NodeSigningContext,
} from "../protocol/v2/node-authority.ts";
import { createV2RecordStore } from "../protocol/v2/record-store.ts";
import {
  createSelfCertifyingAuthority,
  v2RecordBytes,
  verifyV2RecordLink,
} from "../protocol/v2/records.ts";
import { installCashLoomV2Schema } from "../protocol/v2/schema.ts";
import {
  AmbiguousBroadcastError,
  type PaymentInstruction,
  type PaymentSender,
  type SendHooks,
  type SenderContext,
} from "../senders/types.ts";
import {
  Address,
  NETWORK,
  OutScript,
  Transaction,
} from "@scure/btc-signer";

// pay.ts owns one process-global database. This test gets a dedicated Bun
// invocation from package.json and fixes its path before that module graph is
// imported, so no developer ledger, vault, or sibling test database is used.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(
  join(tmpdir(), "cashloom-btc-pay-link-service-"),
);

const { db, newId } = await import("../db.ts");
const { confirmPayment, quotePayment } = await import("../pay.ts");
const {
  createBitcoinPayLinkExecutionService,
} = await import("./bitcoin-pay-link.ts");

const NOW = "2030-01-01T00:00:00.000Z";
const PAYER_ADDRESS =
  "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5";
const MERCHANT_ADDRESS =
  "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty";

function offset(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

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
  const node: V2NodeAuthority = Object.freeze({
    vaultKeyId: `bitcoin-pay-link-test-${seedByte}`,
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

function insertBtcAccount(address: string, label: string): string {
  const vaultKeyId = newId();
  const accountId = newId();
  db.query(
    `INSERT INTO vault_keys (id, label, kind, address, enc_blob)
     VALUES (?, ?, 'btc', ?, ?)`,
  ).run(vaultKeyId, `${label} key`, address, new Uint8Array([1, 2, 3]));
  db.query(
    `INSERT INTO accounts
       (id, rail, display_name, currency, decimals, external_account_id,
        vault_key_id, status)
     VALUES (?, 'CRYPTO', ?, 'BTC', 8, ?, ?, 'ACTIVE')`,
  ).run(accountId, label, address, vaultKeyId);
  return accountId;
}

type SendMode = "broadcast" | "ambiguous";

interface FakeBitcoinRail {
  sender: PaymentSender;
  compile: (
    context: SenderContext,
    instruction: PaymentInstruction,
  ) => Promise<{ payload: Uint8Array; hash: `sha256:${string}` }>;
  readonly payload: Uint8Array;
  readonly payloadHash: `sha256:${string}`;
  readonly txid: string;
  quoteCalls: number;
  compilerCalls: number;
  sendCalls: number;
  compiledPayload: Uint8Array;
  compiledHash: `sha256:${string}`;
}

function fakeBitcoinRail(
  serial: number,
  feeSats: string,
  mode: SendMode,
): FakeBitcoinRail {
  const payerScript = OutScript.encode(
    Address(NETWORK).decode(PAYER_ADDRESS)!,
  );
  const unsigned = new Transaction({ lockTime: serial });
  unsigned.addInput({
    txid: new Uint8Array(32).fill(serial & 0xff),
    index: 0,
    witnessUtxo: {
      script: payerScript,
      amount: 25_000n + BigInt(feeSats),
    },
    sequence: 0xfffffffd,
  });
  unsigned.addOutputAddress(MERCHANT_ADDRESS, 25_000n, NETWORK);
  const payload = Uint8Array.from(unsigned.toPSBT(0));
  const payloadHash = sha256BytesId(payload);
  const txid = unsigned.id;
  const rail: FakeBitcoinRail = {
    payload,
    payloadHash,
    txid,
    quoteCalls: 0,
    compilerCalls: 0,
    sendCalls: 0,
    compiledPayload: Uint8Array.from(payload),
    compiledHash: payloadHash,
    sender: undefined as unknown as PaymentSender,
    compile: undefined as unknown as FakeBitcoinRail["compile"],
  };
  rail.sender = {
    type: "btc",
    assets: ["BTC"],
    async quote(
      _context: SenderContext,
      instruction: PaymentInstruction,
    ) {
      rail.quoteCalls += 1;
      expect(instruction).toMatchObject({
        to: MERCHANT_ADDRESS,
        amountMinor: "25000",
        asset: "BTC",
      });
      return {
        feeMinor: feeSats,
        feeAsset: "BTC",
        summary: "exact injected Bitcoin quote",
        detail: JSON.stringify({ fixture: serial }),
        unsignedPayload: Uint8Array.from(payload),
        unsignedPayloadHash: payloadHash,
      };
    },
    async send(
      context: SenderContext,
      instruction: PaymentInstruction,
      hooks?: SendHooks,
    ) {
      rail.sendCalls += 1;
      expect(instruction).toMatchObject({
        to: MERCHANT_ADDRESS,
        amountMinor: "25000",
        asset: "BTC",
      });
      expect(context.expectedUnsignedPayloadHash).toBe(payloadHash);
      expect(
        equalBytes(context.expectedUnsignedPayload!, payload),
      ).toBe(true);
      hooks?.onSigned?.(txid);
      if (mode === "ambiguous") {
        throw new AmbiguousBroadcastError(
          `Bitcoin broadcast outcome unknown for ${txid}.`,
          txid,
        );
      }
      return {
        externalId: txid,
        status: "broadcast",
        totalOutMinor: (25_000n + BigInt(feeSats)).toString(),
      };
    },
  };
  rail.compile = async () => {
    rail.compilerCalls += 1;
    return {
      payload: Uint8Array.from(rail.compiledPayload),
      hash: rail.compiledHash,
    };
  };
  return rail;
}

interface FixtureOptions {
  readonly feeSats?: string;
  readonly maxFeeSats?: string;
  readonly intentTtlSeconds?: number;
  readonly sendMode?: SendMode;
}

let nextFixtureSeed = 70;

async function executionFixture(options: FixtureOptions = {}) {
  const serial = nextFixtureSeed;
  nextFixtureSeed += 2;
  const clock = { value: NOW };
  const merchantAuthority = await authorityProvider(serial);
  const payerAuthority = await authorityProvider(serial + 1);
  const merchantNode = await merchantAuthority.ensure();
  const payerNode = await payerAuthority.ensure();

  const merchantDb = new Database(":memory:");
  merchantDb.exec("PRAGMA foreign_keys = ON;");
  installCashLoomV2Schema(merchantDb);
  const merchantStore = createV2RecordStore({
    db: merchantDb,
    localNodeKeyId: merchantNode.authority.key_id,
    remoteLimits: {
      maxRecordCount: 100,
      maxCanonicalBytes: 2 * 1024 * 1024,
    },
    now: () => clock.value,
  });
  const payerStore = createV2RecordStore({
    db,
    localNodeKeyId: payerNode.authority.key_id,
    remoteLimits: {
      maxRecordCount: 10_000,
      maxCanonicalBytes: 64 * 1024 * 1024,
    },
    now: () => clock.value,
  });
  const merchantService = createV2LocalService({
    store: merchantStore,
    authorityProvider: merchantAuthority,
    now: () => clock.value,
    randomBytes: deterministicEntropy(),
  });
  const payerService = createV2LocalService({
    store: payerStore,
    authorityProvider: payerAuthority,
    now: () => clock.value,
    randomBytes: deterministicEntropy(),
  });

  const merchantOnlyDescriptor = await merchantService.activateNode({
    roles: ["merchant"],
  });
  await payerService.activateNode({ roles: ["payer"] });
  const merchantTrust = await merchantService.createAssetTrustManifest({
    manifest: bitcoinMainnetTrustManifest(NOW),
    audience: "public",
    disclosure: "public",
  });
  const payerTrust = await payerService.createAssetTrustManifest({
    manifest: bitcoinMainnetTrustManifest(NOW),
    audience: merchantNode.authority.key_id,
    disclosure: "private",
  });
  const request = await merchantService.createPaymentRequest({
    rail: BITCOIN_MAINNET_RAIL,
    destination: MERCHANT_ADDRESS,
    asset_id: BITCOIN_MAINNET_ASSET_ID,
    amount_atomic: "25000",
    purpose_hash: sha256Id({ pay_link_execution_fixture: serial }),
    asset_trust: {
      record_id: merchantTrust.record_id,
      trusted_authority_key_id: merchantNode.authority.key_id,
    },
  });
  // A later dual-role descriptor lets the imported-evidence negative test
  // reach the local-source/issuer check. The signed request remains bound to
  // the earlier merchant-only descriptor, which is the record the payer saw.
  await merchantService.activateNode({ roles: ["merchant", "payer"] });
  payerStore.append(v2RecordBytes(merchantOnlyDescriptor), "remote");
  payerStore.append(v2RecordBytes(merchantTrust), "remote");
  payerStore.append(v2RecordBytes(request.record), "remote");
  const intent = await payerService.createPaymentIntent({
    request_record_id: request.record.record_id,
    source_account: PAYER_ADDRESS,
    fee_asset_id: BITCOIN_MAINNET_ASSET_ID,
    max_fee_atomic: options.maxFeeSats ?? "500",
    payment_asset_trust: {
      record_id: payerTrust.record_id,
      trusted_authority_key_id: payerNode.authority.key_id,
    },
    fee_asset_trust: {
      record_id: payerTrust.record_id,
      trusted_authority_key_id: payerNode.authority.key_id,
    },
    ttl_seconds: options.intentTtlSeconds ?? 10 * 60,
  });

  // The merchant may retain this acceptance as remote evidence, but that
  // imported copy can never authorize the merchant's vault or payer service.
  merchantStore.append(v2RecordBytes(payerTrust), "remote");
  merchantStore.append(v2RecordBytes(intent.record), "remote");

  const accountId = insertBtcAccount(
    PAYER_ADDRESS,
    `payer wallet ${serial}`,
  );
  const rail = fakeBitcoinRail(
    serial,
    options.feeSats ?? "100",
    options.sendMode ?? "broadcast",
  );
  const makeService = (
    confirmOverride?: typeof confirmPayment,
    quoteOverride?: typeof quotePayment,
  ) =>
    createBitcoinPayLinkExecutionService({
      database: db,
      store: () => payerStore,
      localService: async () => payerService,
      now: () => clock.value,
      senders: [rail.sender],
      unsignedPayloadFor: rail.compile,
      ...(confirmOverride === undefined
        ? {}
        : { confirm: confirmOverride }),
      ...(quoteOverride === undefined ? {} : { quote: quoteOverride }),
    });

  return {
    accountId,
    clock,
    intent: intent.record,
    makeService,
    merchantDb,
    merchantOnlyDescriptor,
    merchantService,
    merchantStore,
    payerNode,
    payerStore,
    rail,
    request: request.record,
    serial,
    service: makeService(),
  };
}

function paymentStatus(paymentId: string): string {
  return (
    db.query("SELECT status FROM payments WHERE id = ?").get(paymentId) as {
      status: string;
    }
  ).status;
}

describe("Bitcoin Pay Link execution service", () => {
  it("prepares one exact review without signing and reuses its durable binding", async () => {
    const fixture = await executionFixture({
      feeSats: "500",
      maxFeeSats: "500",
    });
    const prepared = await fixture.service.prepare({
      intent_record_id: fixture.intent.record_id,
      account_id: fixture.accountId,
    });

    expect(prepared.reused).toBe(false);
    expect(prepared.review).toMatchObject({
      intent_record_id: fixture.intent.record_id,
      request_record_id: fixture.request.record_id,
      merchant_key_id: fixture.intent.audience,
      account_id: fixture.accountId,
      source_address: PAYER_ADDRESS,
      destination: MERCHANT_ADDRESS,
      network: "Bitcoin mainnet",
      asset: "BTC",
      amount_sats: "25000",
      fee_sats: "500",
      total_sats: "25500",
      max_fee_sats: "500",
      quote_expires_at: offset(NOW, 5 * 60 * 1_000),
      intent_expires_at: offset(NOW, 10 * 60 * 1_000),
      confirm_before: offset(NOW, 5 * 60 * 1_000),
      fee_is_exact: true,
      cashloom_fee_sats: "0",
      no_money_moved: true,
      transaction_not_signed: true,
    });
    expect(paymentStatus(prepared.review.payment_id)).toBe("quoted");
    const binding = db.query(
      `SELECT intent_record_id, payment_id, account_id, review_id,
              reservation_id, unsigned_payload, unsigned_payload_hash,
              quote_expires_at
         FROM cashloom_v2_btc_payment_bindings
        WHERE intent_record_id = ?`,
    ).get(fixture.intent.record_id) as {
      intent_record_id: string;
      payment_id: string;
      account_id: string;
      review_id: string;
      reservation_id: string;
      unsigned_payload: Uint8Array;
      unsigned_payload_hash: string;
      quote_expires_at: string;
    };
    expect(binding).toMatchObject({
      intent_record_id: fixture.intent.record_id,
      payment_id: prepared.review.payment_id,
      account_id: fixture.accountId,
      review_id: prepared.review.review_id,
      unsigned_payload_hash: fixture.rail.payloadHash,
      quote_expires_at: prepared.review.quote_expires_at,
    });
    expect(equalBytes(binding.unsigned_payload, fixture.rail.payload)).toBe(true);
    expect(binding.reservation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixture.rail.quoteCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(0);
    expect(
      fixture.payerStore.localExecutionCommitmentFor(
        fixture.intent.record_id,
        fixture.payerNode.authority.key_id,
      ),
    ).toBeNull();
    expect(
      fixture.service.status({
        payment_id: prepared.review.payment_id,
        review_id: prepared.review.review_id,
      }),
    ).toEqual({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
      intent_record_id: fixture.intent.record_id,
      status: "awaiting_confirmation",
      can_confirm: true,
      tx_hash: null,
      error: null,
    });
    expect(fixture.rail.compilerCalls).toBe(0);
    expect(fixture.rail.sendCalls).toBe(0);

    const retry = await fixture.service.prepare({
      intent_record_id: fixture.intent.record_id,
      account_id: fixture.accountId,
    });
    expect(retry.reused).toBe(true);
    expect(retry.review).toEqual(prepared.review);
    expect(fixture.rail.quoteCalls).toBe(1);

    await expect(
      confirmPayment(prepared.review.payment_id, {
        senders: [fixture.rail.sender],
        now: () => fixture.clock.value,
      }),
    ).rejects.toThrow(/exact bound-confirmation door/i);
    await expect(
      fixture.service.confirm({
        payment_id: prepared.review.payment_id,
        review_id: sha256Id({ wrong_review: fixture.serial }),
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_READY" });
    expect(paymentStatus(prepared.review.payment_id)).toBe("quoted");
    expect(fixture.rail.sendCalls).toBe(0);
    fixture.merchantDb.close();
  });

  it("refuses an imported intent and a local account with the wrong source", async () => {
    const fixture = await executionFixture();
    const importedService = createBitcoinPayLinkExecutionService({
      database: db,
      store: () => fixture.merchantStore,
      localService: async () => fixture.merchantService,
      now: () => fixture.clock.value,
      senders: [fixture.rail.sender],
      unsignedPayloadFor: fixture.rail.compile,
    });
    await expect(
      importedService.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "INTENT_NOT_LOCALLY_AUTHORED" });

    const wrongAccountId = insertBtcAccount(
      MERCHANT_ADDRESS,
      `wrong source ${fixture.serial}`,
    );
    await expect(
      fixture.service.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: wrongAccountId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SOURCE_MISMATCH" });
    expect(fixture.rail.quoteCalls).toBe(0);
    expect(fixture.rail.sendCalls).toBe(0);
    expect(
      db.query(
        "SELECT payment_id FROM cashloom_v2_btc_payment_bindings WHERE intent_record_id = ?",
      ).get(fixture.intent.record_id),
    ).toBeNull();
    fixture.merchantDb.close();
  });

  it("rejects non-payer and expired descriptors before asking for a quote", async () => {
    const fixture = await executionFixture();
    const nonPayerDb = new Database(":memory:");
    nonPayerDb.exec("PRAGMA foreign_keys = ON;");
    installCashLoomV2Schema(nonPayerDb);
    const nonPayerStore = createV2RecordStore({
      db: nonPayerDb,
      localNodeKeyId: fixture.merchantOnlyDescriptor.authority.key_id,
      remoteLimits: {
        maxRecordCount: 100,
        maxCanonicalBytes: 2 * 1024 * 1024,
      },
      now: () => fixture.clock.value,
    });
    nonPayerStore.append(
      v2RecordBytes(fixture.merchantOnlyDescriptor),
      "local",
    );
    const nonPayerService = createBitcoinPayLinkExecutionService({
      database: db,
      store: () => nonPayerStore,
      localService: async () => fixture.merchantService,
      now: () => fixture.clock.value,
      senders: [fixture.rail.sender],
      unsignedPayloadFor: fixture.rail.compile,
    });
    await expect(
      nonPayerService.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_ACTIVATED" });
    expect(fixture.rail.quoteCalls).toBe(0);

    fixture.clock.value = offset(NOW, 8 * 24 * 60 * 60 * 1_000);
    await expect(
      fixture.service.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_ACTIVATED" });
    expect(fixture.rail.quoteCalls).toBe(0);
    nonPayerDb.close();
    fixture.merchantDb.close();
  });

  it("rolls both payment and binding back when the exact fee exceeds consent", async () => {
    const fixture = await executionFixture({
      feeSats: "501",
      maxFeeSats: "500",
    });
    await expect(
      fixture.service.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "FEE_LIMIT_EXCEEDED" });
    expect(fixture.rail.quoteCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(0);
    expect(
      db.query("SELECT count(*) AS count FROM payments WHERE account_id = ?")
        .get(fixture.accountId),
    ).toEqual({ count: 0 });
    expect(
      db.query(
        "SELECT payment_id FROM cashloom_v2_btc_payment_bindings WHERE intent_record_id = ?",
      ).get(fixture.intent.record_id),
    ).toBeNull();
    expect(
      fixture.payerStore.localExecutionCommitmentFor(
        fixture.intent.record_id,
        fixture.payerNode.authority.key_id,
      ),
    ).toBeNull();
    fixture.merchantDb.close();
  });

  it("confirms the exact review once, appends its commitment, and returns repeat status", async () => {
    const fixture = await executionFixture();
    const prepared = await fixture.service.prepare({
      intent_record_id: fixture.intent.record_id,
      account_id: fixture.accountId,
    });
    const result = await fixture.service.confirm({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
    });
    expect(result).toMatchObject({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
      status: "broadcast",
      tx_hash: fixture.rail.txid,
      error: null,
    });
    expect(fixture.rail.compilerCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(1);
    const commitment = fixture.payerStore.localExecutionCommitmentFor(
      fixture.intent.record_id,
      fixture.payerNode.authority.key_id,
    );
    expect(commitment).not.toBeNull();
    expect(commitment).toMatchObject({
      parent_record_id: fixture.intent.record_id,
      reservation_id: (
        db.query(
          `SELECT reservation_id
             FROM cashloom_v2_btc_payment_bindings
            WHERE intent_record_id = ?`,
        ).get(fixture.intent.record_id) as { reservation_id: string }
      ).reservation_id,
      unsigned_payload_hash: fixture.rail.payloadHash,
      expires_at: prepared.review.confirm_before,
    });
    expect(() => verifyV2RecordLink(commitment!, fixture.intent)).not.toThrow();
    expect(paymentStatus(prepared.review.payment_id)).toBe("broadcast");
    expect(
      db.query(
        "SELECT count(*) AS count FROM transactions WHERE external_id = ?",
      ).get(fixture.rail.txid),
    ).toEqual({ count: 1 });

    const retry = await fixture.service.confirm({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
    });
    expect(retry).toEqual(result);
    expect(fixture.rail.compilerCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(1);
    await expect(
      fixture.service.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CONFLICT" });
    expect(fixture.rail.quoteCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(1);

    fixture.clock.value = offset(fixture.intent.expires_at, 1);
    const historical = await fixture.service.confirm({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
    });
    expect(historical).toEqual(result);
    expect(
      fixture.service.status({
        payment_id: prepared.review.payment_id,
        review_id: prepared.review.review_id,
      }),
    ).toEqual({
      ...result,
      intent_record_id: fixture.intent.record_id,
      can_confirm: false,
    });
    expect(fixture.rail.sendCalls).toBe(1);
    fixture.merchantDb.close();
  });

  it("refuses the initial review when its committed quote is claimed before prepare returns", async () => {
    const fixture = await executionFixture();
    let racingService!: ReturnType<typeof fixture.makeService>;
    const quoteThenClaim: typeof quotePayment = async (input, runtime) => {
      const quoted = await quotePayment(input, runtime);
      const binding = db.query(
        `SELECT payment_id, review_id
           FROM cashloom_v2_btc_payment_bindings
          WHERE payment_id = ?`,
      ).get(quoted.paymentId) as {
        payment_id: string;
        review_id: string;
      } | null;
      if (binding === null) throw new Error("test binding was not committed");
      const claimed = await racingService.confirm({
        payment_id: binding.payment_id,
        review_id: binding.review_id,
      });
      expect(claimed.status).toBe("broadcast");
      return quoted;
    };
    racingService = fixture.makeService(undefined, quoteThenClaim);

    await expect(
      racingService.prepare({
        intent_record_id: fixture.intent.record_id,
        account_id: fixture.accountId,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CONFLICT" });
    expect(fixture.rail.quoteCalls).toBe(1);
    expect(fixture.rail.compilerCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(1);
    fixture.merchantDb.close();
  });

  it("gives only one concurrent confirmer the signing claim", async () => {
    const fixture = await executionFixture();
    const prepared = await fixture.service.prepare({
      intent_record_id: fixture.intent.record_id,
      account_id: fixture.accountId,
    });
    let arrivals = 0;
    let release!: () => void;
    const bothAtClaim = new Promise<void>((resolve) => {
      release = resolve;
    });
    const confirmWithBarrier: typeof confirmPayment = (paymentId, runtime) =>
      confirmPayment(paymentId, {
        ...runtime,
        beforeClaim: async () => {
          arrivals += 1;
          if (arrivals === 2) release();
          await bothAtClaim;
        },
      });
    const racedService = fixture.makeService(confirmWithBarrier);
    const results = await Promise.allSettled([
      racedService.confirm({
        payment_id: prepared.review.payment_id,
        review_id: prepared.review.review_id,
      }),
      racedService.confirm({
        payment_id: prepared.review.payment_id,
        review_id: prepared.review.review_id,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    const outcomes = results.map((settled) => {
      if (settled.status !== "fulfilled") throw settled.reason;
      return settled.value.status;
    });
    expect(
      outcomes.every((status) =>
        status === "broadcast" || status === "broadcast_unknown"),
    ).toBe(true);
    expect(fixture.rail.sendCalls).toBe(1);
    expect(paymentStatus(prepared.review.payment_id)).toBe("broadcast");
    expect(
      fixture.payerStore.localExecutionCommitmentFor(
        fixture.intent.record_id,
        fixture.payerNode.authority.key_id,
      ),
    ).not.toBeNull();
    fixture.merchantDb.close();
  });

  it("refuses an expired review and a changed unsigned payload before commitment or send", async () => {
    const expired = await executionFixture({ intentTtlSeconds: 10 * 60 });
    const expiredPrepared = await expired.service.prepare({
      intent_record_id: expired.intent.record_id,
      account_id: expired.accountId,
    });
    expired.clock.value = expiredPrepared.review.confirm_before;
    await expect(
      expired.service.confirm({
        payment_id: expiredPrepared.review.payment_id,
        review_id: expiredPrepared.review.review_id,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_EXPIRED" });
    expect(expired.rail.compilerCalls).toBe(0);
    expect(expired.rail.sendCalls).toBe(0);
    expect(paymentStatus(expiredPrepared.review.payment_id)).toBe("quoted");
    expect(
      expired.payerStore.localExecutionCommitmentFor(
        expired.intent.record_id,
        expired.payerNode.authority.key_id,
      ),
    ).toBeNull();
    expect(
      expired.service.status({
        payment_id: expiredPrepared.review.payment_id,
        review_id: expiredPrepared.review.review_id,
      }),
    ).toMatchObject({
      intent_record_id: expired.intent.record_id,
      status: "not_sent",
      can_confirm: false,
      tx_hash: null,
    });
    expect(paymentStatus(expiredPrepared.review.payment_id)).toBe("quoted");
    expect(expired.rail.compilerCalls).toBe(0);
    expect(expired.rail.sendCalls).toBe(0);
    expect(
      expired.payerStore.localExecutionCommitmentFor(
        expired.intent.record_id,
        expired.payerNode.authority.key_id,
      ),
    ).toBeNull();
    expired.merchantDb.close();

    const changed = await executionFixture();
    const changedPrepared = await changed.service.prepare({
      intent_record_id: changed.intent.record_id,
      account_id: changed.accountId,
    });
    changed.rail.compiledPayload = new Uint8Array([9, 9, 9]);
    changed.rail.compiledHash = sha256BytesId(changed.rail.compiledPayload);
    await expect(
      changed.service.confirm({
        payment_id: changedPrepared.review.payment_id,
        review_id: changedPrepared.review.review_id,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CONFLICT" });
    expect(changed.rail.compilerCalls).toBe(1);
    expect(changed.rail.sendCalls).toBe(0);
    expect(paymentStatus(changedPrepared.review.payment_id)).toBe("quoted");
    expect(
      changed.payerStore.localExecutionCommitmentFor(
        changed.intent.record_id,
        changed.payerNode.authority.key_id,
      ),
    ).toBeNull();
    changed.merchantDb.close();
  });

  it("keeps an ambiguous broadcast unresendable and reports it without a second send", async () => {
    const fixture = await executionFixture({ sendMode: "ambiguous" });
    const prepared = await fixture.service.prepare({
      intent_record_id: fixture.intent.record_id,
      account_id: fixture.accountId,
    });
    const result = await fixture.service.confirm({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
    });
    expect(result).toMatchObject({
      status: "broadcast_unknown",
      tx_hash: fixture.rail.txid,
    });
    expect(result.error).toMatch(/outcome is unknown/i);
    expect(paymentStatus(prepared.review.payment_id)).toBe("confirmed");
    expect(fixture.rail.sendCalls).toBe(1);
    expect(
      fixture.service.status({
        payment_id: prepared.review.payment_id,
        review_id: prepared.review.review_id,
      }),
    ).toEqual({
      ...result,
      intent_record_id: fixture.intent.record_id,
      can_confirm: false,
    });
    expect(fixture.rail.compilerCalls).toBe(1);
    expect(fixture.rail.sendCalls).toBe(1);
    expect(
      db.query(
        "SELECT id FROM transactions WHERE external_id = ?",
      ).get(fixture.rail.txid),
    ).toBeNull();

    const retry = await fixture.service.confirm({
      payment_id: prepared.review.payment_id,
      review_id: prepared.review.review_id,
    });
    expect(retry.status).toBe("broadcast_unknown");
    expect(retry.tx_hash).toBe(fixture.rail.txid);
    expect(fixture.rail.sendCalls).toBe(1);
    fixture.merchantDb.close();
  });

  it("fails recovery closed when mutable payment outcome fields disagree with the exact review", async () => {
    const terms = await executionFixture();
    const termsPrepared = await terms.service.prepare({
      intent_record_id: terms.intent.record_id,
      account_id: terms.accountId,
    });
    db.query(
      "UPDATE payments SET amount_minor = '25001' WHERE id = ?",
    ).run(termsPrepared.review.payment_id);
    let termsError: unknown;
    try {
      terms.service.status({
        payment_id: termsPrepared.review.payment_id,
        review_id: termsPrepared.review.review_id,
      });
    } catch (error) {
      termsError = error;
    }
    expect(termsError).toMatchObject({ code: "STORAGE_INTEGRITY_FAILURE" });
    expect(terms.rail.compilerCalls).toBe(0);
    expect(terms.rail.sendCalls).toBe(0);
    terms.merchantDb.close();

    const outcome = await executionFixture();
    const outcomePrepared = await outcome.service.prepare({
      intent_record_id: outcome.intent.record_id,
      account_id: outcome.accountId,
    });
    db.query(
      "UPDATE payments SET status = 'broadcast', tx_hash = NULL WHERE id = ?",
    ).run(outcomePrepared.review.payment_id);
    let outcomeError: unknown;
    try {
      outcome.service.status({
        payment_id: outcomePrepared.review.payment_id,
        review_id: outcomePrepared.review.review_id,
      });
    } catch (error) {
      outcomeError = error;
    }
    expect(outcomeError).toMatchObject({ code: "STORAGE_INTEGRITY_FAILURE" });
    expect(outcome.rail.compilerCalls).toBe(0);
    expect(outcome.rail.sendCalls).toBe(0);
    outcome.merchantDb.close();

    const forged = await executionFixture();
    const forgedPrepared = await forged.service.prepare({
      intent_record_id: forged.intent.record_id,
      account_id: forged.accountId,
    });
    db.query(
      "UPDATE payments SET status = 'broadcast', tx_hash = ? WHERE id = ?",
    ).run("f".repeat(64), forgedPrepared.review.payment_id);
    let forgedError: unknown;
    try {
      forged.service.status({
        payment_id: forgedPrepared.review.payment_id,
        review_id: forgedPrepared.review.review_id,
      });
    } catch (error) {
      forgedError = error;
    }
    expect(forgedError).toMatchObject({
      code: "STORAGE_INTEGRITY_FAILURE",
    });
    expect(forged.rail.compilerCalls).toBe(0);
    expect(forged.rail.sendCalls).toBe(0);
    forged.merchantDb.close();

    const wrongTxid = await executionFixture();
    const wrongTxidPrepared = await wrongTxid.service.prepare({
      intent_record_id: wrongTxid.intent.record_id,
      account_id: wrongTxid.accountId,
    });
    await wrongTxid.service.confirm({
      payment_id: wrongTxidPrepared.review.payment_id,
      review_id: wrongTxidPrepared.review.review_id,
    });
    db.query(
      "UPDATE payments SET tx_hash = ? WHERE id = ?",
    ).run("e".repeat(64), wrongTxidPrepared.review.payment_id);
    let wrongTxidError: unknown;
    try {
      wrongTxid.service.status({
        payment_id: wrongTxidPrepared.review.payment_id,
        review_id: wrongTxidPrepared.review.review_id,
      });
    } catch (error) {
      wrongTxidError = error;
    }
    expect(wrongTxidError).toMatchObject({
      code: "STORAGE_INTEGRITY_FAILURE",
    });
    expect(wrongTxid.rail.sendCalls).toBe(1);
    wrongTxid.merchantDb.close();
  });

});
