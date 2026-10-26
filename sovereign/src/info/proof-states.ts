import type { ProofState } from "./money-fact.ts";

/**
 * The one trust axis every door's `proof_state` speaks (money-fact.ts): can a
 * stranger re-derive this without a secret and without our say-so? MONEYWORLD.md
 * warns that two look-alike grade systems are dishonesty by ambiguity, so a
 * served body that carries any other word under this name is a defect.
 */
export const PROOF_STATES: readonly ProofState[] = ["none", "asserted", "tested", "attested"];

/** JSON paths in a served body whose `proof_state` is not one of PROOF_STATES. */
export function strayProofStates(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => strayProofStates(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    const stray = key === "proof_state" && !PROOF_STATES.includes(child as ProofState)
      ? [`${here}=${JSON.stringify(child)}`]
      : [];
    return [...stray, ...strayProofStates(child, here)];
  });
}
