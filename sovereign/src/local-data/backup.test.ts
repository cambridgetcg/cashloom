import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backupLocalData, CONSISTENCY, LocalDataError, restoreLocalBackup, verifyLocalBackup } from "./backup.ts";

const sourceRoot = resolve(import.meta.dir, "..");
const cli = join(import.meta.dir, "cli.ts");
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(sourceRoot, name)).href);
let seedRoot: string;
let root: string;
let source: string;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function child(script: string, dataDir: string) {
  return Bun.spawnSync([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
    cwd: dirname(sourceRoot), env: { CASHLOOM_DATA_DIR: dataDir, PATH: process.env.PATH ?? "" },
    stdout: "pipe", stderr: "pipe",
  });
}
function cliRun(args: string[]) {
  return Bun.spawnSync([process.execPath, "--no-env-file", "--no-install", cli, ...args], {
    cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
  });
}
function rewriteManifest(path: string, change: (value: any) => void) {
  const manifestPath = join(path, "manifest.json");
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  change(value);
  writeFileSync(manifestPath, JSON.stringify(value), { mode: 0o600 });
}

beforeAll(() => {
  seedRoot = mkdtempSync(join(tmpdir(), "cashloom-local-data-seed-"));
  // A separate process binds the actual vault/database modules to this synthetic
  // directory before import. No inherited credentials, provider calls or server.
  const result = child(`
    import { Database } from "bun:sqlite";
    import { join } from "node:path";
    const vault = await import(${moduleUrl("vault.ts")});
    const { db } = await import(${moduleUrl("db.ts")});
    const { installWalletIntegrationSchema } = await import(${moduleUrl("wallet/infrastructure/sqlite/integration-schema.ts")});
    installWalletIntegrationSchema(db);
    await vault.initialize("synthetic-restore-test-passphrase");
    await vault.generateEvmKey("Synthetic test key");
    db.query("INSERT INTO accounts(id,rail,display_name,currency,decimals,balance_minor,balance_as_of,status) VALUES(?,?,?,?,?,?,?,?)")
      .run("manual-fixture", "CASH", "Synthetic manual account", "GBP", 2, "9007199254740993123", "2026-09-23T12:00:00Z", "ACTIVE");
    db.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,source) VALUES(?,?,?,?,?,?)")
      .run("ledger-fixture", "manual-fixture", "Synthetic ledger record", "-12345", "2026-09-23T12:00:00Z", "MANUAL");
    const { TradeStore } = await import(${moduleUrl("tcg/store.ts")});
    const { SimulationStore } = await import(${moduleUrl("tcg/simulation-store.ts")});
    const { fixtureTerms, OWNER, TEST_NOW } = await import(${moduleUrl("tcg/fixtures.ts")});
    const trades = new TradeStore(db, { now: () => TEST_NOW });
    const trade = trades.create({ idempotencyKey: "fixture-trade", expectedVersion: 0, terms: fixtureTerms() }, OWNER);
    const sandbox = new Database(join(process.env.CASHLOOM_DATA_DIR, "tcg-sandbox.db"));
    const simulations = new SimulationStore(sandbox, { now: () => TEST_NOW });
    simulations.create({ idempotencyKey: "fixture-simulation", expectedVersion: 0, tradeId: trade.id, revision: 1 }, trade.current, OWNER);
    vault.lock(); sandbox.close(); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  `, seedRoot);
  if (result.exitCode !== 0) throw new Error(`Synthetic source creation failed: ${result.stderr.toString()}`);
});
afterAll(() => rmSync(seedRoot, { recursive: true, force: true }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cashloom-local-data-test-"));
  source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
  for (const name of ["sovereign.db", "tcg-sandbox.db"]) copyFileSync(join(seedRoot, name), join(source, name));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("explicit local data snapshots", () => {
  test("captures a stopped WAL-mode database without sidecars using normal SQLite coordination", () => {
    const sourceFile = join(source, "sovereign.db");
    expect(readFileSync(sourceFile).subarray(18, 20)).toEqual(Buffer.from([2, 2]));
    expect(existsSync(sourceFile + "-wal")).toBe(false);
    expect(existsSync(sourceFile + "-shm")).toBe(false);
    const backup = join(root, "backup");
    backupLocalData(source, backup);
    const original = new Database(sourceFile, { readonly: true });
    const snapshot = new Database(join(backup, "sovereign.db"), { readonly: true });
    try {
      const query = "SELECT id,account_id,amount_minor FROM transactions ORDER BY id";
      expect(snapshot.query(query).all()).toEqual(original.query(query).all());
      expect(snapshot.query("SELECT amount_minor FROM transactions WHERE id='ledger-fixture'").get()).toEqual({ amount_minor: "-12345" });
      expect(original.query("SELECT MAX(version) AS version FROM wk_schema_meta").get()).toEqual({ version: 8 });
    } finally { snapshot.close(); original.close(); }
  });

  test("captures committed WAL rows, excludes an open transaction and leaves source bytes unchanged", () => {
    const sourceFile = join(source, "sovereign.db");
    const writer = new Database(sourceFile);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      writer.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,source) VALUES(?,?,?,?,?,?)")
        .run("wal-committed", "manual-fixture", "Synthetic WAL row", "-77", "2026-09-23T12:00:00Z", "MANUAL");
      const mainBefore = digest(sourceFile), walBefore = digest(sourceFile + "-wal");
      writer.exec("BEGIN IMMEDIATE");
      writer.query("INSERT INTO transactions(id,account_id,title,amount_minor,date,source) VALUES(?,?,?,?,?,?)")
        .run("uncommitted", "manual-fixture", "Synthetic uncommitted row", "-88", "2026-09-23T12:00:00Z", "MANUAL");
      const backup = join(root, "backup");
      const manifest = backupLocalData(source, backup);
      expect(manifest.consistency).toBe(CONSISTENCY);
      expect(manifest.databases.map(d => d.name)).toEqual(["sovereign.db", "tcg-sandbox.db"]);
      const copy = new Database(join(backup, "sovereign.db"), { readonly: true });
      try {
        expect(copy.query("SELECT amount_minor FROM transactions WHERE id='wal-committed'").get()).toEqual({ amount_minor: "-77" });
        expect(copy.query("SELECT id FROM transactions WHERE id='uncommitted'").get()).toBeNull();
      } finally { copy.close(); }
      expect(digest(sourceFile)).toBe(mainBefore);
      expect(digest(sourceFile + "-wal")).toBe(walBefore);
      writer.exec("ROLLBACK");
    } finally { writer.close(); }
  });

  test("restores a synthetic vault, manual balance/ledger and both trade stores without altering the backup", () => {
    const backup = join(root, "backup"), restored = join(root, "restored");
    backupLocalData(source, backup);
    const before = readdirSync(backup).map(name => [name, digest(join(backup, name))]);
    restoreLocalBackup(backup, restored);
    expect(verifyLocalBackup(restored)).toEqual(verifyLocalBackup(backup));
    const result = child(`
      import { Database } from "bun:sqlite";
      import { join } from "node:path";
      const vault = await import(${moduleUrl("vault.ts")});
      const { db } = await import(${moduleUrl("db.ts")});
      await vault.unlock("synthetic-restore-test-passphrase");
      if (!vault.isUnlocked() || vault.listKeys().length !== 1) throw new Error("Synthetic restored vault failed");
      const account = db.query("SELECT balance_minor FROM accounts WHERE id='manual-fixture'").get();
      const ledger = db.query("SELECT amount_minor FROM transactions WHERE id='ledger-fixture'").get();
      if (account.balance_minor !== "9007199254740993123" || ledger.amount_minor !== "-12345") throw new Error("Synthetic restored records failed");
      const { TradeStore } = await import(${moduleUrl("tcg/store.ts")});
      const { SimulationStore } = await import(${moduleUrl("tcg/simulation-store.ts")});
      const trades = new TradeStore(db);
      const sandbox = new Database(join(process.env.CASHLOOM_DATA_DIR, "tcg-sandbox.db"));
      const simulations = new SimulationStore(sandbox);
      if (trades.list().length !== 1 || simulations.list().length !== 1) throw new Error("Synthetic restored trade stores failed");
      vault.lock(); sandbox.close(); db.close();
    `, restored);
    if (result.exitCode !== 0) throw new Error(`Synthetic restored-data check failed: ${result.stderr.toString()}`);
    expect(readdirSync(backup).map(name => [name, digest(join(backup, name))])).toEqual(before);
  });

  test("omits an absent sandbox and never copies unrelated local files", () => {
    rmSync(join(source, "tcg-sandbox.db"));
    writeFileSync(join(source, "unrelated.txt"), "synthetic unrelated state");
    const backup = join(root, "backup");
    expect(backupLocalData(source, backup).databases.map(d => d.name)).toEqual(["sovereign.db"]);
    expect(readdirSync(backup).sort()).toEqual(["manifest.json", "sovereign.db"]);
    expect(existsSync(join(source, "tcg-sandbox.db"))).toBe(false);
    expect(readFileSync(join(source, "unrelated.txt"), "utf8")).toBe("synthetic unrelated state");
  });

  test("creates private directories/files and verifies without sidecars or changed content", () => {
    const backup = join(root, "backup"); backupLocalData(source, backup);
    expect(lstatSync(backup).mode & 0o777).toBe(0o700);
    const before = readdirSync(backup).map(name => [name, digest(join(backup, name))]);
    for (const name of readdirSync(backup)) expect(lstatSync(join(backup, name)).mode & 0o777).toBe(0o600);
    verifyLocalBackup(backup); verifyLocalBackup(backup);
    expect(readdirSync(backup).map(name => [name, digest(join(backup, name))])).toEqual(before);
    chmodSync(join(backup, "sovereign.db"), 0o644);
    expect(() => verifyLocalBackup(backup)).toThrow("mode 0600");
  });

  test("refuses tampered bytes before creating a restore target", () => {
    const backup = join(root, "backup"), target = join(root, "restore"); backupLocalData(source, backup);
    const data = readFileSync(join(backup, "sovereign.db")); data[data.length - 1] ^= 1;
    writeFileSync(join(backup, "sovereign.db"), data);
    expect(() => restoreLocalBackup(backup, target)).toThrow("length and hash");
    expect(existsSync(target)).toBe(false);
  });

  test("still checks SQLite integrity and compatible schema after a hash was replaced", () => {
    const backup = join(root, "backup"); backupLocalData(source, backup);
    writeFileSync(join(backup, "sovereign.db"), Buffer.alloc(4096));
    rewriteManifest(backup, m => { m.databases[0].sha256 = digest(join(backup, "sovereign.db")); m.databases[0].bytes = 4096; });
    expect(() => verifyLocalBackup(backup)).toThrow();
  });

  test("refuses an unknown kernel version without migrating the source", () => {
    const db = new Database(join(source, "sovereign.db"));
    db.exec("INSERT INTO wk_schema_meta(version) VALUES(999)"); db.close();
    const before = digest(join(source, "sovereign.db"));
    expect(() => backupLocalData(source, join(root, "backup"))).toThrow("schema version is unsupported");
    expect(digest(join(source, "sovereign.db"))).toBe(before);
    expect(existsSync(join(root, "backup", "manifest.json"))).toBe(false);
  });

  test("refuses partial backups, unexpected files and manifest version/path changes", () => {
    const backup = join(root, "backup"); backupLocalData(source, backup);
    const manifest = readFileSync(join(backup, "manifest.json"));
    for (const change of [
      (m: any) => { m.schema = "cashloom.local-backup/999"; },
      (m: any) => { m.databases[0].name = "../sovereign.db"; },
      (m: any) => { m.databases.push(m.databases[0]); },
    ]) {
      rewriteManifest(backup, change);
      expect(() => verifyLocalBackup(backup)).toThrow();
      writeFileSync(join(backup, "manifest.json"), manifest);
    }
    writeFileSync(join(backup, "sovereign.db-wal"), "incomplete");
    expect(() => verifyLocalBackup(backup)).toThrow("unexpected files");
    rmSync(join(backup, "sovereign.db-wal"));
    rmSync(join(backup, "manifest.json"));
    expect(() => verifyLocalBackup(backup)).toThrow();
  });

  test("refuses symlinked source roots, database files, sidecars and backup entries", () => {
    const alias = join(root, "source-alias"); symlinkSync(source, alias);
    expect(() => backupLocalData(alias, join(root, "alias-backup"))).toThrow("not a symlink");
    const backup = join(root, "backup"); backupLocalData(source, backup);
    rmSync(join(backup, "sovereign.db")); symlinkSync(join(source, "sovereign.db"), join(backup, "sovereign.db"));
    expect(() => verifyLocalBackup(backup)).toThrow("without links");
    rmSync(join(source, "sovereign.db-wal"), { force: true });
    symlinkSync(join(source, "sovereign.db"), join(source, "sovereign.db-wal"));
    expect(() => backupLocalData(source, join(root, "sidecar-backup"))).toThrow("without links");
    expect(existsSync(join(root, "sidecar-backup"))).toBe(false);
    rmSync(join(source, "sovereign.db-wal"));
    rmSync(join(source, "sovereign.db")); symlinkSync(join(seedRoot, "sovereign.db"), join(source, "sovereign.db"));
    expect(() => backupLocalData(source, join(root, "file-backup"))).toThrow("without links");
  });

  test("never overwrites an existing destination, including an empty folder or symlink", () => {
    const backup = join(root, "backup"); backupLocalData(source, backup);
    const target = join(root, "existing"); mkdirSync(target);
    expect(() => restoreLocalBackup(backup, target)).toThrow("already exists");
    writeFileSync(join(target, "preserved"), "synthetic existing data");
    expect(() => backupLocalData(source, target)).toThrow("already exists");
    const alias = join(root, "target-alias"); symlinkSync(target, alias);
    expect(() => restoreLocalBackup(backup, alias)).toThrow("already exists");
    expect(readFileSync(join(target, "preserved"), "utf8")).toBe("synthetic existing data");
  });

  test("rejects output nested inside either source before changing that directory", () => {
    const backup = join(root, "backup"); backupLocalData(source, backup);
    const entries = readdirSync(backup);
    expect(() => restoreLocalBackup(backup, join(backup, "restored"))).toThrow("outside the source");
    const alias = join(root, "backup-alias"); symlinkSync(backup, alias);
    expect(() => restoreLocalBackup(backup, join(alias, "restored"))).toThrow("outside the source");
    expect(readdirSync(backup)).toEqual(entries);
    expect(() => backupLocalData(source, join(source, "backup"))).toThrow("outside the source");
    expect(existsSync(join(source, "backup"))).toBe(false);
    verifyLocalBackup(backup);
  });

  test("CLI requires explicit paths and prints only fixed errors or bounded operation metadata", () => {
    const help = cliRun(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("not at one atomic instant");
    expect(cliRun(["backup"]).exitCode).toBe(1);
    expect(cliRun(["verify", "--source", source, "--target", join(root, "no")]).exitCode).toBe(1);
    const backup = join(root, "backup");
    const success = cliRun(["backup", "--source", source, "--target", backup]);
    expect(success.exitCode).toBe(0);
    const output = JSON.parse(success.stdout.toString());
    expect(output).toMatchObject({ ok: true, operation: "backup", serviceStarted: false });
    expect(success.stdout.toString()).not.toContain("Synthetic");
    expect(success.stdout.toString()).not.toContain("passphrase");
    writeFileSync(join(backup, "manifest.json"), "synthetic-private-invalid-json");
    const failure = cliRun(["verify", "--source", backup]);
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr.toString()).not.toContain("synthetic-private-invalid-json");
    expect(JSON.parse(failure.stderr.toString())).toMatchObject({ ok: false, code: "local_data_unavailable" });
    expect(LocalDataError.prototype instanceof Error).toBe(true);
  });
});
