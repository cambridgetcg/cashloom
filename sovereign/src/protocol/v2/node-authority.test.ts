import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  keyIdForPublicKey,
  signatureFromBase64Url,
} from "@agenttool/wallet";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CASHLOOM_V2_NODE_AUTHORITY_LABEL,
  createV2NodeAuthorityProvider,
  type V2NodeAuthorityVault,
} from "./node-authority.ts";

const openAuthorityDb = (path = ":memory:"): Database => {
  const database = new Database(path, { create: true });
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE vault_keys (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      address    TEXT,
      enc_blob   BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX idx_vault_v2_node_authority
      ON vault_keys(label)
      WHERE kind = 'secret' AND label = 'cashloom-v2-node-authority';
  `);
  return database;
};

const seedHex = (seed: Uint8Array): string =>
  Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join("");

interface FakeVault extends V2NodeAuthorityVault {
  readonly generateCalls: number;
  readonly revealCalls: number;
}

function fakeVault(database: Database, seedByte: number): FakeVault {
  const seed = new Uint8Array(32).fill(seedByte);
  let generateCalls = 0;
  let revealCalls = 0;
  let storedId: string | undefined;
  return {
    get generateCalls() {
      return generateCalls;
    },
    get revealCalls() {
      return revealCalls;
    },
    async generateEd25519Key(label) {
      generateCalls += 1;
      // Make simultaneous ensure() calls overlap at the generation seam.
      await Promise.resolve();
      const id = crypto.randomUUID();
      const publicKey = base64UrlEncode(
        await ed25519.getPublicKeyAsync(seed),
      );
      database
        .query(
          `INSERT INTO vault_keys (id, label, kind, address, enc_blob)
           VALUES (?, ?, 'secret', ?, ?)`,
        )
        .run(id, label, publicKey, seed);
      storedId = id;
      return { id, address: publicKey };
    },
    async revealForSigning(keyId) {
      revealCalls += 1;
      if (keyId !== storedId) throw new Error("unexpected test key");
      return seedHex(seed);
    },
  };
}

describe("CashLoom v2 node authority", () => {
  test("singleflights first use and returns one stable self-certifying identity", async () => {
    const database = openAuthorityDb();
    const vault = fakeVault(database, 7);
    const provider = createV2NodeAuthorityProvider({ db: database, vault });

    const nodes = await Promise.all(
      Array.from({ length: 24 }, () => provider.ensure()),
    );
    expect(vault.generateCalls).toBe(1);
    expect(new Set(nodes.map(({ vaultKeyId }) => vaultKeyId)).size).toBe(1);
    expect(new Set(nodes.map(({ authority }) => authority.key_id)).size).toBe(1);
    expect(nodes.every((node) => node === nodes[0])).toBe(true);
    expect(nodes[0]!.authority.key_id).toBe(
      keyIdForPublicKey(nodes[0]!.authority.public_key),
    );

    expect((await provider.ensure()).vaultKeyId).toBe(nodes[0]!.vaultKeyId);
    expect(vault.generateCalls).toBe(1);
    database.close();
  });

  test("reveals once for one digest, verifies the key binding, and signs", async () => {
    const database = openAuthorityDb();
    const vault = fakeVault(database, 11);
    const provider = createV2NodeAuthorityProvider({ db: database, vault });
    const context = await provider.signingContext();
    const digest = new Uint8Array(32).fill(19);

    const signature = await context.signer.sign_digest(digest);
    expect(vault.revealCalls).toBe(1);
    expect(
      await ed25519.verifyAsync(
        signatureFromBase64Url(signature),
        digest,
        Buffer.from(context.authority.public_key, "base64url"),
      ),
    ).toBe(true);

    await expect(
      context.signer.sign_digest(new Uint8Array(31)),
    ).rejects.toThrow(/exactly 32 bytes/);
    expect(vault.revealCalls).toBe(1);
    database.close();
  });

  test("fails closed on a malformed persisted authority without replacing it", async () => {
    const database = openAuthorityDb();
    database
      .query(
        `INSERT INTO vault_keys (id, label, kind, address, enc_blob)
         VALUES ('bad-key', ?, 'secret', NULL, x'00')`,
      )
      .run(CASHLOOM_V2_NODE_AUTHORITY_LABEL);
    const vault = fakeVault(database, 13);
    const provider = createV2NodeAuthorityProvider({ db: database, vault });

    await expect(provider.ensure()).rejects.toThrow(/no usable public key/);
    expect(vault.generateCalls).toBe(0);
    database.close();
  });

  test("refuses revealed seed material that does not match the persisted public key", async () => {
    const database = openAuthorityDb();
    const generated = fakeVault(database, 15);
    const vault: V2NodeAuthorityVault = {
      generateEd25519Key: generated.generateEd25519Key.bind(generated),
      async revealForSigning() {
        return seedHex(new Uint8Array(32).fill(16));
      },
    };
    const provider = createV2NodeAuthorityProvider({ db: database, vault });
    const context = await provider.signingContext();

    await expect(
      context.signer.sign_digest(new Uint8Array(32).fill(1)),
    ).rejects.toThrow(/does not match its public key/);
    database.close();
  });

  test("does not disguise a generation failure when no concurrent winner exists", async () => {
    const database = openAuthorityDb();
    let attempts = 0;
    const vault: V2NodeAuthorityVault = {
      async generateEd25519Key() {
        attempts += 1;
        throw new Error("test vault unavailable");
      },
      async revealForSigning() {
        throw new Error("not reached");
      },
    };
    const provider = createV2NodeAuthorityProvider({ db: database, vault });

    await expect(provider.ensure()).rejects.toThrow("test vault unavailable");
    await expect(provider.ensure()).rejects.toThrow("test vault unavailable");
    expect(attempts).toBe(2);
    database.close();
  });
});

const processTestRoot = mkdtempSync(
  join(tmpdir(), "cashloom-v2-node-authority-process-"),
);
const processDbPath = join(processTestRoot, "sovereign.db");
const processBarrier = join(processTestRoot, "barrier");
mkdirSync(processBarrier);
const setup = openAuthorityDb(processDbPath);
setup.close();

const moduleUrl = pathToFileURL(
  join(import.meta.dir, "node-authority.ts"),
).href;
const processWorker = `
  import { Database } from "bun:sqlite";
  import * as ed25519 from "@noble/ed25519";
  import { base64UrlEncode } from "@agenttool/wallet";
  import { createV2NodeAuthorityProvider } from ${JSON.stringify(moduleUrl)};
  import { readdirSync, writeFileSync } from "node:fs";
  import { join } from "node:path";

  const database = new Database(process.env.V2_AUTH_DB, { create: true });
  database.exec("PRAGMA busy_timeout = 5000;");
  const marker = join(process.env.V2_AUTH_BARRIER, process.env.V2_AUTH_SEED);
  const seed = new Uint8Array(32).fill(Number(process.env.V2_AUTH_SEED));
  const vault = {
    async generateEd25519Key(label) {
      writeFileSync(marker, "ready");
      const deadline = Date.now() + 5000;
      while (readdirSync(process.env.V2_AUTH_BARRIER).length < 2) {
        if (Date.now() >= deadline) throw new Error("cross-process barrier timed out");
        await Bun.sleep(5);
      }
      const id = crypto.randomUUID();
      const address = base64UrlEncode(await ed25519.getPublicKeyAsync(seed));
      database.query(
        "INSERT INTO vault_keys (id, label, kind, address, enc_blob) VALUES (?, ?, 'secret', ?, ?)"
      ).run(id, label, address, seed);
      return { id, address };
    },
    async revealForSigning() {
      throw new Error("cross-process ensure test does not sign");
    },
  };
  const node = await createV2NodeAuthorityProvider({ db: database, vault }).ensure();
  process.stdout.write(JSON.stringify(node) + "\\n");
  database.close();
`;

const workers = ["21", "22"].map((seed) =>
  Bun.spawn([process.execPath, "-e", processWorker], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      V2_AUTH_DB: processDbPath,
      V2_AUTH_BARRIER: processBarrier,
      V2_AUTH_SEED: seed,
    },
    stdout: "pipe",
    stderr: "pipe",
  }),
);
const workerResults = await Promise.all(
  workers.map(async (worker) => ({
    status: await worker.exited,
    stdout: await new Response(worker.stdout).text(),
    stderr: await new Response(worker.stderr).text(),
  })),
);

describe("CashLoom v2 node authority cross-process race", () => {
  test("recovers the unique-index winner in both processes", () => {
    expect(
      workerResults.map(({ status }) => status),
      JSON.stringify(workerResults),
    ).toEqual([0, 0]);
    const nodes = workerResults.map(({ stdout }) => JSON.parse(stdout.trim())) as Array<{
      vaultKeyId: string;
      authority: { key_id: string; public_key: string };
    }>;
    expect(new Set(nodes.map(({ vaultKeyId }) => vaultKeyId)).size).toBe(1);
    expect(new Set(nodes.map(({ authority }) => authority.key_id)).size).toBe(1);

    const database = new Database(processDbPath);
    const count = database
      .query(
        `SELECT COUNT(*) AS count
         FROM vault_keys
         WHERE label = ? AND kind = 'secret'`,
      )
      .get(CASHLOOM_V2_NODE_AUTHORITY_LABEL) as { count: number };
    expect(count.count).toBe(1);
    database.close();
  });
});
