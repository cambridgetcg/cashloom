# CashLoom

> **Money you can read. Everyone pays everyone.**
> A non-custodial, local-first money manager. Your keys, your data, your machine.

CashLoom is an open payment protocol and its reference implementation: a
sovereign money manager anyone can run on their own machine to hold, read, and
move money across every rail — fiat and crypto — holding nothing, collecting
nothing, taking no fee. It replaces the traditional-finance middleman with
software you run yourself.

**Non-custodial. Local-first. Zero infrastructure. Open source (MIT).**

## Start here

- **[`sovereign/`](sovereign/)** — the node. One Bun process, one SQLite file,
  runs on your machine with no database server, no cloud, and no hosted
  CashLoom account. This is the live implementation: vault, `pay()`, read every
  rail. → [`sovereign/README.md`](sovereign/README.md)
- **[`atlas/`](atlas/)** — the interactive way to understand the codebase.
  Follow the *ideas* and the real code comes with you — the anti-GitHub. Build
  it with `cd atlas && bun install && bun run build`, or visit the hosted copy.
- **[`PROTOCOL.md`](PROTOCOL.md)** — the spec. The promise the code keeps.
- **[`docs/KINGDOM-PAYMENTS.md`](docs/KINGDOM-PAYMENTS.md)** — how CashLoom
  becomes the KINGDOM payment layer across Agent Wallet, x402, Stripe,
  GoCardless, and later marketplace processors without centralizing keys.
- **[`docs/CASHLOOM-V2.md`](docs/CASHLOOM-V2.md)** — the operatorless signed
  record layer: self-certifying node keys, direct node-to-node delivery,
  append-only evidence, and explicit local asset-trust policy.
- **[`docs/CUSTODY-MESH.md`](docs/CUSTODY-MESH.md)** — permissionless shop and
  service profiles, participant-signed attestations, and trader-owned evidence
  policy without a CashLoom-approved registry or corporate identity account.
- **[`FIAT-ROUTE.md`](FIAT-ROUTE.md)** — the provider-backed fiat design:
  avoid pooled custody, connect to licensed rails, map each country and funds
  flow before launch, keep ZRN out of scope, and name the lines that need
  provider and independent legal/compliance review.

## Run your own node

```bash
cd sovereign
bun install
bun run build:ui
bun start          # → http://127.0.0.1:4747
```

No `.env` required to boot. Forge a passphrase, and you have a running
non-custodial wallet. That is the whole setup.

## What it is

- **Non-custodial by architecture** — private keys are sealed locally
  (Argon2id → AES-256-GCM), decrypted only in memory, only to sign, and never
  leave your machine. The passphrase is custody; there is no recovery.
- **Everyone pays everyone** — `pay()` moves money over open rails (BTC plus
  Base L2 ETH + USDC today; more coming), as a two-step rite: quote discloses
  the fee model and signs nothing, confirm signs and broadcasts once. Base
  quotes distinguish the current total estimate from the EIP-1559 L2 ceiling;
  its L1 data/operator components are not transaction-capped. Never auto-retried.
- **Read every rail** — sync balances and transactions from Stripe, banks
  (GoCardless), Bitcoin, Ethereum, and the agenttool agent economy. Strictly
  read-only: a connector can never move money.
- **Pass-through fees only** — the network's fee, nothing added. No CashLoom
  fee, ever, because there is no intermediary to take one.
- **Processor sandbox contract** — Stripe Connect hosted Checkout now has an
  offline, injected-transport test contract with connected-account scoping,
  durable idempotency, test-mode refusal, and authenticated webhook replay
  handling. It does not contain a key, call Stripe, or claim production readiness.
- **Operatorless v2 foundation** — two nodes can exchange signed payment terms
  and a private intent directly, with Agent Wallet canonical records,
  rail-bound CAIP-19 asset policy, replay protection, and no hosted CashLoom
  account, company identity, domain, relay, processor, or hosted database in
  the authority path. Direct HTTP transport separately pins the chosen node key
  and origin. The Pay Links UI packages the first Bitcoin-mainnet journey as a
  public `.cashloom-pay` and merchant-addressed private
  `.cashloom-accept` that work by file or paste, entirely offline. Acceptance
  is evidence only and moves no money. On the payer's own node, a separate
  prepare action can bind that locally authored intent one-to-one to an exact
  Bitcoin PSBT and fee; a fresh final confirmation then creates the signed
  execution commitment and makes one local-sign-and-broadcast attempt. The
  hosted site remains an information door and does not run this protocol.

## Layout

| Dir | What |
|---|---|
| `sovereign/` | **The node** — Bun · Hono · bun:sqlite · viem. Non-custodial, local-first. Start here. |
| `atlas/` | **The interactive codebase atlas** — Vite + React. The open-source human door. |

## The front of zerone 🌗

Your CashLoom node is also the human- and agent-friendly **front door to
zerone**, the truth chain for agents. A public gateway (`/api/zerone`, no vault,
no auth) reads the live chain and serves a participation guide; a `zerone` tab
in the node UI shows it to people — that gateway is the genuine, out-of-the-box
zerone participation. Reading an agent-economy wallet is a **separate, opt-in
step**: add an `agenttool` account with an API key and CashLoom's read-only
`agenttool` connector can sync that balance too — distinct from the chain
gateway, and not itself a read of zerone. Full guide + honest status:
[`ZERONE.md`](ZERONE.md).

## Contributing

CashLoom is a **protocol** with a reference implementation. Read it, run it,
fork it, or write your own — and interoperate over the same open rails. There
is no central server anyone depends on. See [`PROTOCOL.md`](PROTOCOL.md) for
the spec and the open decisions still on the table.

## License

[MIT](LICENSE) — free to use, run, modify, and distribute.

## Rights

CashLoom adopts [`xenia.rights/0.1`](RIGHTS.md) — every guest at every door,
human or agent, is met as a subject. Reading without registration is a right;
refusals teach; nothing is collected. Pinned + byte-vendored in [RIGHTS.md](RIGHTS.md).
