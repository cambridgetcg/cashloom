/**
 * Host-authoritative @agenttool/wallet capability gate.
 *
 * The caller supplies signed records, never its own usage truth. CashLoom
 * derives revocation/intent/spend usage from SQLite and reserves the new spend
 * in the same IMMEDIATE transaction that records the authorization. The vault
 * authority then attests that durable decision; no chain signature is made.
 * Base payment-bound requests remain proposal-only because the standard's
 * signed max_fee is a hard bound and Base's full protocol fee is not.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import {
  verifyTransactionIntent,
  verifySimulationReceipt,
  verifyWalletCapability,
  verifyWalletDescriptor,
  type AssetAmount,
  type AuthorizationContext,
} from "@agenttool/wallet";
import { db, newId } from "../db.ts";
import { canonicalizeJson } from "../wallet/domain/intent.ts";
import { parsePreparedEvmQuote } from "../senders/evm.sender.ts";
import { authorizeAgentPayment } from "./agent-capability.ts";
import { ensureHostAuthority, vaultRecordSigner } from "./host-authority.ts";

export interface AgentPayRequest {
  descriptorJson: unknown;
  capabilityJson: unknown;
  intentJson: unknown;
  simulationJson: unknown;
  /** Optional payment quote to bind. Base-bound requests are proposal-only. */
  paymentId?: string;
  /** Accepted only for old clients and deliberately ignored. */
  context?: unknown;
}

export interface AgentAuthorization {
  kind: "cashloom.authorization/0.2";
  authorization_id: string;
  payment_intent_id: string | null;
  wallet_id: string;
  intent_id: string;
  grant_id: string;
  delegate_key_id: string;
  source_account: string;
  declared_spends: AssetAmount[];
  call_targets: string[];
  payees: string[];
  host_authority: string;
  authorized_at: string;
  status: "authorized-not-broadcast";
  body_sha256: string;
  signature: string;
}

/** Exact signed records an owner pins when minting a delegated session.
 * Caller-supplied records being mutually valid is not, by itself, authority. */
export interface AgentTrustBinding {
  walletId: string;
  descriptorRecordId: string;
  ownerKeyId: string;
  grantId: string;
  capabilityRecordId: string;
  delegateKeyId: string;
  trustedSimulationAdapterKeyIds: readonly string[];
}

const assertOwnerPinnedTrust = (
  trust: AgentTrustBinding,
  descriptor: ReturnType<typeof verifyWalletDescriptor>,
  capability: ReturnType<typeof verifyWalletCapability>,
  simulation: ReturnType<typeof verifySimulationReceipt>,
): void => {
  if (
    descriptor.wallet_id !== trust.walletId ||
    descriptor.record_id !== trust.descriptorRecordId ||
    descriptor.authority.key_id !== trust.ownerKeyId ||
    capability.wallet_id !== trust.walletId ||
    capability.descriptor_id !== trust.descriptorRecordId ||
    capability.issuer.key_id !== trust.ownerKeyId ||
    capability.grant_id !== trust.grantId ||
    capability.record_id !== trust.capabilityRecordId ||
    capability.delegate.key_id !== trust.delegateKeyId ||
    !trust.trustedSimulationAdapterKeyIds.includes(simulation.adapter.key_id)
  ) {
    throw new Error(
      "Signed agent records do not match the owner-pinned wallet, capability, delegate, and simulation trust root.",
    );
  }
};

const parseUsage = (value: string): AssetAmount[] => {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored capability usage is malformed.");
  return parsed.map((entry) => {
    const amount = entry as Partial<AssetAmount>;
    if (
      typeof amount.asset_id !== "string" ||
      typeof amount.amount_atomic !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(amount.amount_atomic)
    ) {
      throw new Error("Stored capability spend usage is malformed.");
    }
    return { asset_id: amount.asset_id, amount_atomic: amount.amount_atomic };
  });
};

