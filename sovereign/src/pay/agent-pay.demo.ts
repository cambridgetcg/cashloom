/**
 * End-to-end proof of CashLoom's durable Agent Wallet authorization boundary,
 * with a real vault-signed attestation. This is evidence-only: it is not bound
 * to a CashLoom quote and cannot execute a payment.
 *
 *   CASHLOOM_DATA_DIR="$(mktemp -d)" bun src/pay/agent-pay.demo.ts
 */

import * as vault from "../vault.ts";
import * as ed25519 from "@noble/ed25519";
import vectors from "@agenttool/wallet/vectors.json";
import { authorizeAgentPayment_wired } from "./agent-pay.ts";

const by = Object.fromEntries((vectors as any).records.map((r: any) => [r.kind, r.record]));
const base = {
  descriptorJson: by.descriptor,
  capabilityJson: by.capability,
  intentJson: by.intent,
  simulationJson: by.simulation,
};
const trustedAdapter = by.simulation.adapter.key_id as string;
const runtime = {
  now: () => "2026-07-21T10:02:00.000Z",
  trustedSimulationKeyIds: [trustedAdapter],
};

await vault.initialize("throwaway-passphrase");
await vault.unlock("throwaway-passphrase");
console.log("\nvault: initialized + unlocked (throwaway)\n");

// PASS — an honest, within-grant intent under a locally trusted simulation.
const res = await authorizeAgentPayment_wired(base, runtime);
const a = res.attestation;
console.log("✅ AUTHORIZED (within grant, NOT bound or broadcast)");
console.log("   host authority :", a.host_authority.slice(0, 20) + "…");
console.log("   intent         :", a.intent_id, "→", a.payees[0]?.slice(0, 22) + "…");
console.log("   vault signature:", a.signature.slice(0, 28) + "…");

// Independently verify the vault authority's signature over the attestation.
const digest = new Uint8Array(Buffer.from(a.body_sha256.replace("sha256:", ""), "hex"));
const sig = new Uint8Array(Buffer.from(a.signature, "base64url"));
const pub = new Uint8Array(Buffer.from(a.host_authority, "base64url"));
const good = await ed25519.verifyAsync(sig, digest, pub);
console.log("   → signature verifies against the host key:", good, "\n");

// REFUSE — replaying the same signed intent cannot mint another reservation.
let refused = false;
try {
  await authorizeAgentPayment_wired(base, runtime);
} catch (e: any) {
  refused = true;
  console.log("⛔ REFUSED (replay):", String(e?.message ?? e).slice(0, 72));
}

const ok = res.authorized && good && refused;
console.log(`\n${ok ? "✅ HOST PROOF HOLDS" : "❌ unexpected"}: trusted evidence is reserved + vault-signed once; replay is refused; nothing is bound or broadcast.\n`);
vault.lock();
process.exit(ok ? 0 : 1);
