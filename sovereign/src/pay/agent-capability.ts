/**
 * The pre-broadcast gate for AGENT-submitted payments — cashloom dogfooding the
 * kingdom's own @agenttool/wallet primitive (Apache-2.0, love-package/v1).
 *
 * cashloom's pay()/PaymentSender must call this BEFORE it ever signs or
 * broadcasts an agent's transaction: an agent's signed INTENT is authorized only
 * if it fits a signed, unexpired, unrevoked CAPABILITY and a matching
 * SIMULATION — allowlist, per-intent AND cumulative spend caps, fee bounds, and
 * a host-supplied durable usage count are all checked here. The whole point:
 * a soul can pay, but a prompt-injected soul cannot be DRAINED — the cap is
 * enforced against the host's own record of what has already been spent.
 *
 * This module holds NO keys, contacts NO RPC, and moves NO money. It only
 * verifies signatures and returns a yes (an AuthorizedIntent) or throws a no.
 * That keeps it inside cashloom's non-custodial keystone: it observes and
 * authorizes; the durable host + an explicit adapter do the actual movement.
 */

import {
  verifyWalletDescriptor,
  verifyWalletCapability,
  verifyTransactionIntent,
  verifySimulationReceipt,
  assertIntentWithinCapabilityStatic,
  type AuthorizationContext,
  type AuthorizedIntent,
} from "@agenttool/wallet";

export interface AgentPaymentRequest {
  descriptorJson: unknown; // the agent wallet's signed descriptor record
  capabilityJson: unknown; // the delegated capability (spend caps, allowlist, deadline)
  intentJson: unknown; // the agent's signed transaction intent
  simulationJson: unknown; // an adapter's signed simulation of the intent's effects
  /**
   * The host's authoritative view at decision time: the current instant and the
   * capability's durable usage (revocation nonce, intent count, cumulative spend,
   * approvals). This MUST be read inside the same transaction that will record
   * the new spend, or the cap is not really a cap.
   */
  context: AuthorizationContext;
}

/**
 * Authorize (or refuse) an agent payment. Returns a frozen AuthorizedIntent on
 * success; THROWS on any violation — bad signature, expiry, revocation, an
 * allowlist miss, a per-intent overspend, or a cumulative overspend that would
 * drain the wallet past its granted total.
 */
export function authorizeAgentPayment(req: AgentPaymentRequest): Readonly<AuthorizedIntent> {
  const descriptor = verifyWalletDescriptor(req.descriptorJson);
  const capability = verifyWalletCapability(req.capabilityJson);
  const intent = verifyTransactionIntent(req.intentJson);
  const simulation = verifySimulationReceipt(req.simulationJson);
  return assertIntentWithinCapabilityStatic({
    descriptor,
    capability,
    intent,
    simulation,
    context: req.context,
  });
}
