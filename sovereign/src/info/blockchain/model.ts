import type { ReferenceBlock } from "./types.ts";

export const ONCHAIN_MEDIA_TYPE = "application/vnd.cashloom.onchain.v1+json";
export const ONCHAIN_SECTION_MEDIA_TYPE = "application/vnd.cashloom.onchain-section.v1+json";

export type OnchainSection =
  | "chains"
  | "stablecoins"
  | "lending_markets"
  | "pools"
  | "bridge_routes";

export type ObservationStatus = "observed" | "derived" | "reference" | "unavailable";

export interface ExactValue {
  /** Exact publisher/chain integer. Never an IEEE-754 number. */
  raw: string;
  /** Exact base-ten rendering at `decimals`; trailing zeroes may be trimmed. */
  decimal: string;
  decimals: number;
  unit: string;
  display: string;
}

export interface OnchainSource {
  id: string;
  name: string;
  title: string;
  url: string;
  methodology_url?: string;
  terms_url?: string;
  status: "ok" | "partial" | "unavailable";
  cadence: string;
  license: "public-onchain-derived" | "attribution-required" | "contract-required";
  fetched_at?: string;
  retrieval?: "live_fetch" | "verified_transcription";
  verified_at?: string;
  note: string;
}

export interface MetricReceipt {
  id: string;
  method: "observed_onchain" | "derived_onchain" | "official_reference";
  proof_state: "pinned-block" | "finalized-slot" | "chain-tip" | "rpc-observation" | "external-reference";
  pinning?: "block-hash-canonical" | "height-with-canonical-pre-postcheck";
  observed_at: string | null;
  fetched_at: string;
  reference_block?: ReferenceBlock;
  source_ids: string[];
  contract_address?: string;
  method_or_event?: string;
  formula?: string;
  inputs?: string[];
  limitations: string[];
}

export interface OnchainMetric {
  id: string;
  label: string;
  value: ExactValue;
  status: ObservationStatus;
  receipt: MetricReceipt;
}

export interface ChainPulse {
  id: string;
  chain: string;
  name: string;
  family: "bitcoin" | "evm" | "solana";
  native_symbol: string;
  status: "observed" | "partial" | "unavailable";
  stale: boolean;
  reference_block: ReferenceBlock;
  metrics: OnchainMetric[];
  source_id: string;
  note: string;
}

export interface StablecoinObservation {
  id: string;
  name: string;
  symbol: "USDC";
  chain: string;
  chain_name: string;
  token_address: string;
  representation: "native_issued";
  status: "observed" | "partial" | "unavailable";
  stale: boolean;
  supply: ExactValue;
  receipt: MetricReceipt;
  source_id: string;
  note: string;
}

const EVM_REFERENCE_STALE_AFTER_SECONDS = 7_200n;
const BITCOIN_REFERENCE_STALE_AFTER_SECONDS = 14_400n;
const SOLANA_REFERENCE_STALE_AFTER_SECONDS = 900n;

/**
 * Apply the same source-aware age allowance to every fact derived from a
 * supplied chain reference. A missing block time remains unknown rather than
 * being silently classified as stale.
 */
export function referenceBlockIsStale(reference: ReferenceBlock, now = new Date()): boolean {
  if (!reference.block_time) return false;
  const observed = BigInt(reference.block_time.unix_seconds);
  const current = BigInt(Math.floor(now.getTime() / 1_000));
  const age = current > observed ? current - observed : 0n;
  const allowance = reference.family === "bitcoin"
    ? BITCOIN_REFERENCE_STALE_AFTER_SECONDS
    : reference.family === "solana"
      ? SOLANA_REFERENCE_STALE_AFTER_SECONDS
      : EVM_REFERENCE_STALE_AFTER_SECONDS;
  return age > allowance;
}

export interface LendingMarket {
  id: string;
  protocol: "Aave V3";
  name: string;
  chain: string;
  chain_name: string;
  asset: "USDC";
  asset_address: string;
  data_provider_address: string;
  status: "observed" | "partial" | "unavailable";
  stale: boolean;
  total_supplied: ExactValue;
  stable_debt: ExactValue;
  variable_debt: ExactValue;
  utilization: ExactValue;
  current_supply_rate: ExactValue;
  current_variable_borrow_rate: ExactValue;
  receipt: MetricReceipt;
  source_id: string;
  note: string;
}

export interface PoolToken {
  symbol: "USDC" | "WETH";
  address: string;
  decimals: number;
  contract_balance: ExactValue;
}

export interface LiquidityPool {
  id: string;
  protocol: "Uniswap V3";
  name: string;
  chain: string;
  chain_name: string;
  pool_address: string;
  fee_tier_bps: ExactValue;
  tokens: [PoolToken, PoolToken];
  active_liquidity: ExactValue;
  sqrt_price_x96: ExactValue;
  current_tick: ExactValue;
  status: "observed" | "partial" | "unavailable";
  stale: boolean;
  receipt: MetricReceipt;
  source_id: string;
  note: string;
}

export interface BridgeFeeMode {
  mode: "fast" | "standard";
  fee_bps: ExactValue;
  finality_threshold: string;
  status: "available" | "unavailable";
}

export interface BridgeRoute {
  id: string;
  protocol: "Circle CCTP V2";
  name: string;
  source_chain: string;
  source_chain_name: string;
  destination_chain: string;
  destination_chain_name: string;
  asset: "USDC";
  mechanism: "burn-and-mint";
  status: "reference" | "partial" | "unavailable";
  fees: BridgeFeeMode[];
  fast_burn_allowance?: ExactValue;
  fast_burn_allowance_observed_at?: string;
  observed_at: string | null;
  fetched_at: string;
  source_id: string;
  receipt: MetricReceipt;
  note: string;
}

export interface OnchainBriefing {
  id: string;
  title: string;
  summary: string;
  category: "network" | "stable-money" | "credit" | "pool" | "bridge";
  status: ObservationStatus;
  observed_at: string | null;
  source_ids: string[];
}

export interface OnchainThread {
  id: string;
  title: string;
  observed: string[];
  possible_channels: string[];
  limits: string[];
  source_ids: string[];
}

export interface OnchainUnavailable {
  id: string;
  section: OnchainSection;
  title: string;
  detail: string;
  retryable: boolean;
}

export interface SectionStatus {
  state: "ready" | "partial" | "unavailable";
  available: number;
  expected: number;
}

export interface OnchainSnapshot {
  "@type": "OnchainSnapshot";
  schema: "cashloom.onchain/1";
  generated_at: string;
  scope: "latest_state";
  status: {
    state: "ready" | "partial" | "unavailable";
    complete: boolean;
    available_sources: number;
    total_sources: number;
    stale_count: number;
    sections: Record<OnchainSection, SectionStatus>;
    unavailable: OnchainUnavailable[];
  };
  briefing: OnchainBriefing[];
  chains: ChainPulse[];
  stablecoins: StablecoinObservation[];
  lending_markets: LendingMarket[];
  pools: LiquidityPool[];
  bridge_routes: BridgeRoute[];
  threads: OnchainThread[];
  sources: OnchainSource[];
}

/** Exact decimal rendering for an integer quantity and fixed scale. */
export function decimalFromRaw(raw: bigint | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("invalid decimal scale");
  }
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function exactValue(
  raw: bigint | string,
  decimals: number,
  unit: string,
  displayUnit = unit,
): ExactValue {
  const rawString = typeof raw === "bigint" ? raw.toString() : BigInt(raw).toString();
  const decimal = decimalFromRaw(rawString, decimals);
  return { raw: rawString, decimal, decimals, unit, display: `${decimal} ${displayUnit}` };
}

/** Convert a non-exponent decimal lexeme to the exact integer/scale pair. */
export function exactValueFromDecimal(
  lexeme: string,
  unit: string,
  displayUnit = unit,
): ExactValue {
  if (!/^-?\d+(?:\.\d+)?$/.test(lexeme)) throw new Error("invalid decimal lexeme");
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  const rawUnsigned = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const raw = `${negative && rawUnsigned !== "0" ? "-" : ""}${rawUnsigned}`;
  return exactValue(raw, fraction.length, unit, displayUnit);
}