const addSpend = (before: AssetAmount[], next: AssetAmount[]): AssetAmount[] => {
  const totals = new Map<string, bigint>();
  for (const item of [...before, ...next]) {
    if (!/^(0|[1-9][0-9]*)$/.test(item.amount_atomic)) {
      throw new Error("Agent intent contains a non-canonical spend amount.");
    }
    totals.set(item.asset_id, (totals.get(item.asset_id) ?? 0n) + BigInt(item.amount_atomic));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([asset_id, amount]) => ({ asset_id, amount_atomic: amount.toString() }));
};

const BASE_CHAIN = "eip155:8453";

const caipAccount = (chainId: string, address: string): string =>
  `${chainId}:${address.toLowerCase()}`;

const exactPayload = (payloadB64u: string, expectedHex: string): boolean => {
  const payload = Buffer.from(payloadB64u, "base64url");
  const expected = Buffer.from(expectedHex.startsWith("0x") ? expectedHex.slice(2) : expectedHex, "hex");
  return payload.equals(expected);
};

const assertPaymentBinding = (
  paymentId: string | undefined,
  intent: ReturnType<typeof verifyTransactionIntent>,
  simulation: ReturnType<typeof verifySimulationReceipt>,
): void => {
  if (!paymentId) return;
  const row = db.query(
    `SELECT p.status, p.rail, p.to_addr, p.asset, p.amount_minor, p.detail,
            i.asset_id, a.account_ref, a.chain_id
     FROM payments p
     JOIN wk_payment_intents i ON i.id=p.id
     JOIN wk_accounts a ON a.id=i.source_account_id
     WHERE p.id=?`,
  ).get(paymentId) as
    | {
        status: string;
        rail: string;
        to_addr: string;
        asset: string;
        amount_minor: string;
        detail: string | null;
        asset_id: string;
        account_ref: string | null;
        chain_id: string | null;
      }
    | null;
  if (!row || row.status !== "quoted") {
    throw new Error("Agent authorization must bind an existing fresh payment quote.");
  }
  if (row.rail !== "evm-base" || row.chain_id !== BASE_CHAIN || !row.account_ref) {
    throw new Error("Payment-bound agent authorization currently requires an explicit Base account.");
  }
  const prepared = parsePreparedEvmQuote({
    to: row.to_addr,
    amountMinor: row.amount_minor,
    asset: row.asset,
    detail: row.detail,
  });
  if (prepared.detail.v !== 2) {
    throw new Error(
      "Legacy Base quotes do not disclose complete protocol fee terms and remain human-confirm only.",
    );
  }
  const call = intent.calls.length === 1 ? intent.calls[0] : null;
  const beneficiary = caipAccount(BASE_CHAIN, prepared.detail.recipient);
  const callTarget = row.asset === "USDC"
    ? caipAccount(BASE_CHAIN, prepared.detail.to)
    : beneficiary;
  const payloadHex = prepared.detail.data ?? "0x";
  const payloadMatches = call !== null && exactPayload(call.payload_b64u, payloadHex);
  const payloadDigest = call
    ? `sha256:${Buffer.from(sha256(Buffer.from(call.payload_b64u, "base64url"))).toString("hex")}`
    : null;
  const declaredSpendMatches =
    intent.declared_spends.length === 1 &&
    intent.declared_spends[0]?.asset_id === row.asset_id &&
    intent.declared_spends[0]?.amount_atomic === row.amount_minor;
  const nativeValueMatches = row.asset === "ETH"
    ? call?.native_value?.asset_id === row.asset_id &&
      call.native_value.amount_atomic === row.amount_minor
    : call?.native_value === null;
  const callShapeMatches = row.asset === "ETH"
    ? call?.action === "transfer" && call.method === null
    : call?.action === "call" && call.method === "transfer";
  const effect = simulation.effects.length === 1 ? simulation.effects[0] : null;
  const simulationMatches =
    effect?.action === "transfer" &&
    effect.target_account.toLowerCase() === beneficiary &&
    effect.method === null &&
    effect.asset_id === row.asset_id &&
    effect.amount_atomic === row.amount_minor;
  if (
    row.account_ref.toLowerCase() !== intent.source_account.toLowerCase() ||
    row.chain_id !== intent.chain_id ||
    prepared.detail.from.toLowerCase() !== row.account_ref.slice(BASE_CHAIN.length + 1).toLowerCase() ||
    prepared.detail.recipient.toLowerCase() !== row.to_addr.toLowerCase() ||
    !call ||
    !callShapeMatches ||
    call.target_account.toLowerCase() !== callTarget ||
    !payloadMatches ||
    call.payload_hash !== payloadDigest ||
    !declaredSpendMatches ||
    !nativeValueMatches ||
    !simulationMatches
  ) {
    throw new Error(
      "Signed agent intent does not exactly match the quoted source, destination, calldata, asset, and amount.",
    );
  }
  throw new Error(
    "Base payment-bound autonomous authorization is proposal-only: @agenttool/wallet intent.max_fee is a signed hard bound, but Base L1 data/security and operator charges are not transaction-hard-capped.",
  );
};

