# CashLoom — Sovereign Node

> Non-custodial. Local-first. Everyone pays everyone.
> Your keys, your data, your machine.

A sovereign money manager that runs entirely on **one machine** with **zero
CashLoom-operated infrastructure** — no database server, no CashLoom account,
and no telemetry. Optional rail APIs and public blockchain nodes are contacted
only for the connectors and payments you choose. It is the reference implementation of the
[CashLoom Protocol](../PROTOCOL.md): read every rail (crypto + fiat), pay over
open rails, hold nothing, collect nothing.

## What it is (and isn't)

- **One Bun process.** API + UI served from the same origin, bound to
  `127.0.0.1`. This is your node, not a server.
- **One file for all data.** `bun:sqlite` (ships inside Bun) → `~/.cashloom/sovereign.db`.
  Nothing to install, start, or host.
- **Local encrypted key custody.** Argon2id(passphrase) → AES-256-GCM. Private
  keys are sealed at rest, decrypted only in memory, only to sign, and
  **never leave the machine** — CashLoom signs locally and broadcasts the
  *signed* transaction through a public node.
- **No SaaS.** No plans, no quotas, no pricing, no upgrade nags. There is one
  mode: yours.

## Run it

```bash
cd sovereign
bun install
bun run build:ui   # builds the frontend into ui/dist
bun start          # → http://127.0.0.1:4747
```

That is the whole setup. No `.env` is required to boot. Open the URL, forge a
passphrase, and you have a running non-custodial wallet + money tracker.

### Optional environment (all off by default)

| Var | Purpose |
|---|---|
| `CASHLOOM_PORT` | HTTP port (default `4747`). |
| `CASHLOOM_BIND` | Bind address (default `127.0.0.1` — change only if you know why). |
| `CASHLOOM_DATA_DIR` | Where the SQLite file + keys live (default `~/.cashloom`). |
| `CASHLOOM_BASE_RPC_URL` | Base L2 RPC for sending (default public `mainnet.base.org`). A URL, not a credential. |
| `CASHLOOM_AGENT_TRUSTED_SIMULATION_KEY_IDS` | Comma-separated Agent Wallet simulation-adapter key IDs trusted by this local node. Empty means agent authorization fails closed. |
| `STRIPE_* / GOCARDLESS_* / ALCHEMY_* / AGENTTOOL_*` | Read-only connector keys, **only** if you connect those rails. Each is an env-var **pointer** named on an account; the value is never stored in the DB. |

## What works today (first protocol slice)

- **Vault** — passphrase custody, generate/import EVM keys, lock/unlock.
- **Pay** — `pay()` over **BTC mainnet** and Base L2 **ETH + USDC**, as a two-step rite —
  `quote` (fee disclosed, nothing signed) → `confirm` (signed + broadcast,
  once). The signed transaction ID is persisted before network submission;
  uncertain submissions remain sticky and are **never auto-retried**.
- **Agent Wallet authorization evidence** — signed AgentTool records, local
  simulation-adapter trust, durable spend/replay reservation, and a
  vault-signed `authorized-not-bound` attestation. It cannot execute a payment
  until a chain adapter binds the exact intent bytes to a CashLoom quote.
- **Read rails** — sync balances + transactions from Stripe, GoCardless,
  Bitcoin (Esplora), Ethereum (Alchemy), and the agenttool agent economy.
  Strictly read-only: nothing behind a connector can move money.
- **Ledger + analytics** — every movement in one place, BigInt-exact
  minor units, per-account in/out and net position.

## What's next (honest roadmap)

- **Agent intent execution binding** — exact chain-byte/quote binding and
  durable EVM nonce coordination.
- **Lightning**, **fiat sending through licensed processors**, **more rails**
  (SEPA, UPI, SOL), **payment pointers**
  (`you@cashloom`), **CSV/receipt import** without any cloud AI.
- **Tauri desktop packaging** — double-click to run, zero terminal.

## Design doctrine (why the code is shaped this way)

- Amounts are **integer minor-unit strings**, never floats — an 18-decimal
  wei amount cannot survive a `parseFloat`.
- **Read and write are separate seams.** `RailConnector` (read) can never
  move money; `PaymentSender` (write) carries all outbound movement under
  stricter rules. A connector that could send does not belong behind the
  read interface.
- **Errors carry instructions, never secrets.** Key material never reaches a
  log, an error message, or the network.

*Non-custodial, local-first, no-info, pass-through fees, open. Everyone pays
everyone.*
