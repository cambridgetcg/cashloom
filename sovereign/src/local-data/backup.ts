/** Local, explicit-path database recovery. This module never imports the live
 * database, vault or server and never starts a service or runs migrations.
 * VACUUM INTO reads committed WAL pages through SQLite. The source connection
 * may create SQLite coordination sidecars or checkpoint committed WAL pages;
 * it does not change application records or run schema migrations. Each database is one
 * consistent snapshot; the optional sandbox is captured separately in time.
 * Hashes detect damage, not authorship. Backups contain private unencrypted
 * records plus sealed keys and signed artifacts; the vault passphrase is still
 * required. Restoring old state does not establish current chain truth. */
import { Database, constants as sqlite } from "bun:sqlite";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync,
  writeFileSync, writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { WALLET_KERNEL_TABLES } from "../wallet/infrastructure/sqlite/schema.ts";
import { WALLET_INTEGRATION_SCHEMA_VERSION, WALLET_INTEGRATION_TABLES } from "../wallet/infrastructure/sqlite/integration-schema.ts";
import { TCG_RECORD_TABLES, TCG_SIMULATION_TABLES } from "../tcg/schema.ts";

export const BACKUP_SCHEMA = "cashloom.local-backup/1" as const;
export const CONSISTENCY = "independent-sqlite-snapshots-not-cross-database-atomic" as const;
const NAMES = ["sovereign.db", "tcg-sandbox.db"] as const;
type DatabaseName = (typeof NAMES)[number];
const MANIFEST = "manifest.json";
const CURRENT_KERNEL_VERSION = 8;

export class LocalDataError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalDataError"; }
}
function refuse(code: string, message: string): never { throw new LocalDataError(code, message); }

export interface DatabaseReceipt {
  name: DatabaseName;
  bytes: number;
  sha256: string;
  schemaSha256: string;
  kernelVersion: number | null;
  integrationVersion: number | null;
  startedAt: string;
  completedAt: string;
}
export interface BackupManifest {
  schema: typeof BACKUP_SCHEMA;
  consistency: typeof CONSISTENCY;
  createdAt: string;
  databases: DatabaseReceipt[];
}

function directory(path: string, privateMode = false): string {
  if (!path.trim()) refuse("path_required", "An explicit directory path is required.");
  const full = resolve(path);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("unsafe_path", "The selected path must be a real directory, not a symlink.");
  if (privateMode && (stat.mode & 0o777) !== 0o700) refuse("unsafe_permissions", "Backup directories must have mode 0700.");
  return realpathSync(full);
}
function regularFile(path: string, privateMode = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse("unsafe_path", "Database and manifest files must be regular files without links.");
  if (privateMode && (stat.mode & 0o777) !== 0o600) refuse("unsafe_permissions", "Backup files must have mode 0600.");
  return stat;
}
function optionalFile(path: string): boolean {
  try { regularFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function checkSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) optionalFile(path + suffix);
}
function newDirectory(path: string, source: string): string {
  if (!path.trim()) refuse("path_required", "An explicit new target directory is required.");
  const full = resolve(path);
  // Resolve existing parent aliases such as macOS /tmp without accepting a
  // symlink as the selected destination or ever recursively creating parents.
  const parent = realpathSync(dirname(full));
  if (!lstatSync(parent).isDirectory()) refuse("unsafe_path", "The target parent must be a directory.");
  const canonicalTarget = join(parent, basename(full));
  if (canonicalTarget === source || canonicalTarget.startsWith(source + sep)) {
    refuse("overlapping_paths", "The target must be outside the source directory so source contents remain unchanged.");
  }
  try { mkdirSync(full, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("target_exists", "The target already exists. Choose a new directory; nothing was overwritten.");
    throw error;
  }
  chmodSync(full, 0o700);
  return realpathSync(full);
}
function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Stream through one no-follow handle. Used for hashing and restore copies;
 * no database content is returned, logged or materialized in a whole-file buffer. */
function copyAndHash(path: string, destination?: string): { bytes: number; sha256: string } {
  const before = regularFile(path, true);
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    if (opened.ino !== before.ino || opened.dev !== before.dev) refuse("file_changed", "A backup file changed while it was being opened.");
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const size = readSync(input, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size)); bytes += size;
      if (output !== undefined) {
        let written = 0;
        while (written < size) written += writeSync(output, buffer, written, size - written);
      }
    }
    const after = fstatSync(input);
    if (bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      refuse("file_changed", "A backup file changed during the operation.");
    }
    if (output !== undefined) fsyncSync(output);
    return { bytes, sha256: hash.digest("hex") };
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}

