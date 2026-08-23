import { describe, expect, it } from "vitest";
import { readChainPulse } from "./chains.ts";
import { resolveBlockchainChain } from "./registry.ts";
import type { BlockchainRpcClient } from "./rpc.ts";
import type { BitcoinReferenceBlock, EvmReferenceBlock, RpcSourceReceipt, SolanaReferenceBlock } from "./types.ts";

const NOW = new Date("2026-08-20T18:00:00.000Z");

function source(chain: RpcSourceReceipt["chain"], transport: "json-rpc" | "esplora-http" = "json-rpc") {
  return {
    chain,
    provider: "Fixture",
    transport,
    configuration: "public-default" as const,
    rpc_documentation_url: "https://example.test/docs",
    explorer_url: "https://example.test/explorer",
    endpoint_disclosed: false as const,
  };
}

function bitcoinReference(): BitcoinReferenceBlock {
  return {
    chain_key: "bitcoin",
    chain: "bip122:000000000019d6689c085ae165831e93",
    family: "bitcoin",
    height: "123",
    height_kind: "block-height",
    hash: "00".repeat(32),
    block_time: { unix_seconds: "1787248790", iso: "2026-08-20T17:59:50.000Z" },
    fetched_at: NOW.toISOString(),
    finality: {
      claim: "bitcoin-proof-of-work-tip",
      basis: "esplora-chain-tip",
      fallback_used: false,
      attempts: [],
    },
    source: source("bip122:000000000019d6689c085ae165831e93", "esplora-http"),
  };
}

function solanaReference(): SolanaReferenceBlock {
  return {
    chain_key: "solana",
    chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvd",
    family: "solana",
    height: "123",
    height_kind: "slot",
    hash: "5HueCGU8rMjxEXxiPuD5BDuRa1LqVYw9K7R1mJ4hYQx",
    block_time: { unix_seconds: "1787248790", iso: "2026-08-20T17:59:50.000Z" },
    fetched_at: NOW.toISOString(),
    finality: {
      claim: "solana-finalized-commitment",
      basis: "solana-rpc-commitment",
      fallback_used: false,
      attempts: [],
    },
    source: source("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvd"),
  };
}

function evmReference(): EvmReferenceBlock {
  return {
    chain_key: "ethereum",
    chain: "eip155:1",
    family: "evm",
    height: "123",
    height_hex: "0x7b",
    height_kind: "block-number",
    hash: `0x${"11".repeat(32)}`,
    block_time: { unix_seconds: "1787248790", iso: "2026-08-20T17:59:50.000Z" },
    fetched_at: NOW.toISOString(),
    finality: {
      claim: "upstream-finalized",
      basis: "json-rpc-block-tag",
      requested_tag: "finalized",
      resolved_tag: "finalized",
      fallback_used: false,
      attempts: [{ tag: "finalized", outcome: "selected" }],
    },
    source: source("eip155:1"),
  };
}

describe("network metric proof states", () => {
  it("does not pin independent Bitcoin mempool and fee reads to the displayed tip", async () => {
    const reference = bitcoinReference();
    const client = {
      getReferenceBlock: async () => reference,
      bitcoinMempool: async () => ({
        chain: reference.chain,
        transaction_count: "10",
        virtual_size_bytes: "2000",
        total_fee_sats: "300",
        fetched_at: NOW.toISOString(),
        source: reference.source,
      }),
      bitcoinFeeEstimate: async () => ({
        chain: reference.chain,
        target_blocks: "3",
        sat_per_vbyte: "2.5",
        fetched_at: NOW.toISOString(),
        source: reference.source,
      }),
    } as unknown as BlockchainRpcClient;
    const pulse = await readChainPulse(resolveBlockchainChain("bitcoin")!, client, NOW);
    const independent = pulse.metrics.filter((metric) =>
      metric.id.startsWith("bitcoin-mempool") || metric.id === "bitcoin-three-block-fee"
    );
    expect(independent).toHaveLength(3);
    independent.forEach((metric) => {
      expect(metric.receipt.proof_state).toBe("rpc-observation");
      expect(metric.receipt.observed_at).toBeNull();
      expect(metric.receipt).not.toHaveProperty("reference_block");
      expect(metric.receipt).not.toHaveProperty("pinning");
    });
    expect(pulse.metrics.find((metric) => metric.id === "bitcoin-reference-height")?.receipt)
      .toMatchObject({ proof_state: "chain-tip", reference_block: reference });
  });

  it("does not pin independent Solana performance and priority-fee reads to the displayed slot", async () => {
    const reference = solanaReference();
    const client = {
      getReferenceBlock: async () => reference,
      solanaPerformanceSamples: async () => ({
        chain: reference.chain,
        samples: [{ slot: "123", transactions: "120", slots: "10", sample_period_seconds: "10" }],
        fetched_at: NOW.toISOString(),
        source: reference.source,
      }),
      solanaPrioritizationFees: async () => ({
        chain: reference.chain,
        fees: [{ slot: "123", micro_lamports_per_compute_unit: "5" }],
        fetched_at: NOW.toISOString(),
        source: reference.source,
      }),
    } as unknown as BlockchainRpcClient;
    const pulse = await readChainPulse(resolveBlockchainChain("solana")!, client, NOW);
    const independent = pulse.metrics.filter((metric) => metric.id.startsWith("solana-recent"));
    expect(independent).toHaveLength(2);
    independent.forEach((metric) => {
      expect(metric.receipt.proof_state).toBe("rpc-observation");
      expect(metric.receipt.observed_at).toBeNull();
      expect(metric.receipt).not.toHaveProperty("reference_block");
      expect(metric.receipt).not.toHaveProperty("pinning");
    });
    expect(pulse.metrics.find((metric) => metric.id === "solana-reference-height")?.receipt)
      .toMatchObject({ proof_state: "finalized-slot", reference_block: reference });
  });

  it("retains pinned-block proof for hash-verified EVM block metrics", async () => {
    const reference = evmReference();
    const client = {
      getReferenceBlock: async () => reference,
      evmRead: async () => ({
        number: reference.height_hex,
        hash: reference.hash,
        gasUsed: "0x32",
        gasLimit: "0x64",
        baseFeePerGas: "0x3b9aca00",
      }),
    } as unknown as BlockchainRpcClient;
    const pulse = await readChainPulse(resolveBlockchainChain("ethereum")!, client, NOW);
    const gas = pulse.metrics.find((metric) => metric.id === "ethereum-block-gas-used")!;
    expect(gas.receipt).toMatchObject({ proof_state: "pinned-block", reference_block: reference });
  });
});
