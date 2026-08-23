import { resolveBlockchainChain } from "./registry.ts";
import {
  exactValue,
  type BridgeFeeMode,
  type BridgeRoute,
  type ExactValue,
} from "./model.ts";

export const CCTP_SOURCE_ID = "circle-cctp-v2-fees";
export const CCTP_FEES_BASE_URL = "https://iris-api.circle.com";
export const CCTP_FEES_DOCS_URL = "https://developers.circle.com/cctp/concepts/fees";
export const CCTP_DOMAINS_URL = "https://developers.circle.com/cctp/concepts/supported-chains-and-domains";
export const CIRCLE_DEVELOPER_TERMS_URL = "https://console.circle.com/legal/developer-terms";

export interface CctpRouteDefinition {
  source: "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "solana";
  destination: "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "solana";
  source_domain: 0 | 2 | 3 | 5 | 6 | 7;
  destination_domain: 0 | 2 | 3 | 5 | 6 | 7;
}

const DOMAINS = {
  ethereum: 0,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
} as const;

const SPOKES = ["base", "arbitrum", "optimism", "polygon", "solana"] as const;
export const CCTP_ROUTES: readonly CctpRouteDefinition[] = SPOKES.flatMap((spoke) => [
  { source: "ethereum" as const, destination: spoke, source_domain: 0 as const, destination_domain: DOMAINS[spoke] },
  { source: spoke, destination: "ethereum" as const, source_domain: DOMAINS[spoke], destination_domain: 0 as const },
]);

export interface CctpFailure {
  id: string;
  detail: string;
  retryable: boolean;
}

export interface CctpBatch {
  routes: BridgeRoute[];
  failures: CctpFailure[];
  fetched_at: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CctpRuntime {
  fetch?: FetchLike;
  clock?: () => number;
  timeout_ms?: number;
  max_response_bytes?: number;
}

interface DecimalToken {
  raw: string;
  decimals: number;
}

function decimalToken(lexeme: string): DecimalToken {
  if (!/^-?\d+(?:\.\d+)?$/.test(lexeme)) throw new Error("invalid decimal token");
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  const rawUnsigned = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return { raw: `${negative && rawUnsigned !== "0" ? "-" : ""}${rawUnsigned}`, decimals: fraction.length };
}

function exactFromLexeme(lexeme: string, unit: string, displayUnit = unit): ExactValue {
  const token = decimalToken(lexeme);
  return exactValue(token.raw, token.decimals, unit, displayUnit);
}

function objectSlices(text: string): string[] {
  const slices: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("malformed JSON object boundary");
      if (depth === 0 && start >= 0) slices.push(text.slice(start, i + 1));
    }
  }
  if (depth !== 0 || quoted) throw new Error("malformed JSON object boundary");
  return slices;
}

export function parseCctpFeeResponse(text: string): BridgeFeeMode[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error("CCTP fee response was not JSON"); }
  if (!Array.isArray(parsed)) throw new Error("CCTP fee response was not an array");
  const slices = objectSlices(text);
  if (slices.length !== parsed.length || slices.length > 8) throw new Error("CCTP fee response shape mismatch");
  const modes: BridgeFeeMode[] = [];
  for (const slice of slices) {
    const thresholds = Array.from(slice.matchAll(/"finalityThreshold"\s*:\s*(\d+)/g));
    const fees = Array.from(slice.matchAll(/"minimumFee"\s*:\s*(-?\d+(?:\.\d+)?)/g));
    const threshold = thresholds.length === 1 ? thresholds[0][1] : undefined;
    const fee = fees.length === 1 ? fees[0][1] : undefined;
    if (!threshold || !fee || (threshold !== "1000" && threshold !== "2000")) {
      throw new Error("CCTP fee response fields were malformed");
    }
    const value = exactFromLexeme(fee, "basis_points", "bps");
    if (BigInt(value.raw) < 0n) throw new Error("CCTP fee cannot be negative");
    modes.push({
      mode: threshold === "1000" ? "fast" : "standard",
      fee_bps: value,
      finality_threshold: threshold,
      status: "available",
    });
  }
  if (!modes.some((entry) => entry.mode === "standard")) throw new Error("CCTP standard fee mode missing");
  return modes.sort((a, b) => a.mode === "fast" && b.mode !== "fast" ? -1 : 1);
}

export function parseCctpAllowanceResponse(text: string): { allowance: ExactValue; last_updated: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error("CCTP allowance response was not JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CCTP allowance response was not an object");
  }
  const allowances = Array.from(text.matchAll(/"allowance"\s*:\s*(-?\d+(?:\.\d+)?)/g));
  const updates = Array.from(text.matchAll(/"lastUpdated"\s*:\s*"([^"]+)"/g));
  const allowance = allowances.length === 1 ? allowances[0][1] : undefined;
  const lastUpdated = updates.length === 0 ? null : updates.length === 1 ? updates[0][1] : undefined;
  if (!allowance) throw new Error("CCTP allowance field missing");
  if (lastUpdated === undefined) throw new Error("CCTP allowance timestamp duplicated");
  const value = exactFromLexeme(allowance, "USDC");
  if (BigInt(value.raw) < 0n) throw new Error("CCTP allowance cannot be negative");
  if (lastUpdated !== null && Number.isNaN(Date.parse(lastUpdated))) {
    throw new Error("CCTP allowance timestamp malformed");
  }
  return { allowance: value, last_updated: lastUpdated ? new Date(lastUpdated).toISOString() : null };
}

async function boundedText(
  runtime: Required<CctpRuntime>,
  path: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeout_ms);
  try {
    const response = await runtime.fetch(`${CCTP_FEES_BASE_URL}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new Error(`official endpoint answered ${response.status}`);
    }
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(runtime.max_response_bytes)) {
      throw new Error("official response exceeded size limit");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > runtime.max_response_bytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error("official response exceeded size limit");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("official endpoint timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readRoute(
  definition: CctpRouteDefinition,
  runtime: Required<CctpRuntime>,
  allowance: { allowance: ExactValue; last_updated: string | null } | null,
): Promise<BridgeRoute> {
  const text = await boundedText(
    runtime,
    `/v2/burn/USDC/fees/${definition.source_domain}/${definition.destination_domain}`,
  );
  const fees = parseCctpFeeResponse(text);
  const source = resolveBlockchainChain(definition.source)!;
  const destination = resolveBlockchainChain(definition.destination)!;
  const fetchedAt = new Date(runtime.clock()).toISOString();
  const limitations = [
    "This is Circle's current protocol fee reference—not an executed quote, observed transfer, delivery-time promise, or completed bridge flow.",
    "Source-chain gas, destination execution, relayer behavior, route capacity, and token market price are excluded.",
    "CCTP initiation, attestation eligibility, destination receipt, and mint are distinct states; a source burn alone is not completion.",
  ];
  return {
    id: `cctp-v2-${definition.source}-${definition.destination}`,
    protocol: "Circle CCTP V2",
    name: `${source.label} → ${destination.label}`,
    source_chain: source.caip2,
    source_chain_name: source.label,
    destination_chain: destination.caip2,
    destination_chain_name: destination.label,
    asset: "USDC",
    mechanism: "burn-and-mint",
    status: "reference",
    fees,
    ...(allowance ? { fast_burn_allowance: allowance.allowance } : {}),
    ...(allowance?.last_updated ? { fast_burn_allowance_observed_at: allowance.last_updated } : {}),
    observed_at: null,
    fetched_at: fetchedAt,
    source_id: CCTP_SOURCE_ID,
    receipt: {
      id: `cctp-v2-${definition.source}-${definition.destination}-receipt`,
      method: "official_reference",
      proof_state: "external-reference",
      observed_at: null,
      fetched_at: fetchedAt,
      source_ids: [CCTP_SOURCE_ID],
      method_or_event: `GET /v2/burn/USDC/fees/${definition.source_domain}/${definition.destination_domain}`,
      inputs: [definition.source_domain.toString(), definition.destination_domain.toString(), "USDC"],
      limitations: [
        ...limitations,
        ...(allowance ? ["The Fast Burn allowance is a global Circle allowance snapshot repeated as route context; it is not dedicated capacity for this route."] : []),
      ],
    },
    note: "Current CCTP V2 standard/fast protocol fee reference for a burn-and-mint route. It is not a transfer quote or completion record; any Fast Burn allowance shown is global context.",
  };
}

let successCache: { expires_at: number; batch: CctpBatch } | null = null;
let inflight: Promise<CctpBatch> | null = null;

async function loadCctpRoutes(runtime: Required<CctpRuntime>): Promise<CctpBatch> {
  const fetchedAt = new Date(runtime.clock()).toISOString();
  let allowance: { allowance: ExactValue; last_updated: string | null } | null = null;
  try {
    allowance = parseCctpAllowanceResponse(await boundedText(runtime, "/v2/fastBurn/USDC/allowance"));
  } catch {
    // Route fees remain useful without a global Fast Burn allowance.
  }
  const settled = await Promise.allSettled(CCTP_ROUTES.map((route) => readRoute(route, runtime, allowance)));
  const routes: BridgeRoute[] = [];
  const failures: CctpFailure[] = [];
  settled.forEach((result, index) => {
    const definition = CCTP_ROUTES[index];
    if (result.status === "fulfilled") routes.push(result.value);
    else failures.push({
      id: `cctp-v2-${definition.source}-${definition.destination}`,
      detail: "Circle's official CCTP fee reference did not answer with a usable route observation.",
      retryable: true,
    });
  });
  return { routes, failures, fetched_at: fetchedAt };
}

export async function readCctpRoutes(config: CctpRuntime = {}): Promise<CctpBatch> {
  const runtime: Required<CctpRuntime> = {
    fetch: config.fetch ?? fetch,
    clock: config.clock ?? Date.now,
    timeout_ms: config.timeout_ms ?? 8_000,
    max_response_bytes: config.max_response_bytes ?? 128 * 1024,
  };
  if (!Number.isSafeInteger(runtime.timeout_ms) || runtime.timeout_ms < 1 || runtime.timeout_ms > 30_000 ||
      !Number.isSafeInteger(runtime.max_response_bytes) || runtime.max_response_bytes < 1 || runtime.max_response_bytes > 1024 * 1024) {
    throw new Error("invalid CCTP runtime bounds");
  }
  const injected = config.fetch !== undefined || config.clock !== undefined;
  const now = runtime.clock();
  if (!injected && successCache && now < successCache.expires_at) return successCache.batch;
  if (!injected && inflight) return inflight;
  const load = loadCctpRoutes(runtime).then((batch) => {
    if (!injected && batch.routes.length > 0) successCache = { expires_at: Date.now() + 300_000, batch };
    return batch;
  });
  if (injected) return load;
  inflight = load.finally(() => { inflight = null; });
  return inflight;
}
