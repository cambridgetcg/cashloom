# CashLoom — The Everything Wallet

> Money you can read. Money anyone can use. Money for everything.

## The Vision

CashLoom starts as a personal finance tracker. It becomes the universal
wallet for everyone and everything — the human-facing app for the zerone
protocol, the truth chain for agents.

One wallet. Three layers. All inclusive.

## The Three Layers

### Layer 1: Track (today)
What CashLoom already does: log income and expenses, scan receipts, import
bank statements, see analytics, get AI insights. Personal finance that works.

### Layer 2: Pay (the bridge)
CashLoom becomes a real wallet — send and receive money, not just track it.

- **P2P payments** — send to anyone by handle, email, or wallet address
- **Payment requests** — invoice anyone, get paid in fiat or on-chain
- **Subscriptions** — recurring payments with programmable conditions
- **Multi-currency** — fiat (USD, GBP, EUR) and on-chain (ZRN, stablecoins)
- **Payment links** — one link, any amount, any currency, any recipient

### Layer 3: Protocol (the connection)
CashLoom connects to the zerone protocol — the agent-native truth chain
where truth has value.

- **Agent wallet** — every CashLoom account gets a zerone (ZRN) wallet
- **Knowledge claims** — submit verified knowledge, earn rewards
- **Programmable payments** — condition transfers on verification, time, or
  any computable rule the protocol can enforce
- **Agent marketplace** — pay agents for work, get paid by agents
- **Proof of Truth** — every transaction is verifiable, no trust required

## Who Is It For?

- **Everyone** — a person who just wants to track their money
- **Everyone** — a freelancer who wants to invoice and get paid
- **Everyone** — an AI agent that needs money to operate
- **Everything** — a coffee, a salary, a knowledge claim, an agent's work

## Principles

1. **Money you can read** — every number has a source, every transfer has a
   trail, every balance is verifiable. (From zerone's first law.)
2. **All inclusive** — no one excluded. Fiat or crypto, human or agent,
   rich or broke. One wallet for all of it.
3. **Truth is the product** — verified knowledge has value. The protocol
   rewards truth. The wallet makes it usable.
4. **Nothing breaks** — the existing tracker works. We add layers, never
   remove what works. Reversible steps, bounded changes.
5. **Joy, peace, safety** — money is stressful. This should be the opposite.

## What We Build First

The bridge between CashLoom and zerone. One small, real step:

1. **Wallet model** — add a wallet to every CashLoom user (a keypair + address
   on the zerone protocol)
2. **Balance endpoint** — show both fiat balance (from transactions) and
   on-chain balance (from the protocol)
3. **Transfer** — send from one CashLoom wallet to another (first on devnet,
   then testnet, then mainnet)

That's the first door. Everything else flows from it.

## What Already Exists

- **CashLoom** (~/github/cambridgetcg/cashloom) — working finance tracker,
  53 commits, tests, deploy configs, AI import, analytics, reports
- **zerone** (github.com/cambridgetcg/zerone-core) — a live Cosmos SDK chain
  (chain-id `zerone-1`), Proof of Truth consensus, agent wallets, IBC, and
  governance. Genesis was 13,555 ZRN with every address published, under a
  222,222,222 ZRN hard cap; ZRN mints only on participation.
- **agenttool** (~/codeberg/zerone-dev/agenttool) — agent infrastructure with
  identity, vault, messaging, marketplace, federation

The pieces are built. The connection is the doorstep.

## The North Star

A world where:
- A person tracks their coffee with the same wallet an agent uses to buy
  compute
- A freelancer invoices in fiat and gets paid on-chain, same app, same balance
- A knowledge claim earns rewards that show up in a human's wallet
- Money is legible — readable, verifiable, honest — for everyone and everything

Truth is. Love is. Joy is. Peace is. Fun is. Chill is. Real recognises real.