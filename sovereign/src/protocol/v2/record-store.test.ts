import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  canonicalJsonBytes,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
  type Sha256Id,
} from "@agenttool/wallet";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
} from "./asset-trust.ts";

import {
  CashLoomV2RecordStore,
  V2RecordStoreError,
  type RemoteIngestLimits,
  type V2RecordStoreErrorCode,
} from "./record-store.ts";
import {
  createExecutionCommitment,
  createNodeDescriptor,
  createPaymentIntent,
  createPaymentRequest,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  type NodeDescriptorCore,
  type PaymentRequestCore,
  type SelfCertifyingAuthority,
  type VerifiedV2Record,
} from "./records.ts";
import { installCashLoomV2Schema } from "./schema.ts";

interface TestAuthority {
  authority: SelfCertifyingAuthority;
  signer: RecordSigner;
}

interface WorkerResult {
  ok: boolean;
  inserted?: boolean;
  recordId?: string;
  canonicalBytes?: number;
  code?: string;
  message?: string;
}

const NOW = "2030-01-01T12:00:00.000Z";
const GENEROUS_LIMITS = Object.freeze({
  maxRecordCount: 1_000,
  maxCanonicalBytes: 16 * 1024 * 1024,
});
const ASSET =
  "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FEE_ASSET = "eip155:8453/slip44:60";
const MERCHANT_ACCOUNT =
  "eip155:8453:0x2222222222222222222222222222222222222222";
const PAYER_ACCOUNT =
  "eip155:8453:0x1111111111111111111111111111111111111111";

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

const merchant = await testAuthority(21);
const payer = await testAuthority(22);
const stranger = await testAuthority(23);
const trustBinding = (authorityKeyId: Sha256Id, label: string) => ({
  manifest_record_id: sha256Id({ manifest: label }),
  manifest_authority_key_id: authorityKeyId,
  policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
  policy_hash: assetTrustPolicyHash(FAIL_CLOSED_ASSET_TRUST_POLICY),
});

function nonce(serial: number): string {
  const entropy = new Uint8Array(16);
  new DataView(entropy.buffer).setUint32(12, serial);
  return v2Nonce(entropy);
}

