/**
 * Networkless capability projection for owner-facing wallet connections.
 *
 * This is deliberately a readiness catalogue, not a claim that an external
 * signer or regulated provider is live. Configuration is reported only as a
 * boolean; credential names, values, provider URLs, pairing material and
 * device identifiers never cross this boundary.
 */

export const WALLET_INTEGRATION_IDS = [
  "webauthn-passkey",
  "ledger-base-evm",
  "trezor-base-evm",
  "walletconnect-v2",
  "erc4337-base-v07",
  "gocardless-bank-data",
  "yapily-pay-by-bank",
] as const;

export type WalletIntegrationId = typeof WALLET_INTEGRATION_IDS[number];
export type WalletIntegrationFamily =
  | "passkey"
  | "hardware"
  | "walletconnect"
  | "smart-account"
  | "bank-data"
  | "pay-by-bank";

export interface WalletIntegrationCatalogItem {
  readonly id: WalletIntegrationId;
  readonly family: WalletIntegrationFamily;
  readonly label: string;
  readonly adapter_status: "verified_foundation";
  readonly configuration_state: "ready" | "credentials_required" | "policy_blocked";
  readonly configured: boolean;
  readonly execution_enabled: boolean;
  readonly interaction: "owner_browser" | "owner_device" | "owner_redirect";
  readonly persisted_connections: string;
  readonly capabilities: readonly string[];
  readonly limitations: readonly string[];
}

export interface WalletIntegrationCatalog {
  readonly schema_version: "cashloom.wallet-integrations/1";
  readonly generated_at: string;
  readonly runtime: "local_loopback_custody";
  readonly network_on_get: false;
  readonly integrations: readonly WalletIntegrationCatalogItem[];
  readonly safety: Readonly<{
    owner_interaction_required: true;
    agent_interactive_completion_allowed: false;
    verification_adapters_available: true;
    atomic_verified_persistence_enabled: false;
    pairing_and_oauth_secrets_excluded: true;
    hosted_info_runtime_excluded: true;
  }>;
}

type IntegrationCount = Readonly<{
  kind: "WEBAUTHN" | "HARDWARE" | "WALLETCONNECT" | "ERC4337" | "FIAT";
  count: bigint | number | string;
}>;

const present = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

const canonicalCount = (value: bigint | number | string | undefined): string => {
  if (value === undefined) return "0";
  const parsed = BigInt(value);
  if (parsed < 0n) throw new TypeError("Integration count must be non-negative.");
  return parsed.toString();
};

const freezeItem = (item: WalletIntegrationCatalogItem): WalletIntegrationCatalogItem =>
  Object.freeze({
    ...item,
    capabilities: Object.freeze([...item.capabilities]),
    limitations: Object.freeze([...item.limitations]),
  });

