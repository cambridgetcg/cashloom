/**
 * CashLoom's durable host boundary for @agenttool/wallet authorization.
 *
 * This endpoint verifies signed descriptor/capability/intent/simulation
 * records, requires the simulation signer to be locally trusted, derives
 * capability usage from CashLoom's own SQLite file, and atomically reserves
 * the signed intent nonce + intent count + spend before returning a
 * vault-signed attestation.
 *
 * It deliberately does NOT claim to execute a payment. No chain payload is
 * decoded here and no CashLoom payment quote is bound to the intent yet. The
 * returned status is therefore `authorized-not-bound`, not permission for
 * confirmPayment() to sign or broadcast.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import {
  assertIntentWithinCapabilityStatic,
  canonicalJsonBytes,
  type AssetAmount,
  type AuthorizationContext,
} from "@agenttool/wallet";
import { db, newId } from "../db.ts";
import { verifyAgentPaymentRecords } from "./agent-capability.ts";
import { ensureHostAuthority, vaultRecordSigner } from "./host-authority.ts";

const TRUSTED_ADAPTERS_ENV = "CASHLOOM_AGENT_TRUSTED_SIMULATION_KEY_IDS";

// Keep the original columns for existing local databases, then grow the
// record with exact Agent Wallet identities. Nullable migration columns let a
// pre-hardening authorization remain visible without pretending it had these
// bindings.
db.query(
  `CREATE TABLE IF NOT EXISTS agent_authorizations (
     id                       TEXT PRIMARY KEY,
     intent_id                TEXT NOT NULL,
     grant_id                 TEXT,
     source_account           TEXT,
     declared_spends          TEXT NOT NULL,
     payees                   TEXT NOT NULL,
     host_authority           TEXT NOT NULL,
     body_sha256              TEXT NOT NULL,
     signature                TEXT NOT NULL,
     status                   TEXT NOT NULL,
     created_at               TEXT NOT NULL,
     wallet_id                TEXT,
     capability_record_id     TEXT,
     intent_record_id         TEXT,
     simulation_record_id     TEXT,
     policy_hash              TEXT,
     simulation_adapter_key_id TEXT,
     authorized_at            TEXT,
     intent_nonce             TEXT
   )`,
).run();

const authorizationColumns = new Set(
  (
    db.query("PRAGMA table_info(agent_authorizations)").all() as Array<{ name: string }>
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
  if (!authorizationColumns.has(column)) {
    db.exec(`ALTER TABLE agent_authorizations ADD COLUMN ${column} TEXT`);
  }
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_authorization_intent_record
   ON agent_authorizations(intent_record_id)
   WHERE intent_record_id IS NOT NULL`,
);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_authorization_signed_nonce
   ON agent_authorizations(wallet_id, grant_id, source_account, intent_nonce)
   WHERE wallet_id IS NOT NULL
     AND grant_id IS NOT NULL
     AND source_account IS NOT NULL
     AND intent_nonce IS NOT NULL`,
);

db.exec(`
CREATE TABLE IF NOT EXISTS agent_wallet_state (
  wallet_id         TEXT PRIMARY KEY,
  descriptor_id     TEXT NOT NULL,
  revocation_nonce  INTEGER NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_capability_usage (
  grant_id              TEXT PRIMARY KEY,
  wallet_id             TEXT NOT NULL,
  capability_record_id  TEXT NOT NULL,
  intent_count          INTEGER NOT NULL,
  spent_json            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
`);

export interface AgentPayRequest {
  descriptorJson: unknown;
  capabilityJson: unknown;
  intentJson: unknown;
  simulationJson: unknown;
}

export interface AgentPayRuntime {
  /** Test/local embedding seam. HTTP callers never control this value. */
  now?: () => string;
  /** Test/local embedding seam. Production defaults to the fail-closed env list. */
  trustedSimulationKeyIds?: readonly string[];
}

export interface AgentAuthorization {
  kind: "cashloom.authorization/0.2";
  wallet_id: string;
  intent_id: string;
  grant_id: string;
  source_account: string;
  capability_record_id: string;
  intent_record_id: string;
  simulation_record_id: string;
  policy_hash: string;
  simulation_adapter_key_id: string;
  declared_spends: AssetAmount[];
  payees: string[];
  host_authority: string;
  authorized_at: string;
  status: "authorized-not-bound";
  payment_id: null;
  body_sha256: string;
  signature: string;
}

type VerifiedAgentRecords = ReturnType<typeof verifyAgentPaymentRecords>;

interface WalletStateRow {
  descriptor_id: string;
  revocation_nonce: number;
}

interface CapabilityUsageRow {
  wallet_id: string;
  capability_record_id: string;
  intent_count: number;
  spent_json: string;
}

