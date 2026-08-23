import { divHalfEven } from "../../utils/minor-units.ts";
import { listBlockchainChains } from "./registry.ts";
import {
  bigIntToHexQuantity,
  type BlockchainRpcClient,
} from "./rpc.ts";
import type {
  ChainRegistryEntry,
  EvmReferenceBlock,
  JsonValue,
  ReferenceBlock,
} from "./types.ts";
import {
  exactValue,
  exactValueFromDecimal,
  referenceBlockIsStale,
  type ChainPulse,
  type MetricReceipt,
  type OnchainMetric,
} from "./model.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHex(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`malformed ${label}`);
  }
  return BigInt(value);
}

function sourceId(row: ChainRegistryEntry): string {
  return `chain-state-${row.key}`;
}

function receipt(
  id: string,
  reference: ReferenceBlock,
  now: string,
  limitations: string[],
  extra: Partial<MetricReceipt> = {},
): MetricReceipt {
  return {
    id,
    method: "observed_onchain",
    proof_state: reference.family === "solana"
      ? "finalized-slot"
      : reference.family === "bitcoin"
        ? "chain-tip"
        : "pinned-block",
    observed_at: reference.block_time?.iso ?? null,
    fetched_at: reference.fetched_at || now,
    reference_block: reference,
    source_ids: [sourceId(listBlockchainChains().find((row) => row.key === reference.chain_key)!)],
    limitations,
    ...extra,
  };
}

function rpcObservationReceipt(
  id: string,
  chainKey: string,
  fetchedAt: string,
  limitations: string[],
  extra: Partial<MetricReceipt> = {},
): MetricReceipt {
  return {
    id,
    method: "observed_onchain",
    proof_state: "rpc-observation",
    observed_at: null,
    fetched_at: fetchedAt,
    source_ids: [sourceId(listBlockchainChains().find((row) => row.key === chainKey)!)],
    limitations,
    ...extra,
  };
}

function blockAge(reference: ReferenceBlock, now: Date): bigint | null {
  if (!reference.block_time) return null;
  const observed = BigInt(reference.block_time.unix_seconds);
  const current = BigInt(Math.floor(now.getTime() / 1000));
  return current > observed ? current - observed : 0n;
}

function referenceMetrics(reference: ReferenceBlock, now: Date): OnchainMetric[] {
  const fetched = now.toISOString();
  const baseLimit = [
    "The reference describes the upstream node's selected block or slot; it is not a CashLoom finality guarantee.",
  ];
  const metrics: OnchainMetric[] = [{
    id: `${reference.chain_key}-reference-height`,
    label: reference.height_kind === "slot" ? "Finalized slot" : "Reference height",
    value: exactValue(reference.height, 0, reference.height_kind),
    status: "observed",
    receipt: receipt(`${reference.chain_key}-reference-height-receipt`, reference, fetched, baseLimit),
  }];
  const age = blockAge(reference, now);
  if (age !== null) {
    metrics.push({
      id: `${reference.chain_key}-reference-age`,
      label: "Reference block age",
      value: exactValue(age, 0, "seconds", "s"),
      status: "derived",
      receipt: receipt(`${reference.chain_key}-reference-age-receipt`, reference, fetched, baseLimit, {
        method: "derived_onchain",
        formula: "max(0, snapshot_unix_seconds - reference_block_unix_seconds)",
        inputs: [reference.block_time!.unix_seconds, Math.floor(now.getTime() / 1000).toString()],
      }),
    });
  }
  return metrics;
}

