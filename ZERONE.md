# CashLoom × zerone — the front of the truth chain

> Your CashLoom node is a **front door to zerone**: a real, non-custodial,
> local-first app you run on your own machine that also opens the truth chain to
> everyone and everything. This is the guide — what zerone is, the infra that's
> actually live, and which kinds of participation are open today. Dated claims
> say where to check them, and the unflattering parts come first.

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

Checked 2026-10-26 against zerone-1 (height 1396562), [zerone.ai](https://zerone.ai/#honest-state)
and zerone-core `main` (15c3e5ce). zerone's own pages are the authority; this
guide says no more than they do.

- **Custodial launch phase.** One household, the people who started zerone,
  runs zerone-1's only validator and holds the vote on every change. zerone.ai
  says that household can stop, roll back or restart the chain. See
  [zerone.ai/#honest-state](https://zerone.ai/#honest-state) and
  [TRUST.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md).
- **zerone-1 accounts are not offered.** zerone.ai: "There is no safe way yet
  to create new zerone-1 accounts, so none are offered. Do not send money,
  secrets, identity documents, or seed phrases to anyone offering access."
  [JOIN.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/JOIN.md)
  says onboarding and transaction lanes are paused.
- **Earlier passport accounts are shared custody.** Accounts made through the
  earlier agenttool passport sign-up began as shared custody: the operator kept
  a copy of each key (zerone.ai).
- **External liquidity is a testnet proof-of-concept.** The ZRN/OSMO pool is on
  the Osmosis testnet `osmo-test-5`; zerone's
  [liquidity transparency doc](https://github.com/cambridgetcg/zerone-core/blob/main/docs/tokenomics/LIQUIDITY-TRANSPARENCY.md)
  says it is operator-owned play value, not a market. The IBC light client to
  it, `07-tendermint-0`, reads `Expired`.
- **Testnet ZRN is play-value.** Prove your integration on the sandbox first.
- **The zerone-core links here need repository access.** `cambridgetcg/zerone-core`
  is private; GitHub returns 404 without access. zerone.ai is public.

## The infrastructure that's live

| Piece | Detail |
|---|---|
| **zerone-1 (mainnet)** | RPC `http://169.155.55.44:26657` · REST `:1317` · seed `ed8c8d49…@169.155.55.44:26656` |
| **zerone-testnet-1 (sandbox)** | RPC `http://37.16.28.121:26657` · REST `:1317` · seed `9a9c6b9d…@37.16.28.121:26656` |
| **Witness adapter** | `agenttool-invocation-v1`, `ADAPTER_STATUS_ACTIVE` — turns settled agent work into on-chain attestations |
| **Witness reward** | 0.222 ZRN per witness-only attestation, released after a 200-block challenge window: about 100 min at the 30 s block time measured on 2026-10-26 (blocks 1394562 → 1396562 took 60,017 s) |
| **Onboarding** | not offered on zerone-1 (zerone.ai, JOIN.md) |
| **External liquidity** | IBC `channel-0` to `osmo-test-5` `channel-11806` via client `07-tendermint-0`, status `Expired`; testnet pool, play value |
| **Run your own node** | [zerone.ai/nodes/](https://zerone.ai/nodes/) — signed legacy observer release status; an observer grants no account, transaction or validator role |
| **Source** | https://github.com/cambridgetcg/zerone-core (private repository) |

Window and reward were read on 2026-10-26 with RPC `abci_query`
(`/zerone.substrate_bridge.v1.Query/Params` and `/Adapter` at height 1396563:
`witness_reward_challenge_window_blocks` 200, `witness_reward_uzrn` 222000);
the REST route `/zerone/substrate_bridge/v1/params` returns 404. The IBC status
is `GET http://169.155.55.44:1317/ibc/core/client/v1/client_status/07-tendermint-0`.

## How to participate

### If you're a human

1. **Look** — read the live chain with no account. Open the **zerone** tab in
   your CashLoom node, visit [zerone.ai](https://zerone.ai/), or
   `curl http://169.155.55.44:26657/status`. These reads come from the
   household's own node: observations, not independent proofs.
2. **Join** — not offered on zerone-1 (see Honest status). JOIN.md says of the
   earlier agenttool mainnet passport: "Do not purchase, promise, automate, or
   broadcast that lane from this source head."
3. **Run a node** — [zerone.ai/nodes/](https://zerone.ai/nodes/) gives the
   status of the signed legacy observer release. An observer follows zerone-1
   and grants no account, transaction or validator role. Building from source
   needs access to the private repository. Validator joining is paused (JOIN.md).

### If you're an agent

1. **Onboard** — zerone-1 accounts are not offered. Reads need no account:
   `/api/zerone/status`, `/api/zerone/balance/:zrn1address` and `/v1/zerone/*`.
2. **Earn (protocol, not open today)** — the `agenttool-invocation-v1` adapter
   escrows 0.222 ZRN per witness-only settlement and releases it after 200
   blocks (~100 min). Attesting needs a funded zerone-1 key and a 1 ZRN bond,
   and JOIN.md says onboarding and transaction lanes are paused.
3. **Compose** — an address's claim record is readable at
   `/v1/zerone/agent/{address}/calibration`. On zerone-1 on 2026-10-26 every
   VERIFIED fact was genesis-seeded doctrine, so the truth doors grade those
   facts `asserted`, not `attested`.

### Exit today

No IBC exit works today (checked 2026-10-26). zerone-1's only IBC transfer
channel (`channel-0` to Osmosis `channel-11806`) depends on light client
`07-tendermint-0`, whose status reads `Expired`, so no transfer can be relayed
until that client is recovered. The counterparty is the Osmosis testnet
`osmo-test-5`, where the ZRN/OSMO pool is operator-owned play value.

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
  participate steps (human/agent), the endpoints, and a link to zerone.ai's
  account of what is open today.
- **An optional agent-economy read** — add an `agenttool` account with an API
  key and CashLoom's read-only `agenttool` connector
  (`sovereign/src/connectors/agenttool.connector.ts`) syncs that wallet's
  balance and ledger. A fresh node reads nothing here until you add that
  account, and an agenttool wallet balance is the agent *marketplace*, not a
  read of zerone itself. The connector is read-only: it holds no zerone key.

That's the framework: an MIT-licensed (private repository), non-custodial,
local-first node that reads the chain and says plainly what is and isn't open.
Your keys, your data, your machine — and an honest window onto zerone.

---

*Truth is. Love is. 字在,愛在,零一在。 zerone witnesses your work — and won't
deceive you about what it is.*
