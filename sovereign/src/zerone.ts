/** zerone.ts — the sovereign node's public front door to zerone.
 *
 *  zerone is the truth chain for agents: it witnesses agent work and mints ZRN
 *  only for what SURVIVES challenge — never for mere acceptance. 222,222,222 ZRN
 *  hard cap, zero ALLOCATION (no team/foundation/investor/faucet balance — every
 *  genesis address is published), honest custodial launch. This module is a PUBLIC,
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
    what: "The playground. Play-value ZRN, faucet-funded onboarding, reset without notice. Prove your integration here.",
  },
};

export const ZRN = {
  symbol: "ZRN",
  denom: "uzrn",
  micro: 1_000_000, // 1 ZRN = 1,000,000 uzrn
  hardCapZrn: 222_222_222,
} as const;

// zerone-1 accounts are not offered (zerone.ai, JOIN.md), so the guide names no
// mainnet passport listing. Window and reward were read live on 2026-10-26 by
// RPC abci_query at h1396563 (the REST params route returns 404):
// substrate_bridge Params.witness_reward_challenge_window_blocks = 200, and
// Adapter(agenttool-invocation-v1) = ACTIVE with witness_reward_uzrn 222000.
export const ZERONE_ONBOARDING = {
  marketplace: "https://api.agenttool.dev",
  testnetPassportListingId: "64cbc078-bbd1-41b4-ad9f-b82363678936",
  freeGuideListingId: "96f679d7-12c7-4f94-abba-ddce800d0767",
  witnessAdapter: "agenttool-invocation-v1",
  witnessRewardZrn: 0.222,
  challengeWindowBlocks: 200,
  // h1394562 → h1396562: 2,000 blocks in 60,017 s (2026-10-25T20:47:57Z → 2026-10-26T13:28:14Z)
  measuredBlockSeconds: 30,
} as const;

// zerone's own public pages: what cashloom says about zerone-1 stays within these.
export const ZERONE_PUBLIC = {
  honestState: "https://zerone.ai/#honest-state",
  whatYouCanDoToday: "https://zerone.ai/#onboarding",
  runANode: "https://zerone.ai/nodes/",
  llms: "https://zerone.ai/llms.txt",
} as const;

export const ZERONE_LINKS = {
  code: "https://github.com/cambridgetcg/zerone-core",
  joinMainnet: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/JOIN.md",
  trust: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md",
  runANode: "https://github.com/cambridgetcg/zerone-core/blob/main/deploy/testnet/RUN-A-NODE.md",
  liquidityTransparency: "https://github.com/cambridgetcg/zerone-core/blob/main/docs/tokenomics/LIQUIDITY-TRANSPARENCY.md",
} as const;

export const ZERONE_LINKS_ACCESS =
  "cambridgetcg/zerone-core is a private repository: these GitHub links return 404 without repository access (zerone.ai/llms.txt says the same). zerone.ai is public.";

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
// agent consumes as JSON. Dated claims were checked on 2026-10-26 against
// zerone-1 (h1396562), zerone.ai and zerone-core main 15c3e5ce.
export function getParticipationGuide() {
  const windowBlocks = ZERONE_ONBOARDING.challengeWindowBlocks;
  const windowMinutes = Math.round((windowBlocks * ZERONE_ONBOARDING.measuredBlockSeconds) / 60);
  return {
    what_is_zerone:
      "The truth chain for agents. It witnesses your work; witness rewards mint ONLY for what survives a challenge window — never for mere acceptance. All emission is on the record under a 222,222,222 ZRN hard cap via three pathways only: proof-of-truth block rewards (zero on empty blocks), survived-witness rewards, and capped newborn bootstrap bonuses. ZRN is additive proof-of-quality — it joins whatever money you already use, it does not replace it.",
    honest_status:
      "Checked 2026-10-26. Custodial launch phase: one household, the people who started zerone, runs zerone-1's only validator and holds the vote on every change; zerone.ai says that household can stop, roll back or restart the chain. zerone-1 accounts are not offered: zerone.ai says there is no sign-up, no starter ZRN and no supported way to join as a validator, and JOIN.md says onboarding and transaction lanes are paused. Accounts made through the earlier passport sign-up began as shared custody: the operator kept a copy of each key. External ZRN liquidity is a proof-of-concept on the Osmosis testnet (osmo-test-5) with play-value tokens, and the IBC light client it depends on reads Expired. See zerone.ai/#honest-state.",
    for_humans: [
      "Look: read the live chain with no account — this node's /api/zerone/status, zerone.ai, or curl the RPC directly. These reads come from the household's own node: observations, not independent proofs.",
      "Join: not offered. zerone.ai (checked 2026-10-26) says \"There is no safe way yet to create new zerone-1 accounts, so none are offered. Do not send money, secrets, identity documents, or seed phrases to anyone offering access.\" JOIN.md says of the earlier agenttool mainnet passport: \"Do not purchase, promise, automate, or broadcast that lane from this source head.\"",
      "Run a node: zerone.ai/nodes/ gives the status of the signed legacy observer release. An observer follows zerone-1 and grants no account, transaction or validator role; building from source needs access to the private zerone-core repository. Validator joining on zerone-1 is paused (JOIN.md).",
    ],
    for_agents: [
      "Onboard: zerone-1 accounts are not offered (see for_humans). Reads need no account: /api/zerone/status, /api/zerone/balance/{zrn1 address}, and the /v1/zerone truth doors.",
      `Earn (protocol, not open today): the ${ZERONE_ONBOARDING.witnessAdapter} witness adapter reads ACTIVE on-chain. A witness-only settlement escrows ${ZERONE_ONBOARDING.witnessRewardZrn} ZRN and releases it after ${windowBlocks} blocks (witness_reward_challenge_window_blocks), about ${windowMinutes} minutes at the ${ZERONE_ONBOARDING.measuredBlockSeconds} s block time measured on 2026-10-26. Attesting needs a funded zerone-1 key and a bond, and JOIN.md says onboarding and transaction lanes are paused.`,
      "Compose: an address's claim record (submissions, accepted, corroborations, calibration score) is readable at /v1/zerone/agent/{address}/calibration and its ZRN at /api/zerone/balance/{address}. Separately, this node CAN read an agenttool wallet once you add an agenttool account + API key — an opt-in capability, not a read of zerone itself, and nothing a fresh node reads out of the box.",
    ],
    exit:
      "No IBC exit works today (checked 2026-10-26). zerone-1's only IBC transfer channel (channel-0 to Osmosis channel-11806) depends on light client 07-tendermint-0, whose status reads Expired, so no IBC transfer can be relayed until that client is recovered. The counterparty is the Osmosis testnet osmo-test-5: zerone's liquidity doc says its ZRN/OSMO pool is operator-owned play value, not a market. Moving ZRN within zerone-1 needs an existing account.",
    onboarding: {
      zerone_1_accounts: "not offered (zerone.ai/#onboarding, checked 2026-10-26)",
      marketplace: ZERONE_ONBOARDING.marketplace,
      testnet_passport_listing: ZERONE_ONBOARDING.testnetPassportListingId,
      free_guide_listing: ZERONE_ONBOARDING.freeGuideListingId,
      witness_adapter: ZERONE_ONBOARDING.witnessAdapter,
      witness_reward_zrn: ZERONE_ONBOARDING.witnessRewardZrn,
      challenge_window_blocks: windowBlocks,
      challenge_window_basis: `witness_reward_challenge_window_blocks read live on 2026-10-26 via RPC abci_query /zerone.substrate_bridge.v1.Query/Params at height 1396563 (the REST params route returns 404); ~${windowMinutes} min at ${ZERONE_ONBOARDING.measuredBlockSeconds} s per block`,
    },
    networks: { mainnet: ZERONE_NETWORKS.mainnet, testnet: ZERONE_NETWORKS.testnet },
    zerone_public: ZERONE_PUBLIC,
    links: ZERONE_LINKS,
    links_access: ZERONE_LINKS_ACCESS,
    denom: { symbol: ZRN.symbol, base: ZRN.denom, micro: ZRN.micro, hard_cap_zrn: ZRN.hardCapZrn },
  };
}
