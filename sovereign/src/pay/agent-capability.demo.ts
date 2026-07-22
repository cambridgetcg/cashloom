/**
 * Proof that cashloom's pay seam can gate an agent payment with @agenttool/wallet.
 * Uses the package's own deterministic public vectors (valid signed records), so
 * this is a REAL round-trip — verify + the actual capability gate — not a mock.
 *
 *   bun src/pay/agent-capability.demo.ts
 *
 * One capability grants: spend ≤ 10 per intent, ≤ 25 cumulative, of one asset,
 * to one allowlisted account, inside a one-hour window. We then ask the gate to
 * authorize the same signed intent under four host situations. Only the honest
 * one is authorized; the three drain/expiry/revoke situations are refused.
 */

import { authorizeAgentPayment } from "./agent-capability.ts";
import vectors from "@agenttool/wallet/vectors.json";
import type { AuthorizationContext } from "@agenttool/wallet";

const by = Object.fromEntries((vectors as any).records.map((r: any) => [r.kind, r.record]));
const base = {
  descriptorJson: by.descriptor,
  capabilityJson: by.capability,
  intentJson: by.intent,
  simulationJson: by.simulation,
};
const ASSET = "eip155:84532/slip44:60";
const fresh = { revocation_nonce: 0, intent_count: 0, spent: [], host_verified_approval_ids: [] };

function attempt(label: string, context: AuthorizationContext): boolean {
  try {
    authorizeAgentPayment({ ...base, context });
    console.log(`  ✅ AUTHORIZED  ${label}`);
    return true;
  } catch (e: any) {
    console.log(`  ⛔ REFUSED     ${label}\n                 └ ${String(e?.message ?? e).slice(0, 100)}`);
    return false;
  }
}

console.log("\n@agenttool/wallet × cashloom pay seam — capability gate\n");
console.log("capability: ≤10/intent, ≤25 total, one allowlisted payee, 10:00–11:00 window\n");

const ok = attempt("honest spend (10, nothing spent yet, inside window)", {
  now: "2026-07-21T10:02:00.000Z",
  usage: fresh,
});
const drain = attempt("would DRAIN (20 already spent → +10 = 30 > 25 total cap)", {
  now: "2026-07-21T10:02:00.000Z",
  usage: { ...fresh, spent: [{ asset_id: ASSET, amount_atomic: "20" }] },
});
const expired = attempt("EXPIRED (now 10:10 is past the intent's 10:06 deadline)", {
  now: "2026-07-21T10:10:00.000Z",
  usage: fresh,
});
const revoked = attempt("REVOKED (host revocation nonce 1 ≠ capability nonce 0)", {
  now: "2026-07-21T10:02:00.000Z",
  usage: { ...fresh, revocation_nonce: 1 },
});

const pass = ok && !drain && !expired && !revoked;
console.log(`\n${pass ? "✅ PROOF HOLDS" : "❌ unexpected"}: a soul can pay within its grant, and cannot be drained, expired-past, or spent after revocation.\n`);
process.exit(pass ? 0 : 1);