const LEGACY_COLUMNS: Record<string, readonly string[]> = {
  settings: ["key", "value"],
  vault_keys: ["id", "label", "kind", "address", "enc_blob", "created_at"],
  accounts: ["id", "currency", "decimals", "balance_minor", "balance_as_of", "chain_id", "asset_id", "account_ref", "vault_key_id", "status"],
  transactions: ["id", "account_id", "amount_minor", "date", "source"],
  payments: ["id", "account_id", "rail", "to_addr", "asset", "amount_minor", "status", "tx_hash", "detail"],
};

function inspectDatabase(path: string, name: DatabaseName): Pick<DatabaseReceipt, "schemaSha256" | "kernelVersion" | "integrationVersion"> {
  // Completed snapshots have no WAL. Immutable read-only mode prevents SQLite
  // from creating sidecars or changing the backup during verification.
  const url = pathToFileURL(path); url.searchParams.set("immutable", "1");
  const db = new Database(url.href, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_URI);
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
    const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || db.query("PRAGMA foreign_key_check").get()) {
      refuse("database_integrity", "SQLite integrity or foreign-key verification failed.");
    }
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const tables = new Set(schema.filter(row => row.type === "table").map(row => row.name));
    const required = name === "sovereign.db" ? [...Object.keys(LEGACY_COLUMNS), ...WALLET_KERNEL_TABLES, ...TCG_RECORD_TABLES] : [...TCG_SIMULATION_TABLES];
    if (required.some(table => !tables.has(table))) refuse("incompatible_schema", "This is not the supported CashLoom database schema; no migration was attempted.");
    let kernelVersion: number | null = null, integrationVersion: number | null = null;
    if (name === "sovereign.db") {
      if ([...tables].some(table => table.startsWith("tcg_sim_"))) refuse("incompatible_schema", "Wallet and simulation records must remain in separate databases.");
      for (const [table, expected] of Object.entries(LEGACY_COLUMNS)) {
        const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
        if (expected.some(column => !columns.has(column))) refuse("incompatible_schema", "Required CashLoom columns are missing; no migration was attempted.");
      }
      kernelVersion = (db.query("SELECT MAX(version) AS version FROM wk_schema_meta").get() as { version: number | null }).version;
      if (kernelVersion !== CURRENT_KERNEL_VERSION) refuse("incompatible_schema", "The wallet kernel schema version is unsupported; no migration was attempted.");
      if (WALLET_INTEGRATION_TABLES.some(table => tables.has(table))) {
        if (WALLET_INTEGRATION_TABLES.some(table => !tables.has(table))) refuse("incompatible_schema", "The optional integration schema is incomplete.");
        integrationVersion = (db.query("SELECT MAX(version) AS version FROM wk_integration_schema_meta").get() as { version: number | null }).version;
        if (integrationVersion !== WALLET_INTEGRATION_SCHEMA_VERSION) refuse("incompatible_schema", "The optional integration schema version is unsupported.");
      }
    } else if (tables.size !== TCG_SIMULATION_TABLES.length) {
      refuse("incompatible_schema", "The simulation backup must contain only the separate sandbox tables.");
    }
    return { schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), kernelVersion, integrationVersion };
  } finally { db.close(); }
}

