import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const productionFiles = readdirSync(import.meta.dir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

const forbiddenImports = [
  "../../db",
  "../../vault",
  "../../pay",
  "../../processors",
  "../../senders",
  "../../connectors",
  "../../info",
];

describe("CashLoom v2 module boundary", () => {
  test("keeps storage, vault, payment, processor, and network authority injected", () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      const imports = [...source.matchAll(
        /(?:from\s+|import\s*\()(["'])([^"']+)\1/gu,
      )].map((match) => match[2]!);
      for (const imported of imports) {
        if (forbiddenImports.some((prefix) => imported.startsWith(prefix))) {
          violations.push(`${file} -> ${imported}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("does not add the v2 data plane to the hosted info-only process", () => {
    const infoServer = readFileSync(
      join(import.meta.dir, "../../info-server.ts"),
      "utf8",
    );
    expect(infoServer).not.toContain("protocol/v2");
    expect(infoServer).not.toContain("/v2/records");
    expect(infoServer).not.toContain("/.well-known/cashloom/v2");
  });
});
