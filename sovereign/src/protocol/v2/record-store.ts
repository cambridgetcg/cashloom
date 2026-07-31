/**
 * Append-only persistence for verified CashLoom v2 records.
 *
 * This store deliberately has no list operation. A caller may retrieve a
 * record it already knows by content ID, retrieve this node's latest public
 * descriptor, or append exact canonical bytes. Private records never cross
 * the public getter.
 */

import type { Database } from "bun:sqlite";
import {
  assertSha256Id,
  assertTimestamp,
  type Sha256Id,
} from "@agenttool/wallet";

import {
  V2_SCHEMAS,
  verifyV2Record,
  verifyV2RecordLink,
  type ExecutionCommitmentCore,
  type NodeDescriptorCore,
  type PaymentIntentCore,
  type V2Schema,
  type VerifiedV2Record,
} from "./records.ts";

export type V2RecordSource = "local" | "remote";

export interface RemoteIngestLimits {
  /** Maximum number of distinct records first admitted from remote peers. */
  maxRecordCount: number;
  /** Maximum aggregate byte length of their exact canonical encodings. */
  maxCanonicalBytes: number;
}

export interface V2RecordStoreOptions {
  db: Database;
  /**
   * Null before this sovereign node has activated an authority. Public
   * records may still be mirrored, but private remote records fail closed.
   */
  localNodeKeyId: Sha256Id | string | null;
  remoteLimits: RemoteIngestLimits;
  /** Injectable only for deterministic receipt timestamps. */
  now?: () => string;
}

export interface AppendV2RecordResult {
  record: VerifiedV2Record;
  inserted: boolean;
  canonicalBytes: number;
  source: V2RecordSource;
}

export interface AppendV2RecordInput {
  canonicalBytes: Uint8Array;
  source: V2RecordSource;
}

export interface RemoteIngestUsage {
  remoteRecordCount: number;
  remoteCanonicalBytes: number;
}

export type V2RecordStoreErrorCode =
  | "INVALID_CONFIGURATION"
  | "PRIVATE_AUDIENCE_MISMATCH"
  | "ISSUER_NONCE_CONFLICT"
  | "PARENT_NOT_FOUND"
  | "TRANSITION_CONFLICT"
  | "REMOTE_LIMIT_EXCEEDED"
  | "STORAGE_INTEGRITY_FAILURE";

export class V2RecordStoreError extends Error {
  readonly code: V2RecordStoreErrorCode;

  constructor(code: V2RecordStoreErrorCode, message: string) {
    super(message);
    this.name = "V2RecordStoreError";
    this.code = code;
  }
}

type V2RecordKind = keyof typeof V2_SCHEMAS;

interface StoredRecordRow {
  canonical_json: string;
  source: V2RecordSource;
}

interface IndexedStoredRecordRow extends StoredRecordRow {
  record_id: string;
  schema: string;
  issuer_key_id: string;
}

interface LocalCommitmentRow extends IndexedStoredRecordRow {
  parent_record_id: string;
  parent_index_record_id: string;
  parent_schema: string;
  parent_issuer_key_id: string;
  parent_canonical_json: string;
  parent_source: V2RecordSource;
}

interface NonceRow {
  record_id: string;
}

interface ChildRow {
  record_id: string;
}

interface UsageRow {
  remote_record_count: number;
  remote_canonical_bytes: number;
}

const KIND_BY_SCHEMA: Readonly<Record<V2Schema, V2RecordKind>> = Object.freeze({
  [V2_SCHEMAS.node_descriptor]: "node_descriptor",
  [V2_SCHEMAS.payment_request]: "payment_request",
  [V2_SCHEMAS.payment_intent]: "payment_intent",
  [V2_SCHEMAS.execution_commitment]: "execution_commitment",
  [V2_SCHEMAS.submission_receipt]: "submission_receipt",
  [V2_SCHEMAS.settlement_receipt]: "settlement_receipt",
  [V2_SCHEMAS.asset_trust_manifest]: "asset_trust_manifest",
});

const EXCLUSIVE_CHILD_SCHEMAS = new Set<V2Schema>([
  V2_SCHEMAS.execution_commitment,
  V2_SCHEMAS.submission_receipt,
  V2_SCHEMAS.settlement_receipt,
]);

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

function configurationError(message: string): never {
  throw new V2RecordStoreError("INVALID_CONFIGURATION", message);
}

function assertLimit(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    configurationError(`${path} must be a non-negative safe integer.`);
  }
}

function assertSource(source: string): asserts source is V2RecordSource {
  if (source !== "local" && source !== "remote") {
    configurationError("source must be either local or remote.");
  }
}

