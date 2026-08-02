import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const waitForPort = async (
  stream: ReadableStream<Uint8Array>,
): Promise<number> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5_000;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const next = reader.read();
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for info server.")), remaining);
      });
      const { value, done } = await Promise.race([next, timeout]);
      if (done) break;
      output += decoder.decode(value, { stream: true });
      const match = output.match(/cashloom info · http:\/\/[^:]+:(\d+)/u);
      if (match) return Number(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Info server did not report a port. Output: ${output}`);
};

describe("hosted info-server boundary", () => {
  it("serves no v2 protocol door and never creates a sovereign database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cashloom-info-boundary-"));
    const entrypoint = pathToFileURL(
      join(import.meta.dir, "../../info-server.ts"),
    ).href;
    const processHandle = Bun.spawn(
      [process.execPath, "-e", `await import(${JSON.stringify(entrypoint)})`],
      {
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
      const port = await waitForPort(processHandle.stdout);
      const capabilitiesResponse = await fetch(
        `http://127.0.0.1:${port}/v1/capabilities`,
      );
      expect(capabilitiesResponse.status).toBe(200);
      expect(capabilitiesResponse.headers.get("cache-control")).toContain(
        "max-age=300",
      );
      const capabilities = await capabilitiesResponse.json();
      expect(capabilities.hosted_surface).toMatchObject({
        mode: "information_only",
        moves_money: false,
        holds_keys: false,
        identity_authority: "none",
      });
      const wellKnownResponse = await fetch(
        `http://127.0.0.1:${port}/.well-known/cashloom.json`,
      );
      expect(wellKnownResponse.status).toBe(200);
      expect(await wellKnownResponse.json()).toEqual(capabilities);
      const response = await fetch(
        `http://127.0.0.1:${port}/.well-known/cashloom/v2`,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      const executionResponses = await Promise.all(
        [
          "/api/v2/pay-links/executions/prepare",
          "/api/v2/pay-links/executions/confirm",
          "/api/v2/pay-links/executions/status",
        ].map((path) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ),
      );
      expect(executionResponses.map(({ status }) => status)).toEqual([
        404,
        404,
        404,
      ]);
      expect(existsSync(join(dataDir, "sovereign.db"))).toBe(false);
    } finally {
      processHandle.kill();
      await processHandle.exited;
    }
  });
});
