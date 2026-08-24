# CashLoom — Sovereign Node

> Non-custodial. Local-first. Everyone pays everyone.
> Your keys, your data, your machine.

A sovereign money manager that runs entirely on **one machine** with **zero
external services** — no database server, no cloud, no accounts, no telemetry,
no fees taken by anyone. It is the reference implementation of the
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
| `CASHLOOM_BIND` | Loopback bind address (default `127.0.0.1`; only `localhost`, `127.0.0.1`, or `::1` are accepted). Wallet Kernel v2 refuses remote custody exposure. |
| `CASHLOOM_ALLOWED_HOSTS` | Optional extra Host aliases for a loopback-only development setup. This is a DNS-rebinding control, not remote authentication. |
| `CASHLOOM_ALLOWED_ORIGINS` | Optional extra browser origins for a loopback-only development setup. This is not an access-control or TLS boundary. |
| `CASHLOOM_DATA_DIR` | Where the SQLite file + keys live (default `~/.cashloom`). |
| `CASHLOOM_BASE_RPC_URL` | Primary Base RPC for quotes, sending, and evidence (default public `mainnet.base.org`). API-bearing URLs are accepted but never returned in receipts/errors. |
| `CASHLOOM_BASE_CONFIRMATION_RPC_URL` | Independent Base evidence provider (default public `base-rpc.publicnode.com`). Must be a distinct endpoint; two-provider finalized agreement is required to settle. |
| `CASHLOOM_BASE_RECONCILIATION_ENABLED` | Set to exactly `1` to start the bounded background checker for already-signed Base transactions. Off by default; it can observe/settle but cannot sign, submit, recover, or rebroadcast. |
| `STRIPE_* / GOCARDLESS_* / ALCHEMY_* / AGENTTOOL_*` | Read-only connector keys, **only** if you connect those rails. Each is an env-var **pointer** named on an account; the value is never stored in the DB. |

## What works today

- **Wallet Kernel v2** — CAIP-qualified accounts/assets, canonical intents,
  exact resource reservations, scoped human/agent authorization, one-time
  signing, crash-safe exact-byte recovery, reconciliation, and balanced journal
  evidence. See [`WALLET-KERNEL-V2.md`](../WALLET-KERNEL-V2.md).
- **Vault** — passphrase custody; generate/import EVM and Bitcoin keys;
  Argon2id + AES-256-GCM sealing; scoped, expiring sessions; no raw-key signing
  callback.
- **Pay** — Base L2 **ETH + USDC** and Bitcoin mainnet **P2WPKH**, as a
  two-step rite: `quote` (fee disclosed, nothing signed) → `confirm` (signed +
  broadcast once). Unknown broadcast outcomes are reconciled or explicitly
  rebroadcast from the same durable bytes, **never re-quoted or auto-retried**.
- **Base truth** — explicit checks begin from the durable signed transaction,
  require two-provider `finalized` consensus, verify native USDC effects, and
  post exact L2 + L1 data/security + operator fees. Missing evidence remains
  unknown and never releases the nonce.
- **Finalized Base positions** — an explicit account refresh observes ETH and
  native Circle USDC at one corroborated finalized block. Normal page/API reads
  stay local to SQLite; outages never become zero balances, older snapshots
  cannot regress the head, and same-height contradictions freeze the view.
  Sanitized refresh attempts survive reloads, and duplicate local records for
  one CAIP-10 identity are marked so agents do not sum the same wallet twice.
- **Bounded reconciliation scheduler** — optional durable leases, concurrency
  limits, deadlines, and backoff check only exact signed-artifact/transaction
  joins. It is disabled unless the owner sets the opt-in variable above.
- **Agent-local discovery** — `GET /api/wallet/v3` lists the private wallet
  resources/actions, methods, required scopes, refusal codes, and read-only
  network effects. The stable flat `/api/wallet/v2/positions` contract remains
  available while richer finalized evidence lives at `/api/wallet/v3/positions`.
- **Read rails** — sync balances + transactions from Stripe, GoCardless,
  Bitcoin (Esplora), Ethereum (Alchemy), and the agenttool agent economy.
  Strictly read-only: nothing behind a connector can move money.
- **Ledger + analytics** — every movement in one place, BigInt-exact
  minor units, per-account in/out and net position.

## Connectivity foundation (honest release state)

- **External wallets** — strict WebAuthn, hardware EVM, WalletConnect v2, and
  ERC-4337 v0.7 request/verification adapters plus an additive durable ledger
  are implemented. They remain execution-disabled until an owner coordinator
  can atomically persist verified output through the core artifact boundary.
- **Open banking** — GoCardless Bank Account Data is AIS/read-only. A bounded
  Yapily one-off domestic GBP preparation/submission/status foundation exists,
  but live payment initiation remains provider/legal-policy blocked and agents
  cannot complete owner consent journeys.
- **Connections view** — the local, networkless page and
  `GET /api/wallet/v3/integrations` distinguish built adapters, configuration,
  and live execution without exposing secrets or starting a provider request.

Architecture, standards, activation gates, and exact implementation files are
documented in [`../WALLET-CONNECTIVITY.md`](../WALLET-CONNECTIVITY.md).

## What's next (honest roadmap)

- **Owner coordinators** for external signing and provider consent, plus
  broader finalized position adapters beyond Base ETH/native USDC.
- **Lightning**, **more rails** (SEPA, UPI, SOL), **payment pointers**
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