export const buildWalletIntegrationCatalog = (input: {
  readonly now?: Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connection_counts?: readonly IntegrationCount[];
} = {}): WalletIntegrationCatalog => {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Integration catalogue clock is invalid.");
  const env = input.env ?? process.env;
  const counts = new Map(input.connection_counts?.map((entry) => [entry.kind, canonicalCount(entry.count)]));
  const count = (kind: IntegrationCount["kind"]): string => counts.get(kind) ?? "0";
  const gocardlessConfigured = present(env.GOCARDLESS_SECRET_ID) && present(env.GOCARDLESS_SECRET_KEY);
  const yapilyConfigured = present(env.YAPILY_APPLICATION_ID) && present(env.YAPILY_APPLICATION_SECRET);

  const integrations: WalletIntegrationCatalogItem[] = [
    freezeItem({
      id: "webauthn-passkey",
      family: "passkey",
      label: "Passkey approval and smart-account evidence",
      adapter_status: "verified_foundation",
      configuration_state: "policy_blocked",
      configured: false,
      execution_enabled: false,
      interaction: "owner_browser",
      persisted_connections: count("WEBAUTHN"),
      capabilities: ["ES256 registration verification", "UV assertion verification", "single-use durable ceremonies"],
      limitations: ["No smart-account factory is pinned", "Attestation none makes no hardware assurance claim", "Loopback WebAuthn uses http://localhost only"],
    }),
    freezeItem({
      id: "ledger-base-evm",
      family: "hardware",
      label: "Ledger · Base EVM",
      adapter_status: "verified_foundation",
      configuration_state: "policy_blocked",
      configured: false,
      execution_enabled: false,
      interaction: "owner_device",
      persisted_connections: count("HARDWARE"),
      capabilities: ["Exact EIP-1559 signed-envelope verification", "Recovered-address and request binding"],
      limitations: ["Browser Device Management Kit not enabled", "USDC requires clear signing", "No blind signing"],
    }),
    freezeItem({
      id: "trezor-base-evm",
      family: "hardware",
      label: "Trezor · Base EVM",
      adapter_status: "verified_foundation",
      configuration_state: "policy_blocked",
      configured: false,
      execution_enabled: false,
      interaction: "owner_device",
      persisted_connections: count("HARDWARE"),
      capabilities: ["Exact EIP-1559 signed-envelope verification", "Recovered-address and request binding"],
      limitations: ["Browser Connect transport not enabled", "No opaque byte signing", "Bitcoin hardware PSBT metadata is not yet sufficient"],
    }),
    freezeItem({
      id: "walletconnect-v2",
      family: "walletconnect",
      label: "WalletConnect v2 · Base raw signing",
      adapter_status: "verified_foundation",
      configuration_state: "policy_blocked",
      configured: false,
      execution_enabled: false,
      interaction: "owner_browser",
      persisted_connections: count("WALLETCONNECT"),
      capabilities: ["Exact CAIP namespace binding", "eth_signTransaction verification", "hashed session projection"],
      limitations: ["Pairing keys remain browser-only", "No silent eth_sendTransaction fallback", "Session changes require owner reapproval"],
    }),
    freezeItem({
      id: "erc4337-base-v07",
      family: "smart-account",
      label: "ERC-4337 v0.7 · Base",
      adapter_status: "verified_foundation",
      configuration_state: "policy_blocked",
      configured: false,
      execution_enabled: false,
      interaction: "owner_browser",
      persisted_connections: count("ERC4337"),
      capabilities: ["Semantic PackedUserOperation binding", "Permanent 192/64 nonce claims", "Bundler transport evidence"],
      limitations: ["EntryPoint/account factory/code hashes are not deployment-pinned", "Bundler response is never inclusion proof", "Passkey recovery policy is not selected"],
    }),
    freezeItem({
      id: "gocardless-bank-data",
      family: "bank-data",
      label: "GoCardless Bank Account Data",
      adapter_status: "verified_foundation",
      configuration_state: gocardlessConfigured ? "ready" : "credentials_required",
      configured: gocardlessConfigured,
      execution_enabled: false,
      interaction: "owner_redirect",
      persisted_connections: count("FIAT"),
      capabilities: ["GBP/EUR account linking", "Balance and transaction consent", "Bounded requisition status"],
      limitations: ["Read-only AIS", "No payment initiation", "Provider credentials stay in the local credential resolver"],
    }),
    freezeItem({
      id: "yapily-pay-by-bank",
      family: "pay-by-bank",
      label: "Yapily Connect · UK Pay by Bank",
      adapter_status: "verified_foundation",
      configuration_state: yapilyConfigured ? "policy_blocked" : "credentials_required",
      configured: yapilyConfigured,
      execution_enabled: false,
      interaction: "owner_redirect",
      persisted_connections: count("FIAT"),
      capabilities: ["One-off immediate domestic GBP preparation", "Provider idempotency", "Authoritative status polling"],
      limitations: ["Live execution requires an explicit provider/legal enablement", "Consent token/account coordinator is not enabled", "No agents, VRP, scheduled or international payments", "Redirect or POST return never means settlement"],
    }),
  ];

  return Object.freeze({
    schema_version: "cashloom.wallet-integrations/1",
    generated_at: now.toISOString(),
    runtime: "local_loopback_custody",
    network_on_get: false,
    integrations: Object.freeze(integrations),
    safety: Object.freeze({
      owner_interaction_required: true,
      agent_interactive_completion_allowed: false,
      verification_adapters_available: true,
      // The current additive store is a durable contract ledger. Live
      // completion routes stay disabled until verification and core artifact
      // consumption share one atomic coordinator transaction.
      atomic_verified_persistence_enabled: false,
      pairing_and_oauth_secrets_excluded: true,
      hosted_info_runtime_excluded: true,
    }),
  });
};
