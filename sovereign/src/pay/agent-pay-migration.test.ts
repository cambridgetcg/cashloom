import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vectors from "@agenttool/wallet/vectors.json";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(
  join(tmpdir(), "cashloom-agent-pay-migration-test-"),
);

const { db, newId } = await import("../db.ts");

// Exact pre-hardening shape from CashLoom main. agent-pay.ts must grow this
// table in place without deleting its authorization history.
db.exec(`
CREATE TABLE agent_authorizations (
  id              TEXT PRIMARY KEY,
  intent_id       TEXT NOT NULL,
  grant_id        TEXT,
  source_account  TEXT,
  declared_spends TEXT NOT NULL,
  payees          TEXT NOT NULL,
  host_authority  TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  signature       TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
`);

const by = Object.fromEntries(
  (vectors as any).records.map((entry: any) => [entry.kind, entry.record]),
) as Record<string, any>;
db.query(
  `INSERT INTO agent_authorizations
     (id, intent_id, grant_id, source_account, declared_spends, payees,
      host_authority, body_sha256, signature, status, created_at)
   VALUES (?, ?, ?, ?, ?, '[]', 'legacy-host', ?, 'legacy-signature',
           'authorized-not-broadcast', ?)`,
).run(
  newId(),
  "legacy-intent",
  by.capability.grant_id,
  by.intent.source_account,
  JSON.stringify([
    { asset_id: by.intent.declared_spends[0].asset_id, amount_atomic: "20" },
  ]),
  `sha256:${"0".repeat(64)}`,
  "2026-07-21T10:01:00.000Z",
);

const { authorizeAgentPayment_wired } = await import("./agent-pay.ts");

describe("Agent Wallet host migration", () => {
  it("grows the old table in place and carries legacy spend into the cap", async () => {
    const columns = new Set(
      (
        db.query("PRAGMA table_info(agent_authorizations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const column of [
      "wallet_id",
      "capability_record_id",
      "intent_record_id",
      "simulation_record_id",
      "policy_hash",
      "simulation_adapter_key_id",
      "authorized_at",
      "intent_nonce",
    ]) {
      expect(columns.has(column), column).toBe(true);
    }

    await expect(
      authorizeAgentPayment_wired(
        {
          descriptorJson: by.descriptor,
          capabilityJson: by.capability,
          intentJson: by.intent,
          simulationJson: by.simulation,
        },
        {
          now: () => "2026-07-21T10:02:00.000Z",
          trustedSimulationKeyIds: [by.simulation.adapter.key_id],
        },
      ),
    ).rejects.toThrow(/Cumulative spend limit exceeded/);

    const legacy = db
      .query(
        "SELECT status, declared_spends FROM agent_authorizations WHERE intent_id = 'legacy-intent'",
      )
      .get() as { status: string; declared_spends: string };
    expect(legacy.status).toBe("authorized-not-broadcast");
    expect(JSON.parse(legacy.declared_spends)[0].amount_atomic).toBe("20");

    const indexes = new Set(
      (
        db.query("PRAGMA index_list(agent_authorizations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    expect(indexes.has("idx_agent_authorization_signed_nonce")).toBe(true);
  });
});
