import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("provider token encryption is vault-bound, connection-bound, and separate from signing keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cashloom-plaid-vault-test-"));
  const vaultUrl = new URL("../vault.ts", import.meta.url).href;
  const dbUrl = new URL("../db.ts", import.meta.url).href;
  // A separate process prevents test-module caching from selecting another
  // suite's database. Its only state directory is the fresh fixture above.
  const script = `
    const vault = await import(${JSON.stringify(vaultUrl)});
    const { db } = await import(${JSON.stringify(dbUrl)});
    const binding = { provider: 'plaid-sandbox', itemId: '00000000-0000-4000-8000-000000000001' };
    const other = { provider: 'plaid-sandbox', itemId: '00000000-0000-4000-8000-000000000002' };
    const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
    const refused = async (operation) => { try { await operation(); return false; } catch { return true; } };
    assert(await refused(() => vault.sealProviderToken(binding, 'access-sandbox-synthetic')), 'locked sealing was allowed');
    await vault.initialize('synthetic test passphrase only');
    const blob = await vault.sealProviderToken(binding, 'access-sandbox-synthetic');
    assert(!new TextDecoder().decode(blob).includes('access-sandbox'), 'plaintext persisted');
    assert(await vault.unsealProviderToken(binding, blob) === 'access-sandbox-synthetic', 'roundtrip failed');
    assert(await refused(() => vault.unsealProviderToken(other, blob)), 'connection substitution allowed');
    const changed = blob.slice(); changed[changed.length - 1] ^= 1;
    assert(await refused(() => vault.unsealProviderToken(binding, changed)), 'ciphertext mutation allowed');
    assert(await refused(() => vault.sealProviderToken(binding, 'access-production-synthetic')), 'production token accepted');
    assert(db.query('SELECT count(*) n FROM vault_keys').get().n === 0, 'provider token became signing key');
    vault.lock();
    assert(await refused(() => vault.unsealProviderToken(binding, blob)), 'locked token access allowed');
    await vault.unlock('synthetic test passphrase only');
    assert(await vault.unsealProviderToken(binding, blob) === 'access-sandbox-synthetic', 'unlock did not restore token access');
    vault.lock(); db.close(); console.log('provider token boundaries passed');
  `;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CASHLOOM_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); expect(stdout.trim()).toBe("provider token boundaries passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
