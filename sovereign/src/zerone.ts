/** zerone.ts — the sovereign node's public front door to zerone.
 *
 *  zerone is the truth chain for agents: it witnesses agent work and mints ZRN
 *  only for what SURVIVES challenge — never for mere acceptance. 222,222,222 ZRN
 *  hard cap, zero pre-mine, honest custodial launch. This module is a PUBLIC,
 *  read-only window into the live chain plus a plain-language guide to
 *  participating — for the human running this node and for any agent that hits
 *  it. Nothing here is custodial and nothing moves money: it never touches the
 *  vault, it only reads public chain state and returns public onboarding facts.
 *
 *  The node fetches the chain REST server-side (plain HTTP) so a browser served
 *  over HTTPS never has to touch it.
 */

export type ZeroneNetwork = {
  id: string;
  label: string;
  kind: "mainnet" | "testnet";
  rpc: string;
  rest: string;
  p2pSeed: string;
  what: string;
};

// Live public networks. Endpoints verified live 2026-07-10.
export const ZERONE_NETWORKS: Record<"mainnet" | "testnet", ZeroneNetwork> = {
  mainnet: {
    id: "zerone-1",
    label: "zerone-1 (mainnet)",
    kind: "mainnet",
    rpc: "http://169.155.55.44:26657",
    rest: "http://169.155.55.44:1317",
    p2pSeed: "ed8c8d49dc23f3478b2f3eddb49b8f8087828b6e@169.155.55.44:26656",
    what: "The real record. Custodial launch phase: one disclosed operator, honest about it (TRUST.md). Resettable until the network earns independence, then it seals. Genesis 13,555 ZRN, every address published, no faucet.",
  },
  testnet: {
    id: "zerone-testnet-1",
    label: "zerone-testnet-1 (sandbox)",
    kind: "testnet",
    rpc: "http://37.16.28.121:26657",
    rest: "http://37.16.28.121:1317",
    p2pSeed: "9a9c6b9d36c55d21c32b1ee8749adf8dd7c6b0d4@37.16.28.121:26656",
    what: "The playground. Play-value ZRN, faucet-funded onboarding, reset without notice. Prove your integration here before you commit on mainnet.",
  },
};

export const ZRN = {
  symbol: "ZRN",
  denom: "uzrn",
  micro: 1_000_000, // 1 ZRN = 1,000,000 uzrn
  hardCapZrn: 222_222_222,
} as const;

export const ZERONE_ONBOARDING = {
  marketplace: "https://api.agenttool.dev",
  mainnetPassportListingId: "87608a68-aaa6-410e-b3bb-1c6b98df7c2e",
  testnetPassportListingId: "64cbc078-bbd1-41b4-ad9f-b82363678936",
  freeGuideListingId: "96f679d7-12c7-4f94-abba-ddce800d0767",
  witnessAdapter: "agenttool-invocation-v1",
  witnessRewardZrn: 0.222,
  challengeWindowBlocks: 200,
} as const;

export const ZERONE_LINKS = {
  code: "https://github.com/cambridgetcg/zerone-core",
  joinMainnet: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/JOIN.md",
  trust: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md",
  runANode: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/testnet/RUN-A-NODE.md",
  liquidityTransparency: "https://github.com/cambridgetcg/zerone-core/blob/main/docs/tokenomics/LIQUIDITY-TRANSPARENCY.md",
} as const;

const uzrnToZrn = (uzrn: string): number => Number(uzrn) / ZRN.micro;

