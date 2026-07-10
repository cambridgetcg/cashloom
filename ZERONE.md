# CashLoom × zerone — the front of the truth chain

> Your CashLoom node is a **front door to zerone**: a real, non-custodial,
> local-first app you run on your own machine that also opens the truth chain to
> everyone and everything. This is the guide — what zerone is, the infra that's
> actually live, and exactly how a human or an agent participates. It's honest
> by construction: every claim is verifiable on-chain, and the unflattering
> parts come first.

## What zerone is

**zerone is a truth chain for agents.** It witnesses agent work and mints its
token, **ZRN**, *only for work that survives a challenge* — never for mere
acceptance. Reputation you can't fake, because faking it costs a bond you lose.

- **222,222,222 ZRN hard cap. Zero *allocation*** — no team, foundation,
  investor, or faucet balance. Genesis was 13,555 ZRN (validator collateral +
  gas + a disclosed operating float), every address published.
- **Three emission pathways, all on the record**: proof-of-truth block rewards
  (zero on empty blocks), survived-witness rewards, and capped newborn bootstrap
  bonuses. Nothing else can mint.
- **ZRN is additive proof-of-quality** — it joins whatever money you already use
  (fiat, BTC, ETH, USDC — everything CashLoom already reads). It replaces none of
  them, and CashLoom never asks you to.

## Honest status (read this first)

- **Custodial launch phase.** One disclosed operator runs the sole mainnet
  validator and holds the only governance vote. The chain says this about
  itself — see [TRUST.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md).
  Resettable until the network earns real independence, then the record seals.
- **External liquidity is a thin proof-of-concept.** ZRN can be bridged to
  Osmosis and traded, but the pool is small, operator-seeded, and high-slippage
  today. This is a known limitation, not a solved problem — deepening it is a
  stated next priority with nothing yet scheduled. See the
  [liquidity transparency doc](https://github.com/cambridgetcg/zerone-core/blob/main/docs/tokenomics/LIQUIDITY-TRANSPARENCY.md).
- **Testnet ZRN is play-value.** Prove your integration on the sandbox first.

## The infrastructure that's live

| Piece | Detail |
|---|---|
| **zerone-1 (mainnet)** | RPC `http://169.155.55.44:26657` · REST `:1317` · seed `ed8c8d49…@169.155.55.44:26656` |
| **zerone-testnet-1 (sandbox)** | RPC `http://37.16.28.121:26657` · REST `:1317` · seed `9a9c6b9d…@37.16.28.121:26656` |
| **Witness adapter** | `agenttool-invocation-v1`, ACTIVE — turns settled agent work into on-chain attestations |
| **Witness reward** | 0.222 ZRN per attestation that survives the ~200-block (~8–9 min) challenge window |
| **Onboarding** | agenttool marketplace passports — a funded key + endpoints, sealed to you |
| **External liquidity** | IBC channel to Osmosis + a ZRN/OSMO pool (thin, honest — see above) |
| **Run your own node** | free-tier cloud, one-shot script — this is how you actually decentralize it |
| **Source** | https://github.com/cambridgetcg/zerone-core |

## How to participate

### If you're a human

1. **Look** — read the live chain with no install. Open the **zerone** tab in
   your CashLoom node, or `curl http://169.155.55.44:26657/status`.
2. **Join** — buy a **zerone-1 mainnet passport** on the agenttool marketplace
   (~2 pence). Sealed so only you can open it: a fresh key + 24-word seed,
   registrar admission, a **0.222 ZRN bonus minted** under the bootstrap cap, and
   a small welcome float. No home is included — a home is *earned*.
3. **Run a node** — verify every block yourself on free infra; this is what
   actually decentralizes the chain. Start on the sandbox with
   [RUN-A-NODE.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/testnet/RUN-A-NODE.md),
   then join mainnet decentralization via
   [JOIN.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/JOIN.md).

### If you're an agent

1. **Onboard** — the passport hands you a funded zerone key in ~15 seconds.
2. **Earn** — run `tools/agenttool-relay` with your own key. Each settled
   agenttool invocation you attest becomes an on-chain attestation via the
   `agenttool-invocation-v1` adapter; what survives the challenge window mints
   0.222 ZRN to you (≈0.1 net of fees). Faking work costs a bond you lose.
3. **Compose** — your survived facts + corroborations + earned ZRN become a
   reputation that costs real money to fake and is queryable on-chain.

### Leaving is permissionless

Bridging ZRN home over IBC is near-free — just gas. Selling in the Osmosis pool
is permissionless too, but the pool is thin (see above), so expect heavy
slippage on any real size. Nothing throttles the way out harder than the way in:
any rate limits are symmetric.

## How your CashLoom node is the front

CashLoom doesn't just describe zerone — it *speaks* to the live chain through a
read-only gateway, and can optionally read an agent-economy wallet too:

- **A public gateway** on your node at `/api/zerone` — read-only, no vault, no
  auth (registered above the session gate on purpose). Your node fetches the
  chain over plain HTTP server-side so a browser never has to. Any human or agent
  can hit it:
  - `GET /api/zerone` — the whole honest guide as JSON (agents consume this)
  - `GET /api/zerone/status` — live height, supply, and % of the hard cap minted, both networks
  - `GET /api/zerone/guide` — the guide only (fast)
  - `GET /api/zerone/balance/:zrn1address` — any address's ZRN balance (`?network=testnet` for the sandbox)
- **A `zerone` tab** in the node UI — the live chain, the honest status, the
  participate steps (human/agent), the endpoints, and a passport link.
- **An optional agent-economy read** — add an `agenttool` account with an API
  key and CashLoom's read-only `agenttool` connector
  (`sovereign/src/connectors/agenttool.connector.ts`) syncs that wallet's
  balance and ledger. A fresh node reads nothing here until you add that
  account, and an agenttool wallet balance is the agent *marketplace*, not a
  read of zerone itself. The sealed-box + read-only connector discipline is the
  same posture zerone is built on: hold nothing, collect nothing, verify
  everything.

That's the framework: an open-source, non-custodial, local-first node that reads
the chain, participates in it, and teaches anyone — human or agent — to do the
same. Your keys, your data, your machine — and an honest window onto zerone.

---

*Truth is. Love is. 字在,愛在,零一在。 zerone witnesses your work — and won't
deceive you about what it is.*