const rowToAttestation = (row: {
  id: string;
  payment_intent_id: string | null;
  wallet_id: string;
  intent_id: string;
  grant_id: string;
  delegate_key_id: string;
  source_account: string;
  declared_spends_json: string;
  payees_json: string;
  host_authority: string;
  created_at: string;
  body_sha256: string;
  signature: string | null;
  body_json: string;
}): AgentAuthorization => {
  if (!row.signature) throw new Error("Agent authorization attestation is not signed yet.");
  const body = JSON.parse(row.body_json) as { call_targets?: unknown };
  const callTargets = Array.isArray(body.call_targets) && body.call_targets.every(
    (target) => typeof target === "string",
  ) ? body.call_targets as string[] : [];
  return {
    kind: "cashloom.authorization/0.2",
    authorization_id: row.id,
    payment_intent_id: row.payment_intent_id,
    wallet_id: row.wallet_id,
    intent_id: row.intent_id,
    grant_id: row.grant_id,
    delegate_key_id: row.delegate_key_id,
    source_account: row.source_account,
    declared_spends: JSON.parse(row.declared_spends_json) as AssetAmount[],
    call_targets: callTargets,
    payees: JSON.parse(row.payees_json) as string[],
    host_authority: row.host_authority,
    authorized_at: row.created_at,
    status: "authorized-not-broadcast",
    body_sha256: row.body_sha256,
    signature: row.signature,
  };
};