const trustedAdapterKeyIds = (runtime: AgentPayRuntime): Set<string> => {
  if (runtime.trustedSimulationKeyIds) {
    return new Set(runtime.trustedSimulationKeyIds.map((value) => value.trim()).filter(Boolean));
  }
  return new Set(
    (process.env[TRUSTED_ADAPTERS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
};

const aggregateSpent = (entries: readonly AssetAmount[]): AssetAmount[] => {
  const totals = new Map<string, bigint>();
  for (const entry of entries) {
    if (
      typeof entry?.asset_id !== "string"
      || typeof entry?.amount_atomic !== "string"
      || !/^(0|[1-9][0-9]*)$/.test(entry.amount_atomic)
    ) {
      throw new Error("CashLoom's stored Agent Wallet usage is malformed; refusing authorization.");
    }
    totals.set(entry.asset_id, (totals.get(entry.asset_id) ?? 0n) + BigInt(entry.amount_atomic));
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset_id, amount]) => ({ asset_id, amount_atomic: amount.toString() }));
};

const parseStoredSpent = (json: string): AssetAmount[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("CashLoom's stored Agent Wallet usage is unreadable; refusing authorization.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("CashLoom's stored Agent Wallet usage is malformed; refusing authorization.");
  }
  return aggregateSpent(parsed as AssetAmount[]);
};

const legacyUsage = (grantId: string): { intentCount: number; spent: AssetAmount[] } => {
  const rows = db
    .query(
      `SELECT declared_spends
       FROM agent_authorizations
       WHERE grant_id = ? AND status IN ('authorized-not-broadcast', 'authorized-not-bound')`,
    )
    .all(grantId) as Array<{ declared_spends: string }>;
  const entries = rows.flatMap(({ declared_spends }) => parseStoredSpent(declared_spends));
  return { intentCount: rows.length, spent: aggregateSpent(entries) };
};

const usageContext = (
  records: VerifiedAgentRecords,
  now: string,
): AuthorizationContext => {
  const wallet = db
    .query(
      "SELECT descriptor_id, revocation_nonce FROM agent_wallet_state WHERE wallet_id = ?",
    )
    .get(records.descriptor.wallet_id) as WalletStateRow | null;
  if (wallet && wallet.descriptor_id !== records.descriptor.record_id) {
    throw new Error(
      "CashLoom has not accepted continuity for this wallet descriptor rotation; refusing authorization.",
    );
  }

  const stored = db
    .query(
      `SELECT wallet_id, capability_record_id, intent_count, spent_json
       FROM agent_capability_usage WHERE grant_id = ?`,
    )
    .get(records.capability.grant_id) as CapabilityUsageRow | null;
  if (
    stored
    && (
      stored.wallet_id !== records.descriptor.wallet_id
      || stored.capability_record_id !== records.capability.record_id
    )
  ) {
    throw new Error(
      "This Agent Wallet grant id is already bound to a different capability; use a fresh grant.",
    );
  }
  const fallback = stored ? null : legacyUsage(records.capability.grant_id);
  return {
    now,
    usage: {
      // A newer authority-signed capability can advance the locally known
      // epoch inside the reservation transaction. An older one sees the
      // higher local value and is rejected as revoked.
      revocation_nonce: Math.max(
        wallet?.revocation_nonce ?? records.capability.revocation_nonce,
        records.capability.revocation_nonce,
      ),
      intent_count: stored?.intent_count ?? fallback!.intentCount,
      spent: stored ? parseStoredSpent(stored.spent_json) : fallback!.spent,
      // CashLoom has no approval-ingestion authority yet. Never accept
      // caller-supplied approval IDs; approval-gated calls fail closed.
      host_verified_approval_ids: [],
    },
  };
};

const reserveAndRecord = (
  records: VerifiedAgentRecords,
  now: string,
  body: Omit<AgentAuthorization, "body_sha256" | "signature">,
  bodySha256: string,
  signature: string,
): void => {
  const reserve = db.transaction(() => {
    const replay = db
      .query(
        `SELECT id FROM agent_authorizations
         WHERE intent_record_id = ?
            OR intent_id = ?
            OR (
              wallet_id = ?
              AND grant_id = ?
              AND source_account = ?
              AND intent_nonce = ?
            )
         LIMIT 1`,
      )
      .get(
        records.intent.record_id,
        records.intent.intent_id,
        records.descriptor.wallet_id,
        records.capability.grant_id,
        records.intent.source_account,
        records.intent.nonce,
      );
    if (replay) {
      throw new Error("This Agent Wallet intent was already reserved; replay refused.");
    }

    const wallet = db
      .query(
        "SELECT descriptor_id, revocation_nonce FROM agent_wallet_state WHERE wallet_id = ?",
      )
      .get(records.descriptor.wallet_id) as WalletStateRow | null;
    if (!wallet) {
      db.query(
        `INSERT INTO agent_wallet_state
           (wallet_id, descriptor_id, revocation_nonce, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        records.descriptor.wallet_id,
        records.descriptor.record_id,
        records.capability.revocation_nonce,
        now,
      );
    } else {
      if (wallet.descriptor_id !== records.descriptor.record_id) {
        throw new Error(
          "CashLoom has not accepted continuity for this wallet descriptor rotation; refusing authorization.",
        );
      }
      if (records.capability.revocation_nonce > wallet.revocation_nonce) {
        db.query(
          "UPDATE agent_wallet_state SET revocation_nonce = ?, updated_at = ? WHERE wallet_id = ?",
        ).run(records.capability.revocation_nonce, now, records.descriptor.wallet_id);
      }
    }

    // Re-read under BEGIN IMMEDIATE and repeat the package gate in the same
    // transaction that reserves the counter and cumulative spend.
    const context = usageContext(records, now);
    assertIntentWithinCapabilityStatic({ ...records, context });
    const nextSpent = aggregateSpent([
      ...context.usage.spent,
      ...records.intent.declared_spends,
    ]);
    const nextCount = context.usage.intent_count + 1;

    db.query(
      `INSERT INTO agent_authorizations
         (id, intent_id, grant_id, source_account, declared_spends, payees,
          host_authority, body_sha256, signature, status, created_at,
          wallet_id, capability_record_id, intent_record_id,
          simulation_record_id, policy_hash, simulation_adapter_key_id,
          authorized_at, intent_nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      body.intent_id,
      body.grant_id,
      body.source_account,
      JSON.stringify(body.declared_spends),
      JSON.stringify(body.payees),
      body.host_authority,
      bodySha256,
      signature,
      body.status,
      now,
      body.wallet_id,
      body.capability_record_id,
      body.intent_record_id,
      body.simulation_record_id,
      body.policy_hash,
      body.simulation_adapter_key_id,
      now,
      records.intent.nonce,
    );

    db.query(
      `INSERT INTO agent_capability_usage
         (grant_id, wallet_id, capability_record_id, intent_count, spent_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         intent_count = excluded.intent_count,
         spent_json = excluded.spent_json,
         updated_at = excluded.updated_at`,
    ).run(
      records.capability.grant_id,
      records.descriptor.wallet_id,
      records.capability.record_id,
      nextCount,
      JSON.stringify(nextSpent),
      now,
    );
  });
  reserve.immediate();
};

/**
 * Verify, trust-check, reserve, and attest an Agent Wallet intent.
 *
 * The second argument is an in-process test/embedding seam. The HTTP route
 * passes no runtime override, so network callers cannot choose time or trusted
 * adapters. Configure production adapter key IDs as a comma-separated
 * CASHLOOM_AGENT_TRUSTED_SIMULATION_KEY_IDS value.
 */
export async function authorizeAgentPayment_wired(
  req: AgentPayRequest,
  runtime: AgentPayRuntime = {},
): Promise<{ authorized: true; attestation: AgentAuthorization }> {
  const records = verifyAgentPaymentRecords(req);
  const trusted = trustedAdapterKeyIds(runtime);
  if (trusted.size === 0) {
    throw new Error(
      `No trusted Agent Wallet simulation adapters are configured (${TRUSTED_ADAPTERS_ENV}).`,
    );
  }
  if (!trusted.has(records.simulation.adapter.key_id)) {
    throw new Error("The Agent Wallet simulation signer is not trusted by this CashLoom node.");
  }

  const now = runtime.now?.() ?? new Date().toISOString();
  // Cheap fail-fast check before touching the vault. This is repeated under
  // the SQLite reservation lock after signing, so it is not the authority.
  const context = usageContext(records, now);
  assertIntentWithinCapabilityStatic({ ...records, context });

  const host = await ensureHostAuthority();
  const signer = await vaultRecordSigner(host.keyId, host.publicKey);
  const body = {
    kind: "cashloom.authorization/0.2" as const,
    wallet_id: records.descriptor.wallet_id,
    intent_id: records.intent.intent_id,
    grant_id: records.capability.grant_id,
    source_account: records.intent.source_account,
    capability_record_id: records.capability.record_id,
    intent_record_id: records.intent.record_id,
    simulation_record_id: records.simulation.record_id,
    policy_hash: records.capability.policy_hash,
    simulation_adapter_key_id: records.simulation.adapter.key_id,
    declared_spends: records.intent.declared_spends.map((entry) => ({ ...entry })),
    payees: records.intent.calls.map(({ target_account }) => target_account),
    host_authority: host.publicKey,
    authorized_at: now,
    status: "authorized-not-bound" as const,
    payment_id: null,
  };
  const digest = sha256(canonicalJsonBytes(body));
  const bodySha256 = `sha256:${Buffer.from(digest).toString("hex")}`;
  const signature = await signer.sign_digest(digest);

  reserveAndRecord(records, now, body, bodySha256, signature);
  return {
    authorized: true,
    attestation: { ...body, body_sha256: bodySha256, signature },
  };
}