function writeManifest(target: string, manifest: BackupManifest): void {
  const temporary = join(target, ".manifest.partial");
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  syncFile(temporary);
  renameSync(temporary, join(target, MANIFEST));
  syncDirectory(target);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function keysAre(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(",") === names.sort().join(",");
}
function parseManifest(source: string): BackupManifest {
  const path = join(source, MANIFEST);
  const stat = regularFile(path, true);
  if (stat.size > 64 * 1024) refuse("invalid_manifest", "The backup manifest exceeds its size limit.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("invalid_manifest", "The backup manifest is invalid.");
  const m = raw as Record<string, unknown>;
  if (!keysAre(m, ["schema", "consistency", "createdAt", "databases"]) || m.schema !== BACKUP_SCHEMA || m.consistency !== CONSISTENCY
    || !timestamp(m.createdAt) || !Array.isArray(m.databases) || m.databases.length < 1 || m.databases.length > 2) {
    refuse("invalid_manifest", "The backup format or version is unsupported.");
  }
  const names = new Set<string>();
  for (const entry of m.databases) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse("invalid_manifest", "A database receipt is invalid.");
    const d = entry as Record<string, unknown>;
    if (!keysAre(d, ["name", "bytes", "sha256", "schemaSha256", "kernelVersion", "integrationVersion", "startedAt", "completedAt"])
      || typeof d.name !== "string" || !(NAMES as readonly string[]).includes(d.name) || names.has(d.name)
      || !Number.isSafeInteger(d.bytes) || (d.bytes as number) < 512
      || typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256)
      || typeof d.schemaSha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.schemaSha256)
      || !(d.kernelVersion === null || d.kernelVersion === CURRENT_KERNEL_VERSION)
      || !(d.integrationVersion === null || d.integrationVersion === WALLET_INTEGRATION_SCHEMA_VERSION)
      || !timestamp(d.startedAt) || !timestamp(d.completedAt) || d.startedAt > d.completedAt || d.completedAt > m.createdAt) {
      refuse("invalid_manifest", "A database receipt is invalid or unsupported.");
    }
    names.add(d.name);
  }
  if (!names.has("sovereign.db")) refuse("invalid_manifest", "The wallet database is required.");
  const actual = readdirSync(source).sort();
  if (actual.join(",") !== [MANIFEST, ...names].sort().join(",")) refuse("unexpected_files", "The backup is incomplete or contains unexpected files or SQLite sidecars.");
  return m as unknown as BackupManifest;
}
function verifyReceipt(source: string, receipt: DatabaseReceipt): void {
  const path = join(source, receipt.name);
  const hash = copyAndHash(path);
  if (hash.bytes !== receipt.bytes || hash.sha256 !== receipt.sha256) refuse("hash_mismatch", "A backup database does not match its recorded length and hash.");
  const shape = inspectDatabase(path, receipt.name);
  if (shape.schemaSha256 !== receipt.schemaSha256 || shape.kernelVersion !== receipt.kernelVersion || shape.integrationVersion !== receipt.integrationVersion) {
    refuse("schema_mismatch", "A backup database does not match its schema receipt.");
  }
}

export function backupLocalData(sourcePath: string, targetPath: string): BackupManifest {
  const source = directory(sourcePath);
  // Inspect only fixed database names; unrelated files and credentials are never copied.
  regularFile(join(source, "sovereign.db"));
  const names = NAMES.filter(name => name === "sovereign.db" || optionalFile(join(source, name)));
  for (const name of names) checkSidecars(join(source, name));
  const target = newDirectory(targetPath, source);
  const databases: DatabaseReceipt[] = [];
  for (const name of names) {
    const inputPath = join(source, name), outputPath = join(target, name);
    const before = regularFile(inputPath);
    const startedAt = new Date().toISOString();
    // Open only an existing database. A READONLY connection cannot initialize
    // absent WAL coordination files on supported macOS SQLite builds. Normal
    // SQLite locking is necessary even for a stopped WAL-mode source: immutable
    // or copying its main file could omit a concurrent committed transaction.
    // VACUUM INTO writes the destination only; connection maintenance can create
    // source sidecars or checkpoint WAL, but never changes application records.
    const reader = new Database(inputPath, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
    try {
      reader.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      // Destination must not exist. Its private parent protects the temporary
      // SQLite-created file until its final explicit 0600 mode is applied.
      reader.query("VACUUM INTO ?").run(outputPath);
    } finally { reader.close(); }
    chmodSync(outputPath, 0o600);
    const after = regularFile(inputPath);
    if (after.ino !== before.ino || after.dev !== before.dev) refuse("file_changed", "A source database was replaced during capture.");
    checkSidecars(inputPath);
    syncFile(outputPath);
    const shape = inspectDatabase(outputPath, name);
    databases.push({ name, ...copyAndHash(outputPath), ...shape, startedAt, completedAt: new Date().toISOString() });
  }
  const manifest: BackupManifest = { schema: BACKUP_SCHEMA, consistency: CONSISTENCY, createdAt: new Date().toISOString(), databases };
  writeManifest(target, manifest);
  verifyLocalBackup(target);
  return manifest;
}

export function verifyLocalBackup(sourcePath: string): BackupManifest {
  const source = directory(sourcePath, true);
  const manifest = parseManifest(source);
  for (const receipt of manifest.databases) verifyReceipt(source, receipt);
  return manifest;
}

export function restoreLocalBackup(sourcePath: string, targetPath: string): BackupManifest {
  const source = directory(sourcePath, true);
  const manifest = verifyLocalBackup(source);
  const target = newDirectory(targetPath, source);
  // No overwrites, migration, provider checks, vault unlock or service start.
  // Failure leaves this newly-created directory for inspection; it never
  // removes state. A missing manifest means the operation did not complete.
  for (const receipt of manifest.databases) {
    const copied = copyAndHash(join(source, receipt.name), join(target, receipt.name));
    if (copied.sha256 !== receipt.sha256 || copied.bytes !== receipt.bytes) refuse("file_changed", "A backup database changed before restore completed.");
    verifyReceipt(target, receipt);
  }
  writeManifest(target, manifest);
  return manifest;
}
