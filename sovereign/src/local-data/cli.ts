import { backupLocalData, LocalDataError, restoreLocalBackup, verifyLocalBackup } from "./backup.ts";

const HELP = `CashLoom local data — explicit paths; no service, migration or unlock

bun --no-env-file --no-install src/local-data/cli.ts backup --source <data-dir> --target <new-backup-dir>
bun --no-env-file --no-install src/local-data/cli.ts verify --source <backup-dir>
bun --no-env-file --no-install src/local-data/cli.ts restore --source <backup-dir> --target <new-data-dir>

Each database snapshot includes committed WAL data and is independently consistent.
The wallet and optional sandbox are captured separately, not at one atomic instant.
Backup opens existing source databases with SQLite write access for coordination;
SQLite may create sidecars or checkpoint committed WAL pages. Application records
and schema are not edited. Verification and restore leave the backup unchanged.
Keep the backup private: records are not wholly encrypted. The vault passphrase
is still required. Hashes check integrity, not backup authorship. Restoring old
state does not establish current balances, payment outcomes or signing safety.
Restore never starts the wallet. Failed output directories are retained; a missing
manifest means incomplete output. Targets must not exist, including empty folders.
`;

export function runLocalDataCli(args: string[]): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) { console.log(HELP); return 0; }
  try {
    const [command, ...rest] = args;
    if (!["backup", "verify", "restore"].includes(command ?? "")) throw new LocalDataError("usage", "Choose backup, verify or restore; use --help for explicit-path usage.");
    const options = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index], value = rest[index + 1];
      if (!["--source", "--target"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new LocalDataError("usage", "Options must be unique --source and --target paths.");
      options.set(key, value);
    }
    const source = options.get("--source"), target = options.get("--target");
    if (!source || (command === "verify" ? target !== undefined : !target)) throw new LocalDataError("usage", "An explicit source is required; backup and restore also require a new target.");
    const manifest = command === "backup" ? backupLocalData(source, target!) : command === "restore" ? restoreLocalBackup(source, target!) : verifyLocalBackup(source);
    console.log(JSON.stringify({ ok: true, operation: command, schema: manifest.schema, consistency: manifest.consistency,
      databases: manifest.databases.map(({ name, bytes }) => ({ name, bytes })), serviceStarted: false }));
    return 0;
  } catch (error) {
    // SQLite, filesystem and parse errors may carry schema or user-supplied text.
    // Only fixed application messages cross the terminal boundary.
    const safe = error instanceof LocalDataError ? error : new LocalDataError("local_data_unavailable", "The local data operation failed. Check the explicit paths, access, free space and database integrity. Any new partial target was retained; existing data was not overwritten.");
    console.error(JSON.stringify({ ok: false, code: safe.code, message: safe.message }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = runLocalDataCli(process.argv.slice(2));