function storedRecord(canonicalJson: string): VerifiedV2Record {
  try {
    return verifyV2Record(textEncoder.encode(canonicalJson));
  } catch (cause) {
    const error = new V2RecordStoreError(
      "STORAGE_INTEGRITY_FAILURE",
      "A stored CashLoom v2 record no longer passes canonical verification.",
    );
    error.cause = cause;
    throw error;
  }
}

function indexedStoredRecord(
  row: IndexedStoredRecordRow,
  label: string,
): VerifiedV2Record {
  const record = storedRecord(row.canonical_json);
  if (
    (row.source !== "local" && row.source !== "remote")
    || record.record_id !== row.record_id
    || record.schema !== row.schema
    || record.authority.key_id !== row.issuer_key_id
  ) {
    throw new V2RecordStoreError(
      "STORAGE_INTEGRITY_FAILURE",
      `The ${label} index disagrees with its signed record.`,
    );
  }
  return record;
}

/**
 * A synchronous store matching bun:sqlite's transaction model.
 *
 * Every append validates a defensive copy of the exact incoming bytes before
 * opening the writer transaction. The transaction then serializes replay,
 * ancestry, quota, record, and parent-edge decisions with BEGIN IMMEDIATE.
 */
export class CashLoomV2RecordStore {
  readonly #db: Database;
  readonly #localNodeKeyId: Sha256Id | null;
  readonly #remoteLimits: Readonly<RemoteIngestLimits>;
  readonly #now: () => string;

