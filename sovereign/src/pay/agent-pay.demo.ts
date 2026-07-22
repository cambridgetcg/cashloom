/**
 * End-to-end proof that the capability gate is WIRED into the pay flow, with a
 * real vault-signed authorization. Run against a THROWAWAY vault so it touches
 * nothing real:
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
const ASSET = "eip155:84532/slip44:60";

await vault.initialize("throwaway-passphrase");
await vault.unlock("throwaway-passphrase");
console.log("\nvault: initialized + unlocked (throwaway)\n");

// PASS — an honest, within-grant payment.
const res = await authorizeAgentPayment_wired({
  ...base,
  context: { now: "2026-07-21T10:02:00.000Z", usage: { revocation_nonce: 0, intent_count: 0, spent: [], host_verified_approval_ids: [] } },
});
const a = res.attestation;
console.log("✅ AUTHORIZED (within grant, NOT broadcast)");
console.log("   host authority :", a.host_authority.slice(0, 20) + "…");
console.log("   intent         :", a.intent_id, "→", a.payees[0]?.slice(0, 22) + "…");
console.log("   vault signature:", a.signature.slice(0, 28) + "…");

// Independently verify the vault authority's signature over the attestation.
const digest = new Uint8Array(Buffer.from(a.body_sha256.replace("sha256:", ""), "hex"));
const sig = new Uint8Array(Buffer.from(a.signature, "base64url"));
const pub = new Uint8Array(Buffer.from(a.host_authority, "base64url"));
const good = await ed25519.verifyAsync(sig, digest, pub);
console.log("   → signature verifies against the host key:", good, "\n");

// REFUSE — the same intent would drain past the cumulative cap.
let refused = false;
try {
  await authorizeAgentPayment_wired({
    ...base,
    context: { now: "2026-07-21T10:02:00.000Z", usage: { revocation_nonce: 0, intent_count: 0, spent: [{ asset_id: ASSET, amount_atomic: "20" }], host_verified_approval_ids: [] } },
  });
} catch (e: any) {
  refused = true;
  console.log("⛔ REFUSED (would drain):", String(e?.message ?? e).slice(0, 60));
}

const ok = res.authorized && good && refused;
console.log(`\n${ok ? "✅ WIRED PROOF HOLDS" : "❌ unexpected"}: a within-grant payment is authorized + vault-signed; a drain is refused; nothing is broadcast.\n`);
vault.lock();
process.exit(ok ? 0 : 1);
