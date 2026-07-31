# CashLoom — Sovereign Node

> Non-custodial. Local-first. Everyone pays everyone.
> Your keys, your data, your machine.

A sovereign money manager that runs entirely on **one machine** with **zero
CashLoom-operated infrastructure** — no database server, no hosted CashLoom
account, and no telemetry. Local account rows are labels in your own SQLite
file, not a CashLoom identity. Optional rail APIs and public blockchain nodes
are contacted only for the connectors and payments you choose. It is the
reference implementation of the
[CashLoom Protocol](../PROTOCOL.md): read every rail (crypto + fiat), pay over
open rails, hold nothing, collect nothing.

## What it is (and isn't)

- **One Bun process.** API + UI served from the same origin, bound to
  `127.0.0.1`. This is your node, not a server.
- **One file for all data.** `bun:sqlite` (ships inside Bun) →
  `~/.cashloom/sovereign.db`. Startup tightens the data directory to `0700`
  and database sidecars to `0600`. Nothing to install, start, or host.
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
| `CASHLOOM_V2_REMOTE_MAX_RECORDS` | Global cap for distinct remotely admitted v2 records (default `10000`; `0` closes remote ingest). |
| `CASHLOOM_V2_REMOTE_MAX_BYTES` | Global cap for exact remotely admitted v2 bytes (default `67108864`; `0` closes remote ingest). |
| `CASHLOOM_BASE_RPC_URL` | Base L2 RPC for sending (default public `mainnet.base.org`). A URL, not a credential. |
| `CASHLOOM_AGENT_TRUSTED_SIMULATION_KEY_IDS` | Comma-separated Agent Wallet simulation-adapter key IDs trusted by this local node. Empty means agent authorization fails closed. |
| `STRIPE_* / GOCARDLESS_* / ALCHEMY_* / AGENTTOOL_*` | Read-only connector keys, **only** if you connect those rails. Each is an env-var **pointer** named on an account; the value is never stored in the DB. |

## What works today (first protocol slice)

- **Vault** — passphrase custody, generate/import EVM keys, lock/unlock.
- **Pay** — `pay()` over **BTC mainnet** and Base L2 **ETH + USDC**, as a two-step rite —
  `quote` (fee disclosed, nothing signed) → `confirm` (signed + broadcast,
  once). Base quotes separately disclose the current total-fee estimate and
  the EIP-1559 L2 execution ceiling because L1 data/operator fees are not
  transaction-capped. The exact unsigned bytes, signed bytes, SHA-256
  commitments, recovered signer, and transaction ID are atomically persisted
  with nonce state before network submission;
  uncertain submissions remain sticky and are **never auto-retried**. EVM
  nonces are reserved atomically in SQLite across CashLoom processes and
  restarts; only a proven pre-submit failure releases one for reuse.
- **Agent Wallet authorization evidence** — signed AgentTool records, local
  simulation-adapter trust, durable spend/replay/signed-intent-nonce
  reservation, and a vault-signed `authorized-not-bound` attestation. It
  cannot execute a payment until a chain adapter binds the exact intent bytes
  to a CashLoom quote. Base-mainnet EOA execution remains deliberately blocked:
  Agent Wallet `max_fee` cannot currently hard-cap Base's non-EIP-1559 L1
  data/operator fee components.
- **CashLoom v2 signed-record foundation** — a dedicated vault-held,
  self-certifying Ed25519 node key; seven closed Agent Wallet-backed record
  schemas; append-only SQLite storage; nonce, ancestry, disclosure, and
  remote-disk bounds; rail-bound CAIP-19 trust with signed manifest/policy
  provenance; and key+origin-pinned one-hop delivery. A real two-node loopback
  test passes while `cashloom.io` is unavailable. No generic signing endpoint
  exists.
- **Portable Bitcoin Pay Links** — create a public canonical
  `.cashloom-pay`, hand it to another sovereign node by file or paste, inspect
  the exact address/amount/key/expiry offline, and return a private
  `.cashloom-accept`. Acceptance is signed evidence only: it imports no
  execution commitment, broadcasts nothing, and moves no money. First-contact
  keys are pseudonymous rather than verified people or companies; public notes
  and Bitcoin addresses are linkable, while acceptance files are sensitive
  plaintext intended only for the merchant.