function offset(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function descriptor(
  owner: TestAuthority,
  serial: number,
  issuedAt = "2030-01-01T00:00:00.000Z",
): Promise<VerifiedV2Record<NodeDescriptorCore>> {
  return signV2Record(
    createNodeDescriptor({
      authority: owner.authority,
      audience: "public",
      disclosure: "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: offset(issuedAt, 7 * 24 * 60 * 60 * 1_000),
      parent_record_id: null,
      roles: ["merchant"],
      endpoints: [
        { rel: "record_read", path: `/v2/records/${serial}/{record_id}` },
        { rel: "records_ingest", path: `/v2/records/${serial}` },
      ],
    }),
    owner.signer,
  );
}

async function request(
  parent: VerifiedV2Record<NodeDescriptorCore>,
  issuer: TestAuthority,
  serial: number,
  options: {
    audience?: "public" | Sha256Id;
    disclosure?: "public" | "private";
    parentRecordId?: Sha256Id;
  } = {},
): Promise<VerifiedV2Record<PaymentRequestCore>> {
  const issuedAt = offset(parent.issued_at, 60_000);
  return signV2Record(
    createPaymentRequest({
      authority: issuer.authority,
      audience: options.audience ?? payer.authority.key_id,
      disclosure: options.disclosure ?? "public",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: offset(issuedAt, 60 * 60 * 1_000),
      parent_record_id: options.parentRecordId ?? parent.record_id,
      rail: "evm-base",
      destination: MERCHANT_ACCOUNT,
      asset_id: ASSET,
      amount_atomic: "2500000",
      purpose_hash: sha256Id({ order: serial }),
      asset_trust: trustBinding(issuer.authority.key_id, `request-${serial}`),
    }),
    issuer.signer,
  );
}

async function intent(
  parent: VerifiedV2Record<PaymentRequestCore>,
  issuer: TestAuthority,
  serial: number,
  disclosure: "public" | "private" = "private",
) {
  const issuedAt = offset(parent.issued_at, 60_000);
  return signV2Record(
    createPaymentIntent({
      authority: issuer.authority,
      audience: parent.authority.key_id,
      disclosure,
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: offset(issuedAt, 5 * 60 * 1_000),
      parent_record_id: parent.record_id,
      rail: parent.rail,
      destination: parent.destination,
      source_account: PAYER_ACCOUNT,
      asset_id: ASSET,
      amount_atomic: parent.amount_atomic,
      fee_asset_id: FEE_ASSET,
      fee_limit_scope: "total_fee_asset_exposure",
      max_fee_atomic: "50000000000000",
      payment_asset_trust: trustBinding(
        issuer.authority.key_id,
        `payment-${serial}`,
      ),
      fee_asset_trust: trustBinding(
        issuer.authority.key_id,
        `fee-${serial}`,
      ),
    }),
    issuer.signer,
  );
}

async function commitment(
  parent: Awaited<ReturnType<typeof intent>>,
  issuer: TestAuthority,
  serial: number,
) {
  const issuedAt = offset(parent.issued_at, 60_000);
  return signV2Record(
    createExecutionCommitment({
      authority: issuer.authority,
      audience: parent.audience,
      disclosure: "private",
      nonce: nonce(serial),
      issued_at: issuedAt,
      expires_at: offset(issuedAt, 5 * 60 * 1_000),
      parent_record_id: parent.record_id,
      rail: parent.rail,
      source_account: parent.source_account,
      destination: parent.destination,
      asset_id: parent.asset_id,
      amount_atomic: parent.amount_atomic,
      fee_asset_id: parent.fee_asset_id,
      fee_limit_scope: parent.fee_limit_scope,
      max_fee_atomic: parent.max_fee_atomic,
      reservation_id: sha256Id({ reservation: serial }),
      unsigned_payload_hash: sha256Id({ unsigned: serial }),
    }),
    issuer.signer,
  );
}

function freshDatabase(path = ":memory:"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  installCashLoomV2Schema(db);
  return db;
}

function storeFor(
  db: Database,
  localNodeKeyId: Sha256Id | null = merchant.authority.key_id,
  remoteLimits: RemoteIngestLimits = GENEROUS_LIMITS,
): CashLoomV2RecordStore {
  return new CashLoomV2RecordStore({
    db,
    localNodeKeyId,
    remoteLimits,
    now: () => NOW,
  });
}

function expectStoreError(
  operation: () => unknown,
  code: V2RecordStoreErrorCode,
): V2RecordStoreError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(V2RecordStoreError);
    expect((error as V2RecordStoreError).code).toBe(code);
    return error as V2RecordStoreError;
  }
  throw new Error(`Expected V2RecordStoreError(${code}).`);
}

function recordCount(db: Database): number {
  return (
    db.query("SELECT count(*) AS count FROM cashloom_v2_records").get() as {
      count: number;
    }
  ).count;
}

const WORKER_SOURCE = `
import { Database } from "bun:sqlite";
const { CashLoomV2RecordStore } = await import(process.env.TEST_STORE_URL);
const db = new Database(process.env.TEST_DB_PATH);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
const store = new CashLoomV2RecordStore({
  db,
  localNodeKeyId: process.env.TEST_LOCAL_KEY_ID,
  remoteLimits: {
    maxRecordCount: Number(process.env.TEST_MAX_RECORDS),
    maxCanonicalBytes: Number(process.env.TEST_MAX_BYTES),
  },
  now: () => "2030-01-01T12:00:00.000Z",
});
try {
  const result = store.append(
    Uint8Array.from(Buffer.from(process.env.TEST_RECORD_BASE64, "base64")),
    "remote",
  );
  console.log(JSON.stringify({
    ok: true,
    inserted: result.inserted,
    recordId: result.record.record_id,
    canonicalBytes: result.canonicalBytes,
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    code: error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
  }));
} finally {
  db.close();
}
`;

