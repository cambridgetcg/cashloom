import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "cashloom-v2-migration-"));
const databasePath = join(dataDir, "sovereign.db");

// A deliberately tiny pre-v2 database. Real startup must add the protocol
// tables without replacing existing local state, even when two nodes race.
const legacy = new Database(databasePath, { create: true });
legacy.exec(`
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('legacy.marker', 'preserve-me');
`);
legacy.close();
// Reproduce the common pre-hardening umask result. Startup must tighten both
// an existing data directory and existing database without replacing data.
chmodSync(dataDir, 0o755);
chmodSync(databasePath, 0o644);

const dbModuleUrl = pathToFileURL(
  join(import.meta.dir, "../../db.ts"),
).href;
const workers = Array.from({ length: 2 }, () =>
  Bun.spawn(
    [process.execPath, "-e", `await import(${JSON.stringify(dbModuleUrl)})`],
    {
      env: { ...process.env, CASHLOOM_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  ),
);
const workerResults = await Promise.all(
  workers.map(async (worker) => ({
    status: await worker.exited,
    stderr: await new Response(worker.stderr).text(),
  })),
);

process.env.CASHLOOM_DATA_DIR = dataDir;
const { db } = await import("../../db.ts");

describe("CashLoom v2 database migration", () => {
  it("installs once under a startup race and preserves existing local state", () => {
    expect(existsSync(databasePath)).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }
    expect(
      workerResults.map(({ status }) => status),
      JSON.stringify(workerResults),
    ).toEqual([0, 0]);
    expect(
      db.query("SELECT value FROM settings WHERE key = 'legacy.marker'").get(),
    ).toEqual({ value: "preserve-me" });

    const tables = new Set(
      (
        db.query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'cashloom_v2_%'`,
        ).all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    expect(tables).toEqual(
      new Set([
        "cashloom_v2_btc_payment_bindings",
        "cashloom_v2_ingest_usage",
        "cashloom_v2_record_parents",
        "cashloom_v2_records",
      ]),
    );

    const triggerNames = new Set(
      (
        db.query(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'cashloom_v2_%'`,
        ).all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    expect(triggerNames).toEqual(
      new Set([
        "cashloom_v2_btc_bindings_no_delete",
        "cashloom_v2_btc_bindings_no_update",
        "cashloom_v2_parents_no_delete",
        "cashloom_v2_parents_no_update",
        "cashloom_v2_records_no_delete",
        "cashloom_v2_records_no_update",
      ]),
    );
    expect(
      db.query(
        `SELECT remote_record_count, remote_canonical_bytes
         FROM cashloom_v2_ingest_usage WHERE singleton = 1`,
      ).get(),
    ).toEqual({ remote_record_count: 0, remote_canonical_bytes: 0 });
  });
});