  constructor(options: V2RecordStoreOptions) {
    if (options.localNodeKeyId !== null) {
      assertSha256Id(options.localNodeKeyId, "localNodeKeyId");
    }
    assertLimit(options.remoteLimits.maxRecordCount, "remoteLimits.maxRecordCount");
    assertLimit(options.remoteLimits.maxCanonicalBytes, "remoteLimits.maxCanonicalBytes");

    this.#db = options.db;
    this.#localNodeKeyId = options.localNodeKeyId as Sha256Id | null;
    this.#remoteLimits = Object.freeze({ ...options.remoteLimits });
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  append(canonicalBytes: Uint8Array, source: V2RecordSource): AppendV2RecordResult {
    if (!(canonicalBytes instanceof Uint8Array)) {
      configurationError("canonicalBytes must be a Uint8Array.");
    }
    assertSource(source);

    // Snapshot before any verification so a caller cannot mutate the bytes
    // between cryptographic verification and persistence.
    const exactBytes = Uint8Array.from(canonicalBytes);
    const record = verifyV2Record(exactBytes);
    const canonicalJson = fatalTextDecoder.decode(exactBytes);

    const receivedAt = this.#now();
    assertTimestamp(receivedAt, "receivedAt");

    const write = this.#db.transaction((): AppendV2RecordResult => {
      const byId = this.#db
        .query("SELECT canonical_json, source FROM cashloom_v2_records WHERE record_id = ?")
        .get(record.record_id) as StoredRecordRow | null;

      if (byId !== null) {
        if (byId.canonical_json !== canonicalJson) {
          throw new V2RecordStoreError(
            "STORAGE_INTEGRITY_FAILURE",
            "The record ID is already bound to different canonical bytes.",
          );
        }
        return {
          record,
          inserted: false,
          canonicalBytes: exactBytes.byteLength,
          source: byId.source,
        };
      }

      // Exact duplicates are idempotent even if they arrive through a
      // different door: the sender already possesses the signed bytes and no
      // new private material or quota is admitted. New remote private records
      // remain restricted to their named audience.
      if (
        source === "remote"
        && record.disclosure === "private"
        && (
          this.#localNodeKeyId === null
          || record.audience !== this.#localNodeKeyId
        )
      ) {
        throw new V2RecordStoreError(
          "PRIVATE_AUDIENCE_MISMATCH",
          "A remote private record may only be admitted by its named audience.",
        );
      }

      const byNonce = this.#db
        .query(
          "SELECT record_id FROM cashloom_v2_records"
            + " WHERE issuer_key_id = ? AND nonce = ?",
        )
        .get(record.authority.key_id, record.nonce) as NonceRow | null;

      if (byNonce !== null) {
        throw new V2RecordStoreError(
          "ISSUER_NONCE_CONFLICT",
          `Issuer nonce is already bound to ${byNonce.record_id}.`,
        );
      }

      if (record.parent_record_id !== null) {
        const parent = this.#db
          .query("SELECT canonical_json, source FROM cashloom_v2_records WHERE record_id = ?")
          .get(record.parent_record_id) as StoredRecordRow | null;
        if (parent === null) {
          throw new V2RecordStoreError(
            "PARENT_NOT_FOUND",
            `Parent record ${record.parent_record_id} must be admitted first.`,
          );
        }

        // Reverify the exact child bytes and exact stored parent bytes while
        // the writer lock prevents ancestry from changing under this decision.
        verifyV2RecordLink(exactBytes, textEncoder.encode(parent.canonical_json));

        // One payer key may create only one intent for a request. Different
        // payers may still answer a public request. Once consent advances into
        // execution evidence, each parent has one semantic successor. Exact
        // redelivery remains idempotent above.
        if (record.schema === V2_SCHEMAS.payment_intent) {
          const existingIntent = this.#db
            .query(
              `SELECT child.record_id
                 FROM cashloom_v2_record_parents AS edge
                 JOIN cashloom_v2_records AS child
                   ON child.record_id = edge.child_record_id
                WHERE edge.parent_record_id = ?
                  AND child.schema = ?
                  AND child.issuer_key_id = ?
                LIMIT 1`,
            )
            .get(
              record.parent_record_id,
              record.schema,
              record.authority.key_id,
            ) as ChildRow | null;
          if (existingIntent !== null) {
            throw new V2RecordStoreError(
              "TRANSITION_CONFLICT",
              `Payer already has intent ${existingIntent.record_id} for this request.`,
            );
          }
        } else if (EXCLUSIVE_CHILD_SCHEMAS.has(record.schema)) {
          const existingChild = this.#db
            .query(
              `SELECT child.record_id
                 FROM cashloom_v2_record_parents AS edge
                 JOIN cashloom_v2_records AS child
                   ON child.record_id = edge.child_record_id
                WHERE edge.parent_record_id = ?
                  AND child.schema = ?
                LIMIT 1`,
            )
            .get(record.parent_record_id, record.schema) as ChildRow | null;
          if (existingChild !== null) {
            throw new V2RecordStoreError(
              "TRANSITION_CONFLICT",
              `Parent already has ${record.schema} successor ${existingChild.record_id}.`,
            );
          }
        }
      }

      if (source === "remote") {
        const usage = this.#readUsageRow();
        const nextCount = usage.remote_record_count + 1;
        const nextBytes = usage.remote_canonical_bytes + exactBytes.byteLength;
        if (
          nextCount > this.#remoteLimits.maxRecordCount
          || nextBytes > this.#remoteLimits.maxCanonicalBytes
        ) {
          throw new V2RecordStoreError(
            "REMOTE_LIMIT_EXCEEDED",
            "The global remote-record admission budget is exhausted.",
          );
        }
      }

      this.#db
        .query(
          `INSERT INTO cashloom_v2_records
             (record_id, schema, kind, issuer_key_id, audience, nonce,
              disclosure, canonical_json, created_at, expires_at, source, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.record_id,
          record.schema,
          KIND_BY_SCHEMA[record.schema],
          record.authority.key_id,
          record.audience,
          record.nonce,
          record.disclosure,
          canonicalJson,
          record.issued_at,
          record.expires_at,
          source,
          receivedAt,
        );

      if (record.parent_record_id !== null) {
        this.#db
          .query(
            `INSERT INTO cashloom_v2_record_parents
               (child_record_id, position, parent_record_id)
             VALUES (?, 0, ?)`,
          )
          .run(record.record_id, record.parent_record_id);
      }

      if (source === "remote") {
        this.#db
          .query(
            `UPDATE cashloom_v2_ingest_usage
                SET remote_record_count = remote_record_count + 1,
                    remote_canonical_bytes = remote_canonical_bytes + ?,
                    updated_at = ?
              WHERE singleton = 1`,
          )
          .run(exactBytes.byteLength, receivedAt);
      }

      return {
        record,
        inserted: true,
        canonicalBytes: exactBytes.byteLength,
        source,
      };
    });

    return write.immediate();
  }

  /**
   * Verify every input before opening one outer writer transaction, then append
   * the whole ordered carrier atomically. `append()` uses nested savepoints
   * under Bun's transaction wrapper, so any later quota, nonce, ancestry, or
   * transition failure rolls the complete batch back.
   */
  appendBatch(
    entries: readonly AppendV2RecordInput[],
  ): readonly AppendV2RecordResult[] {
    if (!Array.isArray(entries)) {
      configurationError("entries must be an array.");
    }
    const prepared = entries.map((entry) => {
      if (
        entry === null
        || typeof entry !== "object"
        || !(entry.canonicalBytes instanceof Uint8Array)
      ) {
        return configurationError(
          "Every batch entry must contain canonical Uint8Array bytes.",
        );
      }
      assertSource(entry.source);
      const exactBytes = Uint8Array.from(entry.canonicalBytes);
      verifyV2Record(exactBytes);
      return Object.freeze({
        canonicalBytes: exactBytes,
        source: entry.source,
      });
    });

    const write = this.#db.transaction(() =>
      prepared.map((entry) =>
        this.append(entry.canonicalBytes, entry.source)));
    return Object.freeze(write.immediate());
  }

  /** Retrieve any locally-held record by a caller-supplied content ID. */
  getLocal(recordId: Sha256Id | string): VerifiedV2Record | null {
    assertSha256Id(recordId, "recordId");
    const row = this.#db
      .query("SELECT canonical_json, source FROM cashloom_v2_records WHERE record_id = ?")
      .get(recordId) as StoredRecordRow | null;
    return row === null ? null : storedRecord(row.canonical_json);
  }

  /**
   * Retry-safe lookup for the one local intent this issuer may create for a
   * known request. This is deliberately not an enumeration surface.
   */
  localPaymentIntentFor(
    requestRecordId: Sha256Id | string,
    issuerKeyId: Sha256Id | string,
  ): VerifiedV2Record<PaymentIntentCore> | null {
    assertSha256Id(requestRecordId, "requestRecordId");
    assertSha256Id(issuerKeyId, "issuerKeyId");
    const rows = this.#db
      .query(
        `SELECT child.canonical_json, child.source
           FROM cashloom_v2_record_parents AS edge
           JOIN cashloom_v2_records AS child
             ON child.record_id = edge.child_record_id
          WHERE edge.parent_record_id = ?
            AND child.schema = ?
            AND child.issuer_key_id = ?
            AND child.source = 'local'
          ORDER BY child.received_at, child.record_id
          LIMIT 2`,
      )
      .all(
        requestRecordId,
        V2_SCHEMAS.payment_intent,
        issuerKeyId,
      ) as StoredRecordRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "More than one local payment intent exists for the same request and issuer.",
      );
    }
    const record = storedRecord(rows[0]!.canonical_json);
    if (
      record.schema !== V2_SCHEMAS.payment_intent
      || record.parent_record_id !== requestRecordId
      || record.authority.key_id !== issuerKeyId
    ) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "The targeted local payment-intent index disagrees with its signed record.",
      );
    }
    return record as VerifiedV2Record<PaymentIntentCore>;
  }

  /**
   * Resolve one caller-known intent ID only when this node authored it with
   * the exact expected authority. Missing, remote, wrong-schema, and
   * wrong-authority records are intentionally indistinguishable.
   */
  localPaymentIntentById(
    recordId: Sha256Id | string,
    issuerKeyId: Sha256Id | string,
  ): VerifiedV2Record<PaymentIntentCore> | null {
    assertSha256Id(recordId, "recordId");
    assertSha256Id(issuerKeyId, "issuerKeyId");
    const row = this.#db
      .query(
        `SELECT record_id, schema, issuer_key_id, canonical_json, source
           FROM cashloom_v2_records
          WHERE record_id = ?`,
      )
      .get(recordId) as IndexedStoredRecordRow | null;
    if (row === null) return null;

    const record = indexedStoredRecord(row, "targeted payment-intent");
    if (
      row.source !== "local"
      || record.schema !== V2_SCHEMAS.payment_intent
      || record.authority.key_id !== issuerKeyId
    ) {
      return null;
    }
    return record as VerifiedV2Record<PaymentIntentCore>;
  }

  /**
   * Retry-safe lookup for the sole locally-authored execution commitment
   * under one known intent. This verifies the indexed edge and exact signed
   * parent/child link before returning it.
   */
  localExecutionCommitmentFor(
    intentRecordId: Sha256Id | string,
    issuerKeyId: Sha256Id | string,
  ): VerifiedV2Record<ExecutionCommitmentCore> | null {
    assertSha256Id(intentRecordId, "intentRecordId");
    assertSha256Id(issuerKeyId, "issuerKeyId");
    const rows = this.#db
      .query(
        `SELECT child.record_id,
                child.schema,
                child.issuer_key_id,
                child.canonical_json,
                child.source,
                edge.parent_record_id,
                parent.record_id AS parent_index_record_id,
                parent.schema AS parent_schema,
                parent.issuer_key_id AS parent_issuer_key_id,
                parent.canonical_json AS parent_canonical_json,
                parent.source AS parent_source
           FROM cashloom_v2_record_parents AS edge
           JOIN cashloom_v2_records AS child
             ON child.record_id = edge.child_record_id
          JOIN cashloom_v2_records AS parent
             ON parent.record_id = edge.parent_record_id
          WHERE edge.parent_record_id = ?
          ORDER BY child.received_at, child.record_id
          LIMIT 2`,
      )
      .all(intentRecordId) as LocalCommitmentRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "More than one execution successor exists for the same payment intent.",
      );
    }

    const row = rows[0]!;
    const commitment = indexedStoredRecord(
      row,
      "targeted execution-commitment",
    );
    const intent = indexedStoredRecord({
      record_id: row.parent_index_record_id,
      schema: row.parent_schema,
      issuer_key_id: row.parent_issuer_key_id,
      canonical_json: row.parent_canonical_json,
      source: row.parent_source,
    }, "targeted execution-commitment parent");
    if (
      row.parent_record_id !== intentRecordId
      || intent.record_id !== intentRecordId
      || intent.schema !== V2_SCHEMAS.payment_intent
      || commitment.schema !== V2_SCHEMAS.execution_commitment
      || commitment.parent_record_id !== intentRecordId
    ) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "The targeted local execution-commitment index disagrees with its signed ancestry.",
      );
    }
    try {
      verifyV2RecordLink(commitment, intent);
    } catch (cause) {
      const error = new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "The targeted local execution commitment no longer verifies against its signed intent.",
      );
      error.cause = cause;
      throw error;
    }
    if (
      row.source !== "local"
      || intent.authority.key_id !== issuerKeyId
      || commitment.authority.key_id !== issuerKeyId
    ) {
      return null;
    }
    return commitment as VerifiedV2Record<ExecutionCommitmentCore>;
  }

  /** Retrieve only records explicitly signed for public disclosure. */
  getPublic(recordId: Sha256Id | string): VerifiedV2Record | null {
    assertSha256Id(recordId, "recordId");
    const row = this.#db
      .query(
        "SELECT canonical_json, source FROM cashloom_v2_records"
          + " WHERE record_id = ? AND disclosure = 'public'",
      )
      .get(recordId) as StoredRecordRow | null;
    if (row === null) return null;

    const record = storedRecord(row.canonical_json);
    if (record.disclosure !== "public") {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "The public index disagrees with the record's signed disclosure.",
      );
    }
    return record;
  }

  /**
   * Return this local node's newest public descriptor.
   *
   * Remote descriptors are retained by ID but cannot replace the descriptor
   * served as this node's discovery root.
   */
  latestPublicNodeDescriptor(): VerifiedV2Record<NodeDescriptorCore> | null {
    if (this.#localNodeKeyId === null) return null;
    const row = this.#db
      .query(
        `SELECT canonical_json, source
           FROM cashloom_v2_records
          WHERE kind = 'node_descriptor'
            AND issuer_key_id = ?
            AND disclosure = 'public'
            AND source = 'local'
          ORDER BY created_at DESC, received_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(this.#localNodeKeyId) as StoredRecordRow | null;
    if (row === null) return null;

    const record = storedRecord(row.canonical_json);
    if (record.schema !== V2_SCHEMAS.node_descriptor) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "A node-descriptor index row contains the wrong signed schema.",
      );
    }
    return record as VerifiedV2Record<NodeDescriptorCore>;
  }

  remoteUsage(): RemoteIngestUsage {
    const usage = this.#readUsageRow();
    return Object.freeze({
      remoteRecordCount: usage.remote_record_count,
      remoteCanonicalBytes: usage.remote_canonical_bytes,
    });
  }

  #readUsageRow(): UsageRow {
    const usage = this.#db
      .query(
        `SELECT remote_record_count, remote_canonical_bytes
           FROM cashloom_v2_ingest_usage
          WHERE singleton = 1`,
      )
      .get() as UsageRow | null;

    if (
      usage === null
      || !Number.isSafeInteger(usage.remote_record_count)
      || usage.remote_record_count < 0
      || !Number.isSafeInteger(usage.remote_canonical_bytes)
      || usage.remote_canonical_bytes < 0
    ) {
      throw new V2RecordStoreError(
        "STORAGE_INTEGRITY_FAILURE",
        "The global remote-ingest usage row is missing or invalid.",
      );
    }
    return usage;
  }
}

export function createV2RecordStore(
  options: V2RecordStoreOptions,
): CashLoomV2RecordStore {
  return new CashLoomV2RecordStore(options);
}