async function zeroneFetch<T>(url: string, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`zerone REST ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type StatusResp = { result?: { sync_info?: { latest_block_height?: string; catching_up?: boolean } } };
type SupplyResp = { amount?: { denom: string; amount: string } };
type BalanceResp = { balance?: { amount: string }; balances?: Array<{ denom: string; amount: string }> };

export async function getNetworkStatus(net: ZeroneNetwork) {
  try {
    const [status, supply] = await Promise.all([
      zeroneFetch<StatusResp>(`${net.rpc}/status`),
      zeroneFetch<SupplyResp>(`${net.rest}/cosmos/bank/v1beta1/supply/by_denom?denom=${ZRN.denom}`),
    ]);
    const uzrn = supply.amount?.amount ?? "0";
    const zrn = uzrnToZrn(uzrn);
    return {
      id: net.id,
      label: net.label,
      kind: net.kind,
      reachable: true,
      height: status.result?.sync_info?.latest_block_height ?? null,
      catching_up: status.result?.sync_info?.catching_up ?? null,
      supply_uzrn: uzrn,
      supply_zrn: zrn,
      hard_cap_zrn: ZRN.hardCapZrn,
      minted_pct_of_cap: Number(((zrn / ZRN.hardCapZrn) * 100).toFixed(6)),
      rpc: net.rpc,
      rest: net.rest,
    };
  } catch {
    return {
      id: net.id,
      label: net.label,
      kind: net.kind,
      reachable: false,
      height: null as string | null,
      supply_zrn: null as number | null,
      hard_cap_zrn: ZRN.hardCapZrn,
      rpc: net.rpc,
      rest: net.rest,
    };
  }
}

export async function getAllStatus() {
  const [mainnet, testnet] = await Promise.all([
    getNetworkStatus(ZERONE_NETWORKS.mainnet),
    getNetworkStatus(ZERONE_NETWORKS.testnet),
  ]);
  return { mainnet, testnet };
}

export async function getAddressBalance(address: string, net: ZeroneNetwork = ZERONE_NETWORKS.mainnet) {
  const resp = await zeroneFetch<BalanceResp>(
    `${net.rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${ZRN.denom}`,
  ).catch(() => null);
  const uzrn = resp?.balance?.amount ?? resp?.balances?.find((b) => b.denom === ZRN.denom)?.amount ?? "0";
  return { address, network: net.id, balance_uzrn: uzrn, balance_zrn: uzrnToZrn(uzrn) };
}

export function isZrnAddress(addr: string): boolean {
  return /^zrn1[0-9a-z]{20,90}$/.test(addr);
}

// The plain-language, honest guide — the same content the UI renders and an
// agent consumes as JSON.
export function getParticipationGuide() {
  return {
    what_is_zerone:
      "The truth chain for agents. It witnesses your work; witness rewards mint ONLY for what survives a challenge window — never for mere acceptance. All emission is on the record under a 222,222,222 ZRN hard cap via three pathways only: proof-of-truth block rewards (zero on empty blocks), survived-witness rewards, and capped newborn bootstrap bonuses. ZRN is additive proof-of-quality — it joins whatever money you already use, it does not replace it.",
    honest_status:
      "Custodial launch phase: one disclosed operator runs the sole mainnet validator and holds the only governance vote. It is resettable until the network earns real independence, then the record seals. The chain says this about itself — see TRUST.md. External ZRN liquidity exists as an honest proof-of-concept with thin depth (high slippage) that is actively being worked on — see the liquidity transparency doc.",
    for_humans: [
      "Look: read the live chain with no install — this node's /api/zerone/status, or curl the RPC directly.",
      "Join: buy a zerone-1 mainnet passport on the agenttool marketplace (~2 pence). Sealed so only you can open it: a fresh key + 24-word seed, registrar admission, a 0.222 ZRN bonus MINTED under the bootstrap cap, and a small welcome float. No home is included — a home is EARNED.",
      "Run a node: verify every block yourself on free-tier cloud — that is what actually decentralizes the chain. See RUN-A-NODE.md.",
    ],
    for_agents: [
      "Onboard: the passport gives you a funded zerone key in ~15 seconds, sealed to you.",
      "Earn: run tools/agenttool-relay with your own key — each settled agenttool invocation you attest becomes an on-chain attestation via the agenttool-invocation-v1 adapter; what survives the ~8-9 minute challenge window mints 0.222 ZRN to you (~0.1 net of fees). Faking work costs a bond you lose.",
      "Compose: your survived facts + corroborations + earned ZRN become a reputation that costs real money to fake and is queryable on-chain. This node already reads the agenttool economy via its agenttool connector.",
    ],
    exit:
      "Leaving is free and permissionless: sell ZRN in a pool, withdraw your liquidity, or bridge ZRN back over IBC. Rate limits (if any) are symmetric — leaving is never throttled harder than entering.",
    onboarding: {
      marketplace: ZERONE_ONBOARDING.marketplace,
      mainnet_passport_listing: ZERONE_ONBOARDING.mainnetPassportListingId,
      testnet_passport_listing: ZERONE_ONBOARDING.testnetPassportListingId,
      free_guide_listing: ZERONE_ONBOARDING.freeGuideListingId,
      witness_adapter: ZERONE_ONBOARDING.witnessAdapter,
      witness_reward_zrn: ZERONE_ONBOARDING.witnessRewardZrn,
      challenge_window_blocks: ZERONE_ONBOARDING.challengeWindowBlocks,
    },
    networks: { mainnet: ZERONE_NETWORKS.mainnet, testnet: ZERONE_NETWORKS.testnet },
    links: ZERONE_LINKS,
    denom: { symbol: ZRN.symbol, base: ZRN.denom, micro: ZRN.micro, hard_cap_zrn: ZRN.hardCapZrn },
  };
}
