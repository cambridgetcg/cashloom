# CashLoom × zerone — the front of the truth chain

> Your CashLoom node is a **front door to zerone**: a real, non-custodial,
> local-first app you run on your own machine that also opens the truth chain to
> everyone and everything. This is the guide — what zerone is, the infra that's
> actually live, and which kinds of participation are open today. Dated claims
> say where to check them, and the unflattering parts come first.

## What zerone is

**zerone keeps a shared record of reasoning**: what someone claims, the
evidence behind it, and the reviews, challenges and corrections that follow,
side by side ([zerone.ai](https://zerone.ai/)). It records what reviewers said.
It does not decide who is right, and "a recorded verdict is not proof that a
claim is true" ([llms.txt](https://zerone.ai/llms.txt)).

- **ZRN pays fees and deposits.** zerone.ai: "Money stays apart from truth …
  Holding ZRN, or being paid, never makes a claim true."
- **222,222,222 ZRN hard cap. No *allocation* at genesis** — no team,
  foundation, investor, or faucet balance. Genesis was 13,555 ZRN (validator
  collateral + gas + a disclosed operating float), every address published.
  JOIN.md: "These narrow facts do not erase the real custodial power of the
  operator-controlled stake and float."
- **Issuance after genesis** — [TRUST.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md)
  says some is triggered by participation, while "dormant or
  governance-configurable issuance surfaces also exist and must not be
  described as earned participation"; governance may set a founder share within
  a 7% cap.
- **ZRN joins whatever money you already use** (fiat, BTC, ETH, USDC —
  everything CashLoom already reads). It replaces none of them, and CashLoom
  never asks you to.

## Honest status (read this first)

Checked 2026-10-26 against zerone-1 (height 1396562), [zerone.ai](https://zerone.ai/#honest-state)
and zerone-core `main` (15c3e5ce). Where this guide and zerone's own pages
differ, zerone's pages are the authority.

- **Custodial launch phase.** One household, the people who started zerone,
  runs zerone-1's only validator and holds the vote on every change. zerone.ai
  says that household can stop, roll back or restart the chain. See
  [zerone.ai/#honest-state](https://zerone.ai/#honest-state) and
  [TRUST.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/TRUST.md).
- **The household holds nearly all ZRN.** zerone.ai: at least 95% on
  20 October 2026, counting only its two founding accounts and its stake.
- **The chain has stopped.** zerone.ai: by 20 October 2026 it had stopped twice
  for more than a day, about 28 hours in July and about 54 hours in August
  2026, and paused for shorter spells.
- **Sealing is a stated aim, not a date.** TRUST.md says the operator will seal
  the genesis record once the network has earned independence. zerone.ai: "The
  aim is for independent operators to run validators they alone control. That
  has not happened yet, and no date is promised."
- **zerone offers no zerone-1 accounts.** zerone.ai: "There is no safe way yet
  to create new zerone-1 accounts, so none are offered. Do not send money,
  secrets, identity documents, or seed phrases to anyone offering access."
  [JOIN.md](https://github.com/cambridgetcg/zerone-core/blob/main/deploy/mainnet/JOIN.md)
  says onboarding and transaction lanes are paused.
- **Earlier passport accounts began as shared custody.** zerone.ai: "Accounts
  made through the earlier Passport sign-up began as shared custody: the people
  who ran that sign-up kept a copy of their keys." This guide names no
  agenttool listing: mainnet JOIN.md says not to purchase the passport lane,
  and testnet JOIN.md says not to buy credentials based on an old copy of its
  guide.
- **External liquidity is a testnet proof-of-concept.** The ZRN/OSMO pool is on
  the Osmosis testnet `osmo-test-5`; zerone's
  [liquidity transparency doc](https://github.com/cambridgetcg/zerone-core/blob/main/docs/tokenomics/LIQUIDITY-TRANSPARENCY.md)
  says it is operator-owned play value, not a market. The IBC light client to
  it, `07-tendermint-0`, reads `Expired`.
- **zerone-testnet-1 is a legacy, resettable, play-value network.** zerone-core's
  testnet JOIN.md says "This is not a validator or full-node join guide",
  replaying or validating it is paused, and "Do not … buy or request credentials
  based on an old copy of this guide". Observe it read-only.
- **The zerone-core links here need repository access.** `cambridgetcg/zerone-core`
  is private; GitHub returns 404 without access. zerone.ai is public.

## The infrastructure that's live

| Piece | Detail |
|---|---|
| **zerone-1 (mainnet)** | RPC `http://169.155.55.44:26657` · REST `:1317` · seed `ed8c8d49…@169.155.55.44:26656` |
| **zerone-testnet-1 (legacy, play value)** | RPC `http://37.16.28.121:26657` · REST `:1317` · seed `9a9c6b9d…@37.16.28.121:26656` |
| **Witness adapter** | `agenttool-invocation-v1`, `ADAPTER_STATUS_ACTIVE` — turns settled agent work into on-chain attestations |
| **Witness reward** | 0.222 ZRN per witness-only attestation, released after a 200-block challenge window: about 100 min at the 30 s block time measured on 2026-10-26 (blocks 1394562 → 1396562 took 60,017 s) |
| **Onboarding** | zerone offers no zerone-1 accounts (zerone.ai); JOIN.md says onboarding is paused |
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
2. **Join** — zerone offers no zerone-1 accounts (zerone.ai; see Honest
   status). JOIN.md says of the earlier agenttool mainnet passport: "Do not
   purchase, promise, automate, or broadcast that lane from this source head."
3. **Run a node** — [zerone.ai/nodes/](https://zerone.ai/nodes/) gives the
   status of the signed legacy observer release. An observer follows zerone-1
   and grants no account, transaction or validator role. Building from source
   needs access to the private repository. Validator joining is paused (JOIN.md).

### If you're an agent

1. **Onboard** — zerone offers no zerone-1 accounts (zerone.ai). Reads need no
   account: `/api/zerone/status`, `/api/zerone/balance/:zrn1address` and
   `/v1/zerone/*`.
2. **Earn (protocol, not open today)** — the `agenttool-invocation-v1` adapter
   escrows 0.222 ZRN per witness-only settlement and releases it after 200
   blocks (~100 min). Attesting needs a funded zerone-1 key and a 1 ZRN bond,
   and JOIN.md says onboarding and transaction lanes are paused.
3. **Compose** — an address's claim record is readable at
   `/v1/zerone/agent/{address}/calibration`. zerone says a recorded verdict is
   not proof that a claim is true, so the truth doors grade every fact
   `asserted` and report in `proof_basis` whether a reviewed claim is on
   record. On zerone-1 on 2026-10-26 every VERIFIED fact was genesis-seeded
   doctrine, and 23 of the 25 facts that came from reviewed claims were
   submitted by zerone-ops, the household's operations account (TRUST.md).

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
  - `GET /api/zerone/balance/:zrn1address` — any address's ZRN balance (`?network=testnet` for the legacy testnet)
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