- **Stripe Checkout sandbox contract** — a separate inbound connected-seller
  collection lifecycle with exact request compilation, durable provider
  idempotency, injected transport, test-mode-only response binding, and
  HMAC-authenticated/deduplicated Connect webhooks. It has no real transport,
  route, credential, onboarding, payout, refund, or production claim.
- **Read rails** — sync balances + transactions from Stripe, GoCardless,
  Bitcoin (Esplora), Ethereum (Alchemy), and the agenttool agent economy.
  Strictly read-only: nothing behind a connector can move money.
- **Ledger + analytics** — every movement in one place, BigInt-exact
  minor units, per-account in/out and net position.

### CashLoom v2 doors

The sovereign listener still defaults to loopback. Its protocol doors are:

| Door | Access | Meaning |
|---|---|---|
| `GET /.well-known/cashloom/v2` | public | Exact active signed descriptor for this node. |
| `POST /v2/records` | public | Admit one canonical signed record; no listing or signing. |
| `GET /v2/records/:recordId` | public | Retrieve one known content ID only when signed `disclosure` is public. |
| `GET /api/v2/records/:recordId` | vault session | Retrieve one known locally held public or private record. |
| `POST /api/v2/node/activate` | vault session | Create/reuse the node descriptor through a closed workflow. |
| `POST /api/v2/asset-trust-manifests` | vault session | Sign one strict local asset assessment. |
| `POST /api/v2/assets/evaluate` | vault session | Apply an explicit local authority pin and policy. |
| `POST /api/v2/payment-requests` | vault session | Create terms after local asset-policy acceptance. |
| `POST /api/v2/payment-intents` | vault session | Accept exact stored terms with separate payment/fee asset gates. |
| `POST /api/v2/pay-links` | vault session | Create a self-contained public Bitcoin-mainnet `.cashloom-pay`. |
| `POST /api/v2/pay-links/inspect` | vault session | Verify and explain a pasted request or locally addressed acceptance; no external fetch or import. |
| `POST /api/v2/pay-links/accept` | vault session | Sign a private `.cashloom-accept`; no transaction or reservation. |
| `POST /api/v2/pay-links/acceptances/import` | vault session | Verify and append merchant-addressed acceptance evidence; no execution. |

The hosted `info-server.ts` intentionally has none of these doors and imports
no vault or ledger. Publishing a sovereign node requires a separately reviewed
narrow ingress; do not expose the whole listener. See
[`docs/CASHLOOM-V2.md`](../docs/CASHLOOM-V2.md).

## What's next (honest roadmap)

- **Agent intent execution binding** — first resolve total-fee semantics (or
  use a sponsor/paymaster/rail that can enforce the full signed cap), then add
  exact quote binding, sign-time validity checks, and atomic one-to-one
  authorization/payment reservation. Existing `authorized-not-bound` records
  are never upgraded in place.
- **Exact Bitcoin execution binding** — compile a verified Pay Link acceptance
  into an exact quote only after an explicit second confirmation, bind the
  resulting transaction bytes one-to-one, and retain the existing
  submit-once/uncertain-state discipline. Portable acceptance itself remains
  non-executable.
- **v2 execution evidence** — bind an exact rail payload and enforce the
  payer's total fee-asset ceiling before exposing closed
  `ExecutionCommitment`, `SubmissionReceipt`, and `SettlementReceipt`
  workflows. A settlement receipt is explicitly an issuer assertion until a
  rail-specific verifier authenticates its referenced evidence. The record
  primitives exist; the HTTP layer does not fabricate evidence before an
  adapter can prove it.
- **Stripe sandbox transport + endpoint** — add a separately scoped test key
  and webhook secret only when an operator deliberately configures a Stripe
  sandbox; keep Checkout collection separate from outbound `PaymentSender`.
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
