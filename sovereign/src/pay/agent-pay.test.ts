import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed25519 from "@noble/ed25519";
import { canonicalJsonBytes } from "@agenttool/wallet";
import vectors from "@agenttool/wallet/vectors.json";
import { sha256 } from "@noble/hashes/sha2.js";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-agent-pay-test-"));
delete process.env.CASHLOOM_AGENT_TRUSTED_SIMULATION_KEY_IDS;

const { db } = await import("../db.ts");
const vault = await import("../vault.ts");
const { authorizeAgentPayment_wired } = await import("./agent-pay.ts");

const by = Object.fromEntries(
  (vectors as any).records.map((entry: any) => [entry.kind, entry.record]),
) as Record<string, any>;
const request = {
  descriptorJson: by.descriptor,
  capabilityJson: by.capability,
  intentJson: by.intent,
  simulationJson: by.simulation,
};
const runtime = {
  now: () => "2026-07-21T10:02:00.000Z",
  trustedSimulationKeyIds: [String(by.simulation.adapter.key_id)],
};

describe("Agent Wallet host boundary", () => {
  it("fails closed on adapter trust, reserves local usage atomically, attests once, and refuses replay", async () => {
    await vault.initialize("correct horse battery staple");

    await expect(
      authorizeAgentPayment_wired(request, {
        ...runtime,
        trustedSimulationKeyIds: [],
      }),
    ).rejects.toThrow(/No trusted Agent Wallet simulation adapters/);
    await expect(
      authorizeAgentPayment_wired(request, {
        ...runtime,
        trustedSimulationKeyIds: ["sha256:" + "0".repeat(64)],
      }),
    ).rejects.toThrow(/simulation signer is not trusted/);

    // Seed CashLoom's LOCAL durable usage at 20. The signed vector asks for
    // 10 under a max_total of 25, so caller-provided "fresh" usage could not
    // bypass this reservation.
    db.query(
      `INSERT INTO agent_capability_usage
         (grant_id, wallet_id, capability_record_id, intent_count, spent_json, updated_at)
       VALUES (?, ?, ?, 2, ?, ?)`,
    ).run(
      by.capability.grant_id,
      by.descriptor.wallet_id,
      by.capability.record_id,
      JSON.stringify([
        { asset_id: by.intent.declared_spends[0].asset_id, amount_atomic: "20" },
      ]),
      runtime.now(),
    );
    await expect(authorizeAgentPayment_wired(request, runtime)).rejects.toThrow(
      /Cumulative spend limit exceeded/,
    );

    db.query(
      `UPDATE agent_capability_usage
       SET intent_count = 0, spent_json = '[]'
       WHERE grant_id = ?`,
    ).run(by.capability.grant_id);

    const result = await authorizeAgentPayment_wired(request, runtime);
    const attestation = result.attestation;
    expect(attestation.status).toBe("authorized-not-bound");
    expect(attestation.payment_id).toBeNull();
    expect(attestation.intent_record_id).toBe(by.intent.record_id);
    expect(attestation.simulation_record_id).toBe(by.simulation.record_id);
    expect(attestation.simulation_adapter_key_id).toBe(by.simulation.adapter.key_id);

    const { body_sha256, signature, ...body } = attestation;
    const digest = sha256(canonicalJsonBytes(body));
    expect(body_sha256).toBe(`sha256:${Buffer.from(digest).toString("hex")}`);
    expect(
      await ed25519.verifyAsync(
        new Uint8Array(Buffer.from(signature, "base64url")),
        digest,
        new Uint8Array(Buffer.from(attestation.host_authority, "base64url")),
      ),
    ).toBe(true);

    const usage = db
      .query(
        "SELECT intent_count, spent_json FROM agent_capability_usage WHERE grant_id = ?",
      )
      .get(by.capability.grant_id) as { intent_count: number; spent_json: string };
    expect(usage.intent_count).toBe(1);
    expect(JSON.parse(usage.spent_json)).toEqual(by.intent.declared_spends);

    await expect(authorizeAgentPayment_wired(request, runtime)).rejects.toThrow(
      /already reserved|replay refused/,
    );
    const count = db
      .query("SELECT COUNT(*) AS count FROM agent_authorizations")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });
});
