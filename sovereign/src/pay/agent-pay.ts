/**
 * The capability gate, wired into cashloom's pay flow.
 *
 * A soul's payment does not reach the signer until it has PASSED the gate: its
 * signed intent must fit its signed capability — allowlist, per-intent and
 * cumulative spend caps, deadline, revocation — checked by @agenttool/wallet's
 * assertIntentWithinCapabilityStatic against the host's own durable usage. On
 * pass, cashloom's VAULT authority signs an authorization attestation binding
 * the intent, and records it as `authorized-not-broadcast`. Nothing is signed
 * on-chain and nothing is broadcast here: the actual send stays the deliberate
 * confirm step — now it may only proceed on a real, recorded authorization.
 *
 * Non-custodial throughout: the gate holds no keys, the authority key is
 * ed25519 (attests, cannot spend), and no money moves in this file.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import type { AuthorizationContext } from "@agenttool/wallet";
import { db, newId } from "../db.ts";
import { authorizeAgentPayment } from "./agent-capability.ts";
import { ensureHostAuthority, vaultRecordSigner } from "./host-authority.ts";

// The authorization ledger — an append-only record of what was authorized (and
// therefore may later be sent). Created on first import; harmless if it exists.
db.query(
  `CREATE TABLE IF NOT EXISTS agent_authorizations (
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
   )`,
).run();

export interface AgentPayRequest {
  descriptorJson: unknown;
  capabilityJson: unknown;
  intentJson: unknown;
  simulationJson: unknown;
  context: AuthorizationContext;
}

export interface AgentAuthorization {
  kind: "cashloom.authorization/0.1";
  intent_id: string;
  grant_id: string | null;
  source_account: string | null;
  declared_spends: unknown[];
  payees: string[];
  host_authority: string; // base64url ed25519 pubkey of the vault authority
  authorized_at: string;
  status: "authorized-not-broadcast";
  body_sha256: string; // sha256: of the canonical body (what the signature covers)
  signature: string; // base64url ed25519, the vault authority over body_sha256
}

/**
 * Run the gate; on authorize, vault-sign and record the authorization. Throws
 * (propagating the gate's own reason) on any refusal — an over-cap drain, an
 * expiry, a revocation, an allowlist miss, or a bad signature.
 */
export async function authorizeAgentPayment_wired(
  req: AgentPayRequest,
): Promise<{ authorized: true; attestation: AgentAuthorization }> {
  // 1. The gate. This is the checkpoint a soul's payment must pass.
  authorizeAgentPayment(req);

  // 2. cashloom attests the authorization, signed by its vault authority key.
  const intent = req.intentJson as Record<string, any>;
  const host = await ensureHostAuthority();
  const signer = await vaultRecordSigner(host.keyId, host.publicKey);

  const body = {
    kind: "cashloom.authorization/0.1" as const,
    intent_id: String(intent.intent_id),
    grant_id: intent.grant_id ?? null,
    source_account: intent.source_account ?? null,
    declared_spends: Array.isArray(intent.declared_spends) ? intent.declared_spends : [],
    payees: Array.isArray(intent.calls) ? intent.calls.map((c: any) => c.target_account) : [],
    host_authority: host.publicKey,
    authorized_at: req.context.now,
    status: "authorized-not-broadcast" as const,
  };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = sha256(bodyBytes);
  const body_sha256 = "sha256:" + Buffer.from(digest).toString("hex");
  const signature = await signer.sign_digest(digest);

  db.query(
    `INSERT INTO agent_authorizations
       (id, intent_id, grant_id, source_account, declared_spends, payees, host_authority, body_sha256, signature, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId(),
    body.intent_id,
    body.grant_id,
    body.source_account,
    JSON.stringify(body.declared_spends),
    JSON.stringify(body.payees),
    body.host_authority,
    body_sha256,
    signature,
    body.status,
    new Date().toISOString(),
  );

  return { authorized: true, attestation: { ...body, body_sha256, signature } };
}
