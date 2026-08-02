/**
 * The public CashLoom capability contract.
 *
 * This value is deliberately static and secretless. The hosted info node
 * serves it as JSON and the Atlas imports the same value at build time, so the
 * human and machine doors cannot quietly tell different stories. Nothing in
 * this module imports a vault, database, protocol router, processor, or sender.
 */

export const CASHLOOM_CAPABILITIES = {
  schema: "cashloom/capabilities/v1",
  name: "CashLoom",
  implementation_version: "0.1.0",
  source: "https://github.com/cambridgetcg/cashloom",
  license: "MIT",
  promise: "Money you can read. Payment authority you keep.",

  hosted_surface: {
    mode: "information_only",
    canonical_api: "https://cashloom-api.fly.dev",
    moves_money: false,
    holds_funds: false,
    holds_keys: false,
    stores_payment_records: false,
    requires_cashloom_account: false,
    identity_authority: "none",
    authority_note:
      "cashloom.io and the hosted info API are optional maps. Neither is in a participant's payment or identity authority path.",
    privacy_note:
      "CashLoom persists no hosted profile, keys, or payment state. Hosting and network infrastructure may still log requests, and public-address lookups reveal those addresses to the selected upstream source.",
  },

  participant_node: {
    mode: "sovereign_local",
    default_origin: "http://127.0.0.1:4747",
    dashboard: "http://127.0.0.1:4747",
    custody: "local encrypted vault",
    records:
      "append-only signed v2 records in local SQLite, alongside mutable operational payment state",
    identity:
      "a self-certifying Ed25519 node key held in the participant's local vault",
    run: [
      "git clone https://github.com/cambridgetcg/cashloom.git",
      "cd cashloom/sovereign",
      "bun install --frozen-lockfile",
      "bun run build:ui",
      "bun start",
    ],
    warning:
      "Preparing a Bitcoin payment reveals the chosen public source address to the configured Esplora service. Bitcoin settlement is public and linkable on-chain.",
  },

  doors: [
    {
      id: "learn",
      label: "Understand the loom",
      href: "https://cashloom.io/#truth",
      kind: "hosted_static_map",
      authority: "none",
      requires_account: false,
    },
    {
      id: "source",
      label: "Run or fork the node",
      href: "https://github.com/cambridgetcg/cashloom",
      kind: "open_source",
      authority: "participant",
      requires_account: false,
    },
    {
      id: "dashboard",
      label: "Open your local dashboard",
      href: "http://127.0.0.1:4747",
      kind: "local_application",
      authority: "participant",
      requires_account: false,
      available_when: "the participant's sovereign node is running",
    },
  ],

  portable_artifacts: [
    {
      extension: ".cashloom-pay",
      visibility: "public",
      status: "implemented",
      meaning:
        "a signed Bitcoin payment request that can travel by file, paste, chat, or USB",
      does_not_mean:
        "acceptance, reservation, authorization, submission, or settlement",
    },
    {
      extension: ".cashloom-accept",
      visibility: "sensitive_plaintext_for_the_named_merchant",
      status: "implemented",
      meaning:
        "signed payer acceptance evidence bound to the exact request and source address",
      does_not_mean:
        "confidentiality, funds moved, funds reserved, submission, settlement, escrow, or delivery",
    },
  ],

  distribution: [
    {
      id: "source",
      status: "available",
      format: "Git repository",
      reason: "the current auditable and reproducible way to run a node",
    },
    {
      id: "portable_payment_files",
      status: "available",
      format: ".cashloom-pay and .cashloom-accept",
      reason: "offline handoff without making cashloom.io a relay",
    },
    {
      id: "standalone_executables",
      status: "planned_not_released",
      format: "checksummed GitHub Release artifacts",
      reason:
        "cross-platform builds, asset embedding, signing, upgrade integrity, and recovery still need a release contract",
    },
    {
      id: "desktop_app",
      status: "considering_not_released",
      format: "local desktop shell around the sovereign node",
      reason:
        "the node and dashboard come first; a desktop wrapper must not introduce a vendor account or remote authority",
    },
  ],

  distribution_policy: {
    source_and_artifacts_may_be_mirrored: true,
    one_required_download_host: false,
    update_service_is_protocol_authority: false,
  },

  payment_truth: [
    {
      id: "request",
      status: "implemented",
      label: "Request",
      proves: "the named requester signed these payment terms",
      does_not_prove: "the payer saw, accepted, reserved, or paid them",
    },
    {
      id: "acceptance",
      status: "implemented_for_bitcoin_pay_links",
      label: "Acceptance",
      proves: "the named payer key signed an intent bound to the exact request",
      does_not_prove: "funds moved, funds were reserved, or the merchant delivered",
    },
    {
      id: "commitment",
      status: "implemented_for_local_bitcoin_execution",
      label: "Commitment",
      proves:
        "the payer confirmed one exact local review, fee, and unsigned transaction",
      does_not_prove:
        "broadcast acceptance, confirmations, settlement, or fulfillment",
    },
    {
      id: "submission_receipt",
      status: "receipt_schema_defined_workflow_not_released",
      label: "Submission receipt",
      proves:
        "only rail-authenticated evidence can prove a transaction entered the rail",
      does_not_prove:
        "final settlement, irreversibility, delivery, or absence of a later adjustment",
    },
    {
      id: "settlement_receipt",
      status: "receipt_schema_defined_workflow_not_released",
      label: "Settlement receipt",
      proves:
        "only rail-authenticated finality evidence can prove the configured settlement condition",
      does_not_prove:
        "fulfillment, legitimacy, or that no refund, reversal, or dispute follows",
    },
    {
      id: "adjustment",
      status: "separate_policy_layer_not_released",
      label: "Adjustment",
      proves:
        "a refund, reversal, chargeback, or dispute outcome is a new event after payment",
      does_not_prove:
        "that the original request, submission, or settlement never occurred",
    },
  ],

  rails: [
    {
      id: "bitcoin_mainnet",
      local_send: "implemented",
      pay_links: "implemented",
      hosted_send: "impossible_by_design",
      settlement_receipt_workflow: "not_released",
    },
    {
      id: "base_eth_usdc",
      local_send: "implemented",
      pay_links: "not_released",
      hosted_send: "impossible_by_design",
      note:
        "the displayed EIP-1559 ceiling does not cap Base L1 data or operator components",
    },
    {
      id: "agent_wallet",
      read: "implemented",
      signed_authorization_evidence: "implemented",
      execution_binding: "not_released",
    },
    {
      id: "stripe_connect",
      sandbox_contract: "implemented_offline",
      live_transport: "not_released",
      hosted_checkout: "not_released",
    },
    {
      id: "gocardless",
      account_data_read: "implemented",
      payment_movement: "not_released",
    },
  ],

  market_boundary: {
    escrow: "not_provided_by_cashloom",
    disputes: "not_adjudicated_by_cashloom",
    refunds_and_chargebacks:
      "rail or provider actions belong as later adjustment evidence, never rewrites of earlier truth; that workflow is not released",
    provider_trust:
      "participants choose their own evidence and policy; CashLoom issues no universal legitimacy badge",
    third_party_escrow:
      "future adapters may name a shop or provider and its terms, but each participant decides whether to trust it",
  },

  recovery: {
    browser_redirect_is_payment_proof: false,
    ambiguous_submission_is_sticky: true,
    automatic_money_retry: false,
    exact_local_status_lookup: "implemented_for_bitcoin_pay_links",
    instruction:
      "When a send outcome is unknown, inspect the exact local payment and rail evidence before any replacement attempt.",
    known_debt:
      "signed Bitcoin bytes are not yet durably persisted before first egress, so same-byte crash recovery remains unreleased",
  },
} as const;

export type CashLoomCapabilities = typeof CASHLOOM_CAPABILITIES;

/**
 * A deterministic drift check for independently deployed human and machine
 * doors. This is not an authenticity proof; source signatures and release
 * checksums remain separate concerns.
 */
export function fingerprintCapabilities(
  document: unknown = CASHLOOM_CAPABILITIES,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export const CASHLOOM_CAPABILITY_FINGERPRINT = fingerprintCapabilities();