async function evmBlockMetrics(
  row: ChainRegistryEntry,
  reference: EvmReferenceBlock,
  client: BlockchainRpcClient,
  now: Date,
  signal?: AbortSignal,
): Promise<OnchainMetric[]> {
  const raw = await client.evmRead(
    row.key,
    "eth_getBlockByNumber",
    [reference.height_hex, false] as JsonValue[],
    { signal },
  );
  if (!isRecord(raw) || typeof raw.hash !== "string" || raw.hash.toLowerCase() !== reference.hash.toLowerCase()) {
    throw new Error("reference block changed or could not be reproduced");
  }
  const number = parseHex(raw.number, "block number");
  if (number !== BigInt(reference.height)) throw new Error("reference block height mismatch");

  const gasUsed = parseHex(raw.gasUsed, "gas used");
  const gasLimit = parseHex(raw.gasLimit, "gas limit");
  if (gasLimit <= 0n || gasUsed > gasLimit) throw new Error("invalid block gas fields");
  const utilization = divHalfEven(gasUsed * 100_000_000n, gasLimit);
  const limitations = [
    "Gas use is for one pinned reference block; it is not a rolling network-utilization average.",
    ...(row.key === "base" || row.key === "optimism" || row.key === "arbitrum"
      ? ["Execution-layer gas does not include every L1 data, settlement, or bridge cost paid by an L2 user."]
      : []),
  ];
  const metrics: OnchainMetric[] = [{
    id: `${row.key}-block-gas-used`,
    label: "Reference block gas used",
    value: exactValue(gasUsed, 0, "gas"),
    status: "observed",
    receipt: receipt(`${row.key}-block-gas-used-receipt`, reference, now.toISOString(), limitations, {
      method_or_event: "eth_getBlockByNumber.gasUsed",
    }),
  }, {
    id: `${row.key}-block-gas-use-percent`,
    label: "Reference block gas use",
    value: exactValue(utilization, 6, "percent", "%"),
    status: "derived",
    receipt: receipt(`${row.key}-block-gas-use-percent-receipt`, reference, now.toISOString(), limitations, {
      method: "derived_onchain",
      formula: "round_half_even(gasUsed / gasLimit × 100, 6 decimal places)",
      inputs: [gasUsed.toString(), gasLimit.toString()],
    }),
  }];

  if (raw.baseFeePerGas !== undefined && raw.baseFeePerGas !== null) {
    const baseFee = parseHex(raw.baseFeePerGas, "base fee");
    metrics.push({
      id: `${row.key}-block-base-fee`,
      label: "Reference block base fee",
      value: exactValue(baseFee, 9, "gwei"),
      status: "observed",
      receipt: receipt(`${row.key}-block-base-fee-receipt`, reference, now.toISOString(), limitations, {
        method_or_event: "eth_getBlockByNumber.baseFeePerGas",
      }),
    });
  }
  return metrics;
}