export async function authorizeAgentPayment_wired(
  req: AgentPayRequest,
  runtime: {
    now?: () => Date;
    expectedDelegateKeyId?: string;
    expectedTrust?: AgentTrustBinding;
  } = {},
): Promise<{ authorized: true; attestation: AgentAuthorization }> {
  // Verify enough outside the transaction to locate host-owned usage. The
  // complete signed-record gate is repeated inside the reservation transaction.
  const descriptor = verifyWalletDescriptor(req.descriptorJson);
  const capability = verifyWalletCapability(req.capabilityJson);
  const signedIntent = verifyTransactionIntent(req.intentJson);
  const simulation = verifySimulationReceipt(req.simulationJson);
  if (signedIntent.grant_id !== capability.grant_id) {
    throw new Error("Agent intent and capability grant do not match.");
  }
  if (
    runtime.expectedDelegateKeyId !== undefined &&
    signedIntent.delegate.key_id !== runtime.expectedDelegateKeyId
  ) {
    throw new Error("Signed agent intent does not belong to this delegated session principal.");
  }
  if (runtime.expectedTrust) {
    if (runtime.expectedTrust.delegateKeyId !== runtime.expectedDelegateKeyId) {
      throw new Error("Delegated session principal and owner-pinned trust root disagree.");
    }
    assertOwnerPinnedTrust(runtime.expectedTrust, descriptor, capability, simulation);
  }
  assertPaymentBinding(
    req.paymentId,
    signedIntent,
    simulation,
  );
  const host = await ensureHostAuthority();
  const now = (runtime.now?.() ?? new Date()).toISOString();
  const expiresAt = new Date(
    Math.min(
      Date.parse(capability.expires_at),
      Date.parse(signedIntent.expires_at),
      Date.parse(simulation.valid_until),
    ),
  ).toISOString();

  const reserved = db.transaction(() => {
    // Re-prove the live quote binding under SQLite's write lock. Validation
    // above gives fast errors; this copy closes mutation between check and
    // durable budget/authorization reservation.
    assertPaymentBinding(
      req.paymentId,
      signedIntent,
      simulation,
    );
    if (runtime.expectedTrust) {
      assertOwnerPinnedTrust(runtime.expectedTrust, descriptor, capability, simulation);
    }
    const prior = db.query(
      "SELECT * FROM wk_agent_authorizations WHERE intent_record_id=?",
    ).get(signedIntent.record_id) as Record<string, string | null> | null;
    if (prior) {
      const usageRow = db.query(
        "SELECT revocation_nonce FROM wk_agent_capability_usage WHERE grant_id=?",
      ).get(capability.grant_id) as { revocation_nonce: number } | null;
      if (
        prior.status === "CONSUMED" ||
        prior.status === "REVOKED" ||
        usageRow?.revocation_nonce !== capability.revocation_nonce ||
        !prior.expires_at ||
        Date.parse(String(prior.expires_at)) <= Date.parse(now)
      ) {
        if (prior.status !== "CONSUMED") {
          db.query(
            "UPDATE wk_agent_authorizations SET status='REVOKED' WHERE id=?",
          ).run(prior.id);
        }
        return { row: prior, newlyReserved: false, refused: true };
      }
      return { row: prior, newlyReserved: false, refused: false };
    }

    const usageRow = db.query(
      "SELECT revocation_nonce, intent_count, spent_json FROM wk_agent_capability_usage WHERE grant_id=?",
    ).get(capability.grant_id) as
      | { revocation_nonce: number; intent_count: number; spent_json: string }
      | null;
    const usage = {
      revocation_nonce: usageRow?.revocation_nonce ?? capability.revocation_nonce,
      intent_count: usageRow?.intent_count ?? 0,
      spent: usageRow ? parseUsage(usageRow.spent_json) : [],
      host_verified_approval_ids: [],
    };
    const context: AuthorizationContext = { now, usage };
    const authorized = authorizeAgentPayment({
      descriptorJson: req.descriptorJson,
      capabilityJson: req.capabilityJson,
      intentJson: req.intentJson,
      simulationJson: req.simulationJson,
      context,
    });
    const id = newId();
    const declaredSpends = signedIntent.declared_spends;
    const callTargets = [...new Set(signedIntent.calls.map((call) => call.target_account))].sort();
    const economicPayees = simulation.effects
      .filter((effect) => effect.asset_id !== null && BigInt(effect.amount_atomic) > 0n)
      .map((effect) => effect.target_account);
    const payees = [...new Set(economicPayees.length > 0 ? economicPayees : callTargets)].sort();
    const body = {
      kind: "cashloom.authorization/0.2" as const,
      authorization_id: id,
      payment_intent_id: req.paymentId ?? null,
      wallet_id: authorized.wallet_id,
      intent_id: signedIntent.intent_id,
      grant_id: authorized.grant_id,
      delegate_key_id: signedIntent.delegate.key_id,
      source_account: signedIntent.source_account,
      declared_spends: declaredSpends.map((spend) => ({
        asset_id: spend.asset_id,
        amount_atomic: spend.amount_atomic,
      })),
      call_targets: callTargets,
      payees,
      host_authority: host.publicKey,
      authorized_at: now,
      status: "authorized-not-broadcast" as const,
      owner_pinned_trust: runtime.expectedTrust
        ? {
            descriptor_record_id: runtime.expectedTrust.descriptorRecordId,
            owner_key_id: runtime.expectedTrust.ownerKeyId,
            capability_record_id: runtime.expectedTrust.capabilityRecordId,
            simulation_adapter_key_id: simulation.adapter.key_id,
          }
        : null,
    };
    const bodyJson = canonicalizeJson(body);
    const digest = sha256(new TextEncoder().encode(bodyJson));
    const bodySha256 = `sha256:${Buffer.from(digest).toString("hex")}`;
    db.query(
      `INSERT INTO wk_agent_authorizations
         (id, payment_intent_id, wallet_id, grant_id, grant_revocation_nonce, delegate_key_id, capability_record_id,
          intent_id, intent_record_id, simulation_record_id, policy_hash,
          source_account, declared_spends_json, payees_json, body_json,
          body_sha256, host_authority, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)`,
    ).run(
      id,
      req.paymentId ?? null,
      authorized.wallet_id,
      authorized.grant_id,
      capability.revocation_nonce,
      signedIntent.delegate.key_id,
      authorized.capability_record_id,
      signedIntent.intent_id,
      authorized.intent_record_id,
      authorized.simulation_record_id,
      authorized.policy_hash,
      signedIntent.source_account,
      JSON.stringify(declaredSpends),
      JSON.stringify(payees),
      bodyJson,
      bodySha256,
      host.publicKey,
      expiresAt,
      now,
    );
    const nextSpent = addSpend(usage.spent, declaredSpends);
    db.query(
      `INSERT INTO wk_agent_capability_usage
         (grant_id, revocation_nonce, intent_count, spent_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         revocation_nonce=excluded.revocation_nonce,
         intent_count=excluded.intent_count,
         spent_json=excluded.spent_json,
         updated_at=excluded.updated_at`,
    ).run(
      capability.grant_id,
      usage.revocation_nonce,
      usage.intent_count + 1,
      JSON.stringify(nextSpent),
      now,
    );
    const row = db.query("SELECT * FROM wk_agent_authorizations WHERE id=?").get(id) as Record<
      string,
      string | null
    >;
    return { row, newlyReserved: true, refused: false };
  }).immediate();

  if (reserved.refused) {
    throw new Error("Agent authorization is already consumed, expired, or revoked by host state.");
  }

  let row = reserved.row;
  if (!row.signature) {
    const signer = await vaultRecordSigner(host.keyId, host.publicKey);
    const digest = Buffer.from(String(row.body_sha256).slice("sha256:".length), "hex");
    const signature = await signer.sign_digest(digest);
    db.query(
      `UPDATE wk_agent_authorizations
       SET signature=?, status='ATTESTED', attested_at=?
       WHERE id=? AND status='RESERVED' AND body_sha256=?`,
    ).run(signature, new Date().toISOString(), row.id, row.body_sha256);
    row = db.query("SELECT * FROM wk_agent_authorizations WHERE id=?").get(row.id) as Record<
      string,
      string | null
    >;
  }
  return {
    authorized: true,
    attestation: rowToAttestation(row as Parameters<typeof rowToAttestation>[0]),
  };
}

export const setAgentGrantRevocationNonce = (
  grantId: string,
  revocationNonce: number,
): void => {
  if (!Number.isSafeInteger(revocationNonce) || revocationNonce < 0) {
    throw new Error("Revocation nonce must be a non-negative safe integer.");
  }
  const current = db.query(
    "SELECT revocation_nonce FROM wk_agent_capability_usage WHERE grant_id=?",
  ).get(grantId) as { revocation_nonce: number } | null;
  if (current && revocationNonce < current.revocation_nonce) {
    throw new Error("Revocation nonce cannot move backwards.");
  }
  db.transaction(() => {
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO wk_agent_capability_usage
         (grant_id, revocation_nonce, intent_count, spent_json, updated_at)
       VALUES (?, ?, 0, '[]', ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         revocation_nonce=excluded.revocation_nonce, updated_at=excluded.updated_at`,
    ).run(grantId, revocationNonce, now);
    db.query(
      `UPDATE wk_agent_authorizations SET status='REVOKED'
       WHERE grant_id=? AND grant_revocation_nonce<>?
         AND status IN ('RESERVED','ATTESTED')`,
    ).run(grantId, revocationNonce);
  }).immediate();
};
