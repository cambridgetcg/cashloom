import { describe, expect, it } from "vitest";
import * as registryApi from "./registry.ts";
import {
  BITCOIN_MAINNET_GENESIS,
  SOLANA_MAINNET_GENESIS,
  blockchainRpcReceipt,
  listBlockchainChains,
  resolveBlockchainChain,
} from "./registry.ts";

describe("blockchain registry", () => {
  it("is a fixed eight-mainnet CAIP-2 registry with reproducibility metadata", () => {
    const rows = listBlockchainChains();
    expect(rows.map((row) => row.key)).toEqual([
      "bitcoin",
      "ethereum",
      "base",
      "arbitrum",
      "optimism",
      "polygon",
      "bsc",
      "solana",
    ]);
    expect(rows.map((row) => row.caip2)).toEqual([
      `bip122:${BITCOIN_MAINNET_GENESIS.slice(0, 32)}`,
      "eip155:1",
      "eip155:8453",
      "eip155:42161",
      "eip155:10",
      "eip155:137",
      "eip155:56",
      `solana:${SOLANA_MAINNET_GENESIS.slice(0, 32)}`,
    ]);
    expect(new Set(rows.map((row) => row.caip2)).size).toBe(8);
    for (const row of rows) {
      expect(row.documentation.official_url).toMatch(/^https:\/\//);
      expect(row.documentation.explorer_url).toMatch(/^https:\/\//);
      expect(row.documentation.rpc_documentation_url).toMatch(/^https:\/\//);
      expect(row.native_asset.caip19).toContain(`${row.caip2}/`);
      expect(row.native_asset.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it("resolves only declared keys, aliases, and CAIP identifiers", () => {
    expect(resolveBlockchainChain("ARB")?.caip2).toBe("eip155:42161");
    expect(resolveBlockchainChain(" eip155:8453 ")?.key).toBe("base");
    expect(resolveBlockchainChain("arbitrary:999")).toBeUndefined();
    expect(resolveBlockchainChain("https://attacker.example/rpc")).toBeUndefined();
  });

  it("serializes a configured target only as a credential-safe receipt", () => {
    const secret = "rpc-secret-do-not-disclose";
    const env = { CASHLOOM_ETHEREUM_RPC_URL: `https://provider.example/v2/${secret}?token=${secret}` };
    const receipt = blockchainRpcReceipt("ethereum", env);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("provider.example");
    expect(JSON.parse(serialized)).toMatchObject({
      chain: "eip155:1",
      provider: "Configured RPC provider",
      configuration: "environment",
      endpoint_disclosed: false,
    });
    expect(receipt).not.toHaveProperty("url");
    expect(listBlockchainChains()[1]).not.toHaveProperty("endpoint");
    expect(registryApi).not.toHaveProperty("resolveInternalRpcTarget");
  });

  it("rejects unsafe configured protocols without repeating configuration", () => {
    expect(() => blockchainRpcReceipt("base", {
      CASHLOOM_BASE_RPC_URL: "ftp://private-secret.example/key",
    })).toThrow("RPC_CONFIGURATION_INVALID");
  });
});