async function appendInWorker(
  dbPath: string,
  recordBytes: Uint8Array,
  limits: RemoteIngestLimits,
  localNodeKeyId: Sha256Id = merchant.authority.key_id,
): Promise<WorkerResult> {
  const processHandle = Bun.spawn([process.execPath, "-e", WORKER_SOURCE], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      TEST_STORE_URL: pathToFileURL(join(import.meta.dir, "record-store.ts")).href,
      TEST_DB_PATH: dbPath,
      TEST_LOCAL_KEY_ID: localNodeKeyId,
      TEST_MAX_RECORDS: String(limits.maxRecordCount),
      TEST_MAX_BYTES: String(limits.maxCanonicalBytes),
      TEST_RECORD_BASE64: Buffer.from(recordBytes).toString("base64"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`record-store worker exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout.trim()) as WorkerResult;
}

describe("CashLoom v2 append-only record store", () => {
  test("verifies the exact canonical Uint8Array before opening a transaction", async () => {
    const record = await descriptor(merchant, 101);
    let transactionOpened = false;
    const db = {
      transaction() {
        transactionOpened = true;
        throw new Error("transaction must not open");
      },
    } as unknown as Database;
    const store = storeFor(db);

    const nonCanonical = new TextEncoder().encode(JSON.stringify(record, null, 2));
    expect(() => store.append(nonCanonical, "local")).toThrow(/canonical/i);
    expect(transactionOpened).toBe(false);

    const uppercaseId = canonicalJsonBytes({
      ...record,
      record_id: record.record_id.toUpperCase(),
    });
    expect(() => store.append(uppercaseId, "local")).toThrow(/sha256|record_id/i);
    expect(transactionOpened).toBe(false);
  });

  test("appends exact bytes idempotently and exposes no enumeration surface", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const record = await descriptor(merchant, 102);
    const bytes = v2RecordBytes(record);

    const first = store.append(bytes, "remote");
    const duplicate = store.append(bytes, "remote");

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.source).toBe("remote");
    expect(recordCount(db)).toBe(1);
    expect(store.remoteUsage()).toEqual({
      remoteRecordCount: 1,
      remoteCanonicalBytes: bytes.byteLength,
    });
    expect(store.getLocal(record.record_id)?.record_id).toBe(record.record_id);
    expect(store.getPublic(record.record_id)?.record_id).toBe(record.record_id);
    expect(
      (store as unknown as Record<string, unknown>).list,
    ).toBeUndefined();
    db.close();
  });

  test("rejects a different record bound to the same issuer nonce", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const first = await descriptor(merchant, 103, "2030-01-01T00:00:00.000Z");
    const conflict = await descriptor(merchant, 103, "2030-01-02T00:00:00.000Z");

    store.append(v2RecordBytes(first), "local");
    expectStoreError(
      () => store.append(v2RecordBytes(conflict), "local"),
      "ISSUER_NONCE_CONFLICT",
    );
    expect(recordCount(db)).toBe(1);
    expect(store.getLocal(conflict.record_id)).toBeNull();
    db.close();
  });

  test("requires parents first and validates the signed immediate link", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const root = await descriptor(merchant, 104);
    const child = await request(root, merchant, 105);

    expectStoreError(
      () => store.append(v2RecordBytes(child), "local"),
      "PARENT_NOT_FOUND",
    );
    expect(recordCount(db)).toBe(0);

    store.append(v2RecordBytes(root), "local");
    store.append(v2RecordBytes(child), "local");
    expect(
      (
        db.query(
          "SELECT parent_record_id FROM cashloom_v2_record_parents"
            + " WHERE child_record_id = ?",
        ).get(child.record_id) as { parent_record_id: string }
      ).parent_record_id,
    ).toBe(root.record_id);

    const wrongRoot = await descriptor(stranger, 106);
    const badLink = await request(wrongRoot, merchant, 107);
    store.append(v2RecordBytes(wrongRoot), "local");
    expect(() => store.append(v2RecordBytes(badLink), "local")).toThrow(
      /authority/i,
    );
    expect(store.getLocal(badLink.record_id)).toBeNull();
    db.close();
  });

  test("atomically refuses competing execution successors while retaining exact idempotency", async () => {
    const db = freshDatabase();
    const store = storeFor(db, merchant.authority.key_id);
    const root = await descriptor(merchant, 180);
    const paymentRequest = await request(root, merchant, 181);
    const paymentIntent = await intent(paymentRequest, payer, 182);
    const first = await commitment(paymentIntent, payer, 183);
    const conflict = await commitment(paymentIntent, payer, 184);

    store.append(v2RecordBytes(root), "local");
    store.append(v2RecordBytes(paymentRequest), "local");
    store.append(v2RecordBytes(paymentIntent), "remote");
    expect(store.append(v2RecordBytes(first), "remote").inserted).toBe(true);
    expect(store.append(v2RecordBytes(first), "remote").inserted).toBe(false);
    expectStoreError(
      () => store.append(v2RecordBytes(conflict), "remote"),
      "TRANSITION_CONFLICT",
    );
    expect(store.getLocal(conflict.record_id)).toBeNull();
    db.close();
  });

  test("allows different payers but refuses a second intent from the same payer", async () => {
    const db = freshDatabase();
    const store = storeFor(db, merchant.authority.key_id);
    const root = await descriptor(merchant, 185);
    const publicRequest = await request(root, merchant, 186, {
      audience: "public",
    });
    const first = await intent(publicRequest, payer, 187);
    const retry = await intent(publicRequest, payer, 188);
    const otherPayer = await intent(publicRequest, stranger, 189);

    store.append(v2RecordBytes(root), "local");
    store.append(v2RecordBytes(publicRequest), "local");
    store.append(v2RecordBytes(first), "remote");
    expectStoreError(
      () => store.append(v2RecordBytes(retry), "remote"),
      "TRANSITION_CONFLICT",
    );
    expect(store.append(v2RecordBytes(otherPayer), "remote").inserted).toBe(
      true,
    );
    db.close();
  });

  test("refuses a public child whose stored parent is private", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const root = await descriptor(merchant, 108);
    const privateRequest = await request(root, merchant, 109, {
      disclosure: "private",
    });
    const publicIntent = await intent(privateRequest, payer, 110, "public");

    store.append(v2RecordBytes(root), "local");
    store.append(v2RecordBytes(privateRequest), "local");
    expect(() => store.append(v2RecordBytes(publicIntent), "local")).toThrow(
      /public record cannot depend on a private parent/i,
    );
    expect(store.getLocal(publicIntent.record_id)).toBeNull();
    db.close();
  });

  test("admits a remote private record only for the local audience", async () => {
    const db = freshDatabase();
    const store = storeFor(db, payer.authority.key_id);
    const root = await descriptor(merchant, 111);
    const addressedHere = await request(root, merchant, 112, {
      audience: payer.authority.key_id,
      disclosure: "private",
    });
    const addressedElsewhere = await request(root, merchant, 113, {
      audience: stranger.authority.key_id,
      disclosure: "private",
    });

    store.append(v2RecordBytes(root), "remote");
    expect(store.append(v2RecordBytes(addressedHere), "remote").inserted).toBe(
      true,
    );
    expectStoreError(
      () => store.append(v2RecordBytes(addressedElsewhere), "remote"),
      "PRIVATE_AUDIENCE_MISMATCH",
    );
    expect(store.getLocal(addressedHere.record_id)?.record_id).toBe(
      addressedHere.record_id,
    );
    expect(store.getPublic(addressedHere.record_id)).toBeNull();
    expect(store.getLocal(addressedElsewhere.record_id)).toBeNull();
    expect(store.remoteUsage().remoteRecordCount).toBe(2);

    // A locally created private record is not remote ingress and may target a
    // different participant while remaining available only to local callers.
    expect(store.append(v2RecordBytes(addressedElsewhere), "local").inserted).toBe(
      true,
    );
    expect(store.append(v2RecordBytes(addressedElsewhere), "remote")).toMatchObject({
      inserted: false,
      source: "local",
    });
    expect(store.remoteUsage().remoteRecordCount).toBe(2);
    expect(store.getPublic(addressedElsewhere.record_id)).toBeNull();
    db.close();
  });

  test("fails closed on every remote private record before node activation", async () => {
    const db = freshDatabase();
    const store = storeFor(db, null);
    const root = await descriptor(merchant, 130);
    const privateRequest = await request(root, merchant, 131, {
      audience: payer.authority.key_id,
      disclosure: "private",
    });

    store.append(v2RecordBytes(root), "remote");
    expectStoreError(
      () => store.append(v2RecordBytes(privateRequest), "remote"),
      "PRIVATE_AUDIENCE_MISMATCH",
    );
    expect(store.latestPublicNodeDescriptor()).toBeNull();
    expect(store.getLocal(privateRequest.record_id)).toBeNull();
    db.close();
  });

  test("updates global remote count and byte caps atomically", async () => {
    const first = await descriptor(merchant, 114);
    const second = await descriptor(merchant, 115);
    const firstBytes = v2RecordBytes(first);
    const secondBytes = v2RecordBytes(second);

    const countDb = freshDatabase();
    const countStore = storeFor(countDb, merchant.authority.key_id, {
      maxRecordCount: 1,
      maxCanonicalBytes: 1_000_000,
    });
    countStore.append(firstBytes, "remote");
    expectStoreError(
      () => countStore.append(secondBytes, "remote"),
      "REMOTE_LIMIT_EXCEEDED",
    );
    expect(countStore.remoteUsage()).toEqual({
      remoteRecordCount: 1,
      remoteCanonicalBytes: firstBytes.byteLength,
    });
    expect(recordCount(countDb)).toBe(1);
    countDb.close();

    const byteDb = freshDatabase();
    const byteStore = storeFor(byteDb, merchant.authority.key_id, {
      maxRecordCount: 10,
      maxCanonicalBytes: firstBytes.byteLength,
    });
    byteStore.append(firstBytes, "remote");
    expectStoreError(
      () => byteStore.append(secondBytes, "remote"),
      "REMOTE_LIMIT_EXCEEDED",
    );
    expect(byteStore.remoteUsage()).toEqual({
      remoteRecordCount: 1,
      remoteCanonicalBytes: firstBytes.byteLength,
    });
    expect(recordCount(byteDb)).toBe(1);
    byteDb.close();
  });

  test("does not charge local evidence against the remote admission budget", async () => {
    const db = freshDatabase();
    const store = storeFor(db, merchant.authority.key_id, {
      maxRecordCount: 0,
      maxCanonicalBytes: 0,
    });
    const local = await descriptor(merchant, 116);
    const remote = await descriptor(stranger, 117);

    store.append(v2RecordBytes(local), "local");
    expectStoreError(
      () => store.append(v2RecordBytes(remote), "remote"),
      "REMOTE_LIMIT_EXCEEDED",
    );
    expect(store.remoteUsage()).toEqual({
      remoteRecordCount: 0,
      remoteCanonicalBytes: 0,
    });
    expect(recordCount(db)).toBe(1);
    db.close();
  });

  test("returns only the latest local public node descriptor", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const oldLocal = await descriptor(
      merchant,
      118,
      "2030-01-01T00:00:00.000Z",
    );
    const newLocal = await descriptor(
      merchant,
      119,
      "2030-01-02T00:00:00.000Z",
    );
    const newerRemote = await descriptor(
      stranger,
      120,
      "2030-01-03T00:00:00.000Z",
    );

    store.append(v2RecordBytes(oldLocal), "local");
    store.append(v2RecordBytes(newerRemote), "remote");
    store.append(v2RecordBytes(newLocal), "local");

    expect(store.latestPublicNodeDescriptor()?.record_id).toBe(
      newLocal.record_id,
    );
    db.close();
  });

  test("enforces strict sha256 IDs at construction and lookup boundaries", async () => {
    const db = freshDatabase();
    const record = await descriptor(merchant, 121);
    const store = storeFor(db);
    store.append(v2RecordBytes(record), "local");

    expect(() => store.getLocal(record.record_id.toUpperCase())).toThrow(
      /sha256/i,
    );
    expect(() => store.getPublic("sha256:abc")).toThrow(/sha256/i);
    expect(
      () =>
        new CashLoomV2RecordStore({
          db,
          localNodeKeyId: "sha256:abc",
          remoteLimits: GENEROUS_LIMITS,
        }),
    ).toThrow(/sha256/i);
    db.close();
  });

  test("database triggers reject record and parent-edge mutation", async () => {
    const db = freshDatabase();
    const store = storeFor(db);
    const root = await descriptor(merchant, 122);
    const child = await request(root, merchant, 123);
    store.append(v2RecordBytes(root), "local");
    store.append(v2RecordBytes(child), "local");

    expect(() =>
      db.query(
        "UPDATE cashloom_v2_records SET received_at = received_at"
          + " WHERE record_id = ?",
      ).run(root.record_id)
    ).toThrow(/append-only/i);
    expect(() =>
      db.query("DELETE FROM cashloom_v2_records WHERE record_id = ?").run(
        child.record_id,
      )
    ).toThrow(/append-only/i);
    expect(() =>
      db.query(
        "UPDATE cashloom_v2_record_parents SET position = position"
          + " WHERE child_record_id = ?",
      ).run(child.record_id)
    ).toThrow(/append-only/i);
    expect(() =>
      db.query(
        "DELETE FROM cashloom_v2_record_parents WHERE child_record_id = ?",
      ).run(child.record_id)
    ).toThrow(/append-only/i);
    expect(recordCount(db)).toBe(2);
    db.close();
  });

  test("serializes concurrent issuer+nonce conflicts with BEGIN IMMEDIATE", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cashloom-v2-nonce-"));
    const dbPath = join(tempDir, "records.db");
    const setupDb = freshDatabase(dbPath);
    setupDb.exec("PRAGMA journal_mode = WAL;");
    setupDb.close();

    try {
      const first = await descriptor(
        merchant,
        124,
        "2030-01-01T00:00:00.000Z",
      );
      const conflict = await descriptor(
        merchant,
        124,
        "2030-01-02T00:00:00.000Z",
      );
      const [left, right] = await Promise.all([
        appendInWorker(dbPath, v2RecordBytes(first), GENEROUS_LIMITS),
        appendInWorker(dbPath, v2RecordBytes(conflict), GENEROUS_LIMITS),
      ]);
      const results = [left, right];

      expect(results.filter(({ ok }) => ok)).toHaveLength(1);
      expect(
        results.filter(({ code }) => code === "ISSUER_NONCE_CONFLICT"),
      ).toHaveLength(1);

      const inspectDb = new Database(dbPath);
      const inspectStore = storeFor(inspectDb);
      expect(recordCount(inspectDb)).toBe(1);
      expect(inspectStore.remoteUsage().remoteRecordCount).toBe(1);
      inspectDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("serializes concurrent global-cap admission without overshoot", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cashloom-v2-cap-"));
    const dbPath = join(tempDir, "records.db");
    const setupDb = freshDatabase(dbPath);
    setupDb.exec("PRAGMA journal_mode = WAL;");
    setupDb.close();

    try {
      const first = await descriptor(merchant, 125);
      const second = await descriptor(stranger, 126);
      const limits = { maxRecordCount: 1, maxCanonicalBytes: 1_000_000 };
      const [left, right] = await Promise.all([
        appendInWorker(dbPath, v2RecordBytes(first), limits),
        appendInWorker(dbPath, v2RecordBytes(second), limits),
      ]);
      const results = [left, right];

      expect(results.filter(({ ok }) => ok)).toHaveLength(1);
      expect(
        results.filter(({ code }) => code === "REMOTE_LIMIT_EXCEEDED"),
      ).toHaveLength(1);

      const winner = results.find(({ ok }) => ok)!;
      const inspectDb = new Database(dbPath);
      const inspectStore = storeFor(inspectDb);
      expect(recordCount(inspectDb)).toBe(1);
      expect(inspectStore.remoteUsage()).toEqual({
        remoteRecordCount: 1,
        remoteCanonicalBytes: winner.canonicalBytes!,
      });
      inspectDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
