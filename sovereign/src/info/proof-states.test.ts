import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PROOF_STATES, strayProofStates } from "./proof-states.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("proof_state has one meaning", () => {
  it("finds a stray grade at any depth and passes the four XENIA grades", () => {
    expect(strayProofStates({
      proof_state: "tested",
      items: [{ receipt: { proof_state: "pinned-block" } }, { proof_state: "attested" }],
    })).toEqual(['$.items[0].receipt.proof_state="pinned-block"']);
    expect(strayProofStates(PROOF_STATES.map((proof_state) => ({ proof_state })))).toEqual([]);
  });

  it("every literal grade written in the info doors is a XENIA grade", () => {
    const strays = sourceFiles(fileURLToPath(new URL(".", import.meta.url))).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/proof_state:\s*"([^"]*)"/g)]
        .filter((match) => !(PROOF_STATES as readonly string[]).includes(match[1]))
        .map((match) => `${file}: ${match[1]}`));
    expect(strays).toEqual([]);
  });
});