export async function readChainPulse(
  row: ChainRegistryEntry,
  client: BlockchainRpcClient,
  now = new Date(),
  signal?: AbortSignal,
): Promise<ChainPulse> {
  const reference = await client.getReferenceBlock(row.key, { signal });
  const metrics = referenceMetrics(reference, now);
  let supplementaryPartial = false;
  if (reference.family === "evm") {
    try {
      metrics.push(...await evmBlockMetrics(row, reference, client, now, signal));
    } catch {
      supplementaryPartial = true;
    }
  } else if (reference.family === "bitcoin") {
    const [mempoolResult, feeResult] = await Promise.allSettled([
      client.bitcoinMempool("bitcoin", { signal }),
      client.bitcoinFeeEstimate("bitcoin", { signal }),
    ]);
    const limitations = [
      "Mempool contents are one upstream node's current view and can differ across peers.",
      "The three-block fee is an estimate, not a guaranteed inclusion price.",
      "Mempool and fee reads are live RPC observations fetched independently of the displayed Bitcoin tip; they are not pinned to that tip.",
    ];
    if (mempoolResult.status === "fulfilled") {
      const mempool = mempoolResult.value;
      metrics.push({
        id: "bitcoin-mempool-transactions",
        label: "Mempool transactions",
        value: exactValue(mempool.transaction_count, 0, "transactions"),
        status: "observed",
        receipt: rpcObservationReceipt("bitcoin-mempool-transactions-receipt", row.key, mempool.fetched_at, limitations, {
          method_or_event: "Esplora GET /mempool.count",
        }),
      }, {
        id: "bitcoin-mempool-virtual-size",
        label: "Mempool virtual size",
        value: exactValue(mempool.virtual_size_bytes, 0, "vbytes", "vB"),
        status: "observed",
        receipt: rpcObservationReceipt("bitcoin-mempool-virtual-size-receipt", row.key, mempool.fetched_at, limitations, {
          method_or_event: "Esplora GET /mempool.vsize",
        }),
      });
    } else supplementaryPartial = true;
    if (feeResult.status === "fulfilled") {
      const fee = feeResult.value;
      metrics.push({
        id: "bitcoin-three-block-fee",
        label: "Three-block fee estimate",
        value: exactValueFromDecimal(fee.sat_per_vbyte, "satoshis_per_vbyte", "sat/vB"),
        status: "reference",
        receipt: rpcObservationReceipt("bitcoin-three-block-fee-receipt", row.key, fee.fetched_at, limitations, {
          method_or_event: "Esplora GET /fee-estimates[3]",
        }),
      });
    } else supplementaryPartial = true;
  } else {
    const [performanceResult, priorityResult] = await Promise.allSettled([
      client.solanaPerformanceSamples("solana", 12, { signal }),
      client.solanaPrioritizationFees("solana", [], { signal }),
    ]);
    const limitations = [
      "Performance samples are recent validator RPC windows, not a cross-chain TPS ranking.",
      "Prioritization fees are recent observations for an empty writable-account set; a particular transaction can require a different fee.",
      "Performance and prioritization-fee reads are live RPC observations fetched independently of the displayed finalized slot; they are not pinned to that slot.",
    ];
    if (performanceResult.status === "fulfilled") {
      const performance = performanceResult.value;
      const totals = performance.samples.reduce((acc, sample) => ({
        transactions: acc.transactions + BigInt(sample.transactions),
        seconds: acc.seconds + BigInt(sample.sample_period_seconds),
      }), { transactions: 0n, seconds: 0n });
      if (totals.seconds > 0n) {
        const tpsScaled = divHalfEven(totals.transactions * 1_000_000n, totals.seconds);
        metrics.push({
          id: "solana-recent-rpc-tps",
          label: "Recent RPC transactions / second",
          value: exactValue(tpsScaled, 6, "transactions_per_second", "tx/s"),
          status: "derived",
          receipt: rpcObservationReceipt("solana-recent-rpc-tps-receipt", row.key, performance.fetched_at, limitations, {
            method: "derived_onchain",
            method_or_event: "getRecentPerformanceSamples(12)",
            formula: "sum(numTransactions) / sum(samplePeriodSecs), rounded half-even to 6dp",
            inputs: performance.samples.flatMap((sample) => [sample.transactions, sample.sample_period_seconds]),
          }),
        });
      } else supplementaryPartial = true;
    } else supplementaryPartial = true;
    if (priorityResult.status === "fulfilled" && priorityResult.value.fees.length > 0) {
      const priority = priorityResult.value;
      const sorted = priority.fees.map((entry) => BigInt(entry.micro_lamports_per_compute_unit))
        .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const middle = sorted.length >> 1;
      const median = sorted.length % 2 === 1
        ? sorted[middle]
        : divHalfEven(sorted[middle - 1] + sorted[middle], 2n);
      metrics.push({
        id: "solana-recent-median-priority-fee",
        label: "Recent median prioritization fee",
        value: exactValue(median, 0, "micro_lamports_per_compute_unit", "µ-lamports/CU"),
        status: "derived",
        receipt: rpcObservationReceipt("solana-recent-median-priority-fee-receipt", row.key, priority.fetched_at, limitations, {
          method: "derived_onchain",
          method_or_event: "getRecentPrioritizationFees([])",
          formula: "median(recent prioritizationFee observations), half-even midpoint for an even sample",
          inputs: priority.fees.map((entry) => `${entry.slot}:${entry.micro_lamports_per_compute_unit}`),
        }),
      });
    } else supplementaryPartial = true;
  }
  const stale = referenceBlockIsStale(reference, now);
  return {
    id: `network-${row.key}`,
    chain: row.caip2,
    name: row.label,
    family: row.family,
    native_symbol: row.native_asset.symbol,
    status: stale || supplementaryPartial ? "partial" : "observed",
    stale,
    reference_block: reference,
    metrics,
    source_id: sourceId(row),
    note: `${reference.family === "evm"
      ? "One chain-verified block is used for the network observations. The finality label reports the upstream block tag actually resolved."
      : reference.family === "bitcoin"
        ? "Bitcoin proof-of-work has probabilistic confirmation, so the chain tip is observed—not described as final. Mempool and fee context is fetched independently and is not pinned to that tip."
        : "The slot is read with Solana's finalized commitment; that remains an upstream commitment claim, not an independent guarantee. Performance and priority-fee context is fetched independently and is not pinned to that slot."}${supplementaryPartial ? " One or more supplementary activity or fee reads were unavailable, so this network record is partial." : ""}`,
  };
}

export async function readAllChainPulses(
  client: BlockchainRpcClient,
  now = new Date(),
): Promise<Array<PromiseSettledResult<ChainPulse>>> {
  return Promise.allSettled(listBlockchainChains().map((row) => readChainPulse(row, client, now)));
}

export function chainSourceId(chainKey: string): string {
  return `chain-state-${chainKey}`;
}
