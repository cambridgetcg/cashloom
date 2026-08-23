/**
 * End-to-end proof of the unbound capability-audit gate, with a real
 * vault-signed attestation. This deliberately does not bind or execute a Base
 * payment. Run against a THROWAWAY vault so it touches nothing real:
 *
 *   CASHLOOM_DATA_DIR="$(mktemp -d)" bun src/pay/agent-pay.demo.ts
 */

import * as vault from "../vault.ts";
import * as ed25519 from "@noble/ed25519";
import vectors from "@agenttool/wallet/vectors.json";
import {
  authorizeAgentPayment_wired,
  setAgentGrantRevocationNonce,
} from "./agent-pay.ts";

const by = Object.fromEntries((vectors as any).records.map((r: any) => [r.kind, r.record]));
const base = {
  descriptorJson: by.descriptor,
  capabilityJson: by.capability,
  intentJson: by.intent,
  simulationJson: by.simulation,
};
const atVectorTime = { now: () => new Date("2026-07-21T10:02:00.000Z") };

await vault.initialize("throwaway-passphrase");
await vault.unlock("throwaway-passphrase");
console.log("\nvault: initialized + unlocked (throwaway)\n");

// PASS — an honest, within-grant capability audit (not executable authority).
const res = await authorizeAgentPayment_wired({
  ...base,
}, atVectorTime);
const a = res.attestation;
console.log("✅ AUDIT ATTESTED (within grant, NOT payment-bound, NOT broadcast)");
console.log("   host authority :", a.host_authority.slice(0, 20) + "…");
console.log("   intent         :", a.intent_id, "→", a.payees[0]?.slice(0, 22) + "…");
console.log("   vault signature:", a.signature.slice(0, 28) + "…");

// Independently verify the vault authority's signature over the attestation.
const digest = new Uint8Array(Buffer.from(a.body_sha256.replace("sha256:", ""), "hex"));
const sig = new Uint8Array(Buffer.from(a.signature, "base64url"));
const pub = new Uint8Array(Buffer.from(a.host_authority, "base64url"));
const good = await ed25519.verifyAsync(sig, digest, pub);
console.log("   → signature verifies against the host key:", good, "\n");

// REFUSE — host revocation is durable and caller context cannot undo it.
let refused = false;
setAgentGrantRevocationNonce(a.grant_id, 1);
try {
  await authorizeAgentPayment_wired(base, atVectorTime);
} catch (e: any) {
  refused = true;
  console.log("⛔ REFUSED (host-revoked):", String(e?.message ?? e).slice(0, 60));
}

const ok = res.authorized && good && refused;
console.log(`\n${ok ? "✅ AUDIT PROOF HOLDS" : "❌ unexpected"}: an unbound within-grant audit is vault-attested; host revocation is enforced; nothing is payment-bound or broadcast.\n`);
vault.lock();
process.exit(ok ? 0 : 1);
