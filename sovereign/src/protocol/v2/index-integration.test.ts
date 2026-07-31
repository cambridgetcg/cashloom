import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyV2Record } from "./records.ts";
import { V2_RECORD_MEDIA_TYPE } from "./transport.ts";

async function sovereignPort(
  stdout: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Timed out waiting for sovereign node.")),
            remaining,
          );
        }),
      ]);
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      const match = output.match(
        /cashloom sovereign · http:\/\/[^:]+:(\d+)/u,
      );
      if (match) return Number(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Sovereign node did not report a port. Output: ${output}`);
}

describe("real sovereign v2 integration", () => {
  test("activates behind a vault session and keeps signed discovery readable while locked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cashloom-v2-index-"));
    const entrypoint = pathToFileURL(
      join(import.meta.dir, "../../index.ts"),
    ).href;
    const processHandle = Bun.spawn(
      [process.execPath, "-e", `await import(${JSON.stringify(entrypoint)})`],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          CASHLOOM_BIND: "127.0.0.1",
          CASHLOOM_PORT: "0",
          CASHLOOM_DATA_DIR: dataDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const port = await sovereignPort(processHandle.stdout);
      const base = `http://127.0.0.1:${port}`;
      expect(
        (await fetch(`${base}/.well-known/cashloom/v2`)).status,
      ).toBe(404);
      const lockedPrepare = await fetch(
        `${base}/api/v2/pay-links/executions/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(lockedPrepare.status).toBe(401);
      expect(lockedPrepare.headers.get("cache-control")).toBe("no-store");

      const initialized = await fetch(`${base}/api/vault/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "test-only-playground-passphrase" }),
      });
      expect(initialized.status).toBe(200);
      const { token } = await initialized.json() as { token: string };

      const invalidExecution = await fetch(
        `${base}/api/v2/pay-links/executions/prepare`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(invalidExecution.status).toBe(400);
      expect(invalidExecution.headers.get("cache-control")).toBe("no-store");

      const activated = await fetch(`${base}/api/v2/node/activate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(activated.status).toBe(201);
      const activation = await activated.json() as {
        record: { record_id: `sha256:${string}` };
      };

      const discovery = await fetch(
        `${base}/.well-known/cashloom/v2`,
      );
      expect(discovery.status).toBe(200);
      expect(discovery.headers.get("content-type")).toBe(V2_RECORD_MEDIA_TYPE);
      const descriptorBytes = new Uint8Array(await discovery.arrayBuffer());
      const descriptor = verifyV2Record(descriptorBytes);
      expect(descriptor.record_id).toBe(activation.record.record_id);

      const locked = await fetch(`${base}/api/vault/lock`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(locked.status).toBe(200);
      expect(
        (await fetch(`${base}/.well-known/cashloom/v2`)).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${base}/api/v2/records/${descriptor.record_id}`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
      for (const path of [
        "/api/v2/pay-links/executions/confirm",
        "/api/v2/pay-links/executions/status",
      ]) {
        const lockedExecution = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(lockedExecution.status).toBe(401);
        expect(lockedExecution.headers.get("cache-control")).toBe("no-store");
      }
      expect(existsSync(join(dataDir, "sovereign.db"))).toBe(true);
    } finally {
      processHandle.kill();
      await processHandle.exited;
    }
  });
});
