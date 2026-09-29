# CashLoom — Sovereign Node

> Non-custodial. Local-first. Everyone pays everyone.
> Your keys, your data, your machine.

The local wallet implementation of the [CashLoom Protocol](../PROTOCOL.md).
Its Bun process and SQLite database run on your machine; **no separate database
server is required**. Public data reads, RPC reads/broadcasts, and enabled
connectors still use external providers, subject to their terms and availability.
Local-first does not mean offline or anonymous; the public information surface's
[data-practices disclosure](https://cashloom-api.fly.dev/v1/data-practices) explains
its application scope and external-layer caveats, not a wallet-wide privacy guarantee.

## Choose an entrypoint

- **World — read-only information:** `src/info-server.ts` runs without the wallet
  vault, ledger, or signers. Follow [Run World locally](https://github.com/cambridgetcg/cashloom/tree/release/moneyworld-wallet-kernel-v2-20260823#run-world-locally)
  in the root README for the loopback INFO + World frontend setup.
- **Local wallet — advanced:** `bun start` runs `src/index.ts`, with local custody
  and owner-controlled signing capabilities. The instructions below are for this
  wallet, not the hosted World service; integration activation limits still apply.

## What it is (and isn't)

- **One Bun process.** API + UI served from the same origin, bound to
  `127.0.0.1`. This is your node, not a server.
- **Local SQLite storage.** `bun:sqlite` (ships inside Bun) → `~/.cashloom/sovereign.db`.
  The optional TCG rehearsal uses a separate `tcg-sandbox.db`; no database server.
- **Local encrypted key custody.** Argon2id(passphrase) → AES-256-GCM. Private
  keys are sealed at rest, decrypted only in memory, only to sign, and
  **never leave the machine** — CashLoom signs locally and broadcasts the
  *signed* transaction through a public node.
- **No SaaS.** No plans, no quotas, no pricing, no upgrade nags. There is one
  mode: yours.

## Run it

```bash
cd sovereign
bun install --frozen-lockfile
(cd ui && bun install --frozen-lockfile)
bun run build:ui   # builds the frontend into ui/dist
bun start          # → http://127.0.0.1:4747
```

That is the whole setup. No `.env` is required to boot. Open the URL, forge a
passphrase, and you have a running non-custodial wallet + money tracker.

Dependency installation is explicit; `build:ui` only checks and builds the UI.
The node resolves its UI relative to its source and refuses to start without a
built index page. It does not install packages or build assets during startup.

The private Overview can link to a separately running CashLoom service preview.
Set the optional **build-time** `VITE_CASHLOOM_SERVICE_ORIGIN` when building the UI:

```bash
VITE_CASHLOOM_SERVICE_ORIGIN=http://127.0.0.1:5179 bun run build:ui
```

Use an HTTPS origin or HTTP on `localhost`, `127.0.0.1`, or `[::1]`, with an
optional port and trailing slash. Credentials, paths, query strings and fragments
are rejected. The UI adds `/plan` and opens it without a referrer or wallet data.
The configured origin is public build output, so never put a secret in it.
An unset or invalid value shows preview availability text without a planner link.
This setting neither starts nor checks the service; run the preview separately.
It does not change the existing CashLoom guide link. Rebuild after changing it.

Follow the [local-use and recovery guide](../docs/local-pilot.md) for a separate
pilot dataset, daily account/ledger usage, and WAL-aware backup, verification,
and restore into a new directory. `bun run data --help` describes the explicit
path commands; backups retain private records and still need the vault
passphrase. The CLI never starts or overwrites a wallet.

### Optional environment (all off by default)

| Var | Purpose |
|---|---|
| `CASHLOOM_PORT` | HTTP port (default `4747`). |
| `CASHLOOM_BIND` | Loopback bind address (default `127.0.0.1`; only `localhost`, `127.0.0.1`, or `::1` are accepted). Wallet Kernel v2 refuses remote custody exposure. |
| `CASHLOOM_ALLOWED_HOSTS` | Optional extra Host aliases for a loopback-only development setup. This is a DNS-rebinding control, not remote authentication. |
| `CASHLOOM_ALLOWED_ORIGINS` | Optional extra browser origins for a loopback-only development setup. This is not an access-control or TLS boundary. |
| `CASHLOOM_DATA_DIR` | Where the SQLite files + keys live (default `~/.cashloom`). |
| `CASHLOOM_BASE_RPC_URL` | Primary Base RPC for quotes, sending, and evidence (default public `mainnet.base.org`). API-bearing URLs are accepted but never returned in receipts/errors. |
| `CASHLOOM_BASE_CONFIRMATION_RPC_URL` | Independent Base evidence provider (default public `base-rpc.publicnode.com`). Must be a distinct endpoint; two-provider finalized agreement is required to settle. |
| `CASHLOOM_BASE_RECONCILIATION_ENABLED` | Set to exactly `1` to start the bounded background checker for already-signed Base transactions. Off by default; it can observe/settle but cannot sign, submit, recover, or rebroadcast. |
| `STRIPE_* / GOCARDLESS_* / ALCHEMY_* / AGENTTOOL_*` | Read-only connector keys, **only** if you connect those rails. Each is an env-var **pointer** named on an account; the value is never stored in the DB. |

## Moving through the wallet

In this development checkout, start with **Overview** to inspect saved balances,
their timestamps, and missing evidence. Base ETH/USDC positions use finalized
observations and group duplicate local records for the same chain address.
Different assets and networks retain their own units.

- **Signing keys → Accounts:** choose “Use in an account” to prepare an account with that
  key. Review and save it yourself. Record-signing secrets have no payment-address
  actions.
- **Accounts → Send money / Receive money / Activity:** the selected account follows you, including
  browser Back/Forward within the unlocked session. Reload reopens the view;
  private account/key selection stays in memory and clears on lock.
- **Manual balances:** “Record balance” saves an exact, timestamped observation for
  an active manual non-crypto account. Concurrent edits require reloading and
  reviewing the saved value. It neither sends money nor creates Activity entries.
- **Activity:** record account activity separately from observed balances. Entering
  an expense does not silently recalculate a balance observation. Search saved
  titles and categories across the full history, choose an account, and use
  **Load older** beyond the first 200 entries. Search treats characters literally
  and ignores ASCII letter case. Back restores the applied search and account
  within the unlocked session; reload or lock clears those in-memory choices.
  New entries follow the selected active account; an existing draft keeps its
  destination when the history filter changes. JSON export includes all saved
  entries for the selected account, regardless of search or loaded pages.
- **Payment recovery:** eligible already-signed Base ETH/USDC payments show “Review
  recovery.” Review the saved transaction, recipient, and amount before explicitly
  rebroadcasting its existing bytes. Ambiguous executions use reconciliation;
  this UI does not create a new transaction or automatically retry recovery.
- **Agreements:** trade records and the separate escrow rehearsal link back to account
  activity. A trade record does not establish payment or authorize settlement.
- **Agent access:** share selected saved accounts with a local MCP client for
  a short period, optionally allow category suggestions, then review each change.
  Access can be revoked individually; it also ends on expiry, a successful
  node-wide lock or restart. This does not connect a model or authorise payments.
  Follow the [agent setup and limits](../docs/agent-layer-2026-09-29.md) before
  supplying a credential to a client.

The **World** link opens public information without passing account or key
identifiers. The public `/wallet` page explains local setup and does not probe
the browser's loopback network. See the
[integration report](../docs/experience-integration-2026-09-23.md) for verification
and activation limits.

## Public information for agents

With the public INFO server running, `bun run src/mcp/moneyworld.ts` starts a
separate stdio MCP adapter. `MONEYWORLD_URL` selects the INFO origin; the default
is `http://127.0.0.1:4747`. It exposes 18 read-only tools, including
`moneyworld_get_world`, `moneyworld_get_onchain`, and
`moneyworld_get_capital_flows`. These retain each snapshot's source receipts,
timestamps, units, and partial/unavailable states. They do not access the private
wallet or move money; public INFO reads can contact upstream data providers.

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
- **Unified money view** — shared connection status, balance observations,
  pending/posted/removed history, Stripe gross/fee/net records, reviewed CSV
  import and JSON export, and owner-confirmed internal transfers. Plaid US bank
  consent and sync are implemented for **sandbox test accounts only**.
- **TCG Trades — records and sandbox only** — card-aware, versioned shipped-sale
  agreements and owner-reported evidence, with a separate persistent no-money
  escrow rehearsal. No independent-party consent, funds held, or protection.
  See [`TCG.md`](../TCG.md) for local usage, storage/privacy and live-service gates.
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

## Unified money view (local pilot)

Open **Connections** in an unlocked owner workspace. Existing Stripe and crypto
readers share the same records as manual accounts and bank test accounts. Each
source shows its environment, last observation and data permissions. Refreshes
are explicit; opening the page does not load Plaid or fetch provider data.

To try the bank journey, supply `PLAID_CLIENT_ID` and `PLAID_SANDBOX_SECRET` only
to the private node process through your scoped credential mechanism. Restart
the node, unlock the owner vault, and select **Connect a test bank**. The service
is fixed to `sandbox.plaid.com`; production tokens are rejected. Plaid Link loads
from Plaid only after that action. This requires internet access and sends consent
interaction to Plaid. Initial connection saves supported USD checking, savings
and credit-card accounts; request a sync to retrieve activity. This integration
does not provide live bank access, payment authority or account/routing numbers.

Access tokens are encrypted with the vault and bound to their provider and local
connection ID. Disconnect disables further reads locally before requesting
provider revocation. A failed revocation stays visible and can be retried; it
does not erase saved records. Reconnection currently means disconnecting and
starting a new Link session. An uncertain public-token exchange is not repeated.
Disconnect a bank before archiving its individual accounts, so one archived
account cannot block updates for the remaining accounts in that connection.

In **Activity**, choose an active manual account and preview a CSV with columns
`date,title,amount,currency` and optional `category`. Dates use `YYYY-MM-DD`;
amounts use signed decimals without separators, with positive money in and
negative money out. Import supports at most 2,000 entries / 1 MB and preserves
the account's saved balance. Connected accounts cannot receive CSV imports until
cross-source duplicate review is supported. CSV matches skip by default. Review
an individual match as a separate transaction using a unique reusable reference
(for example, a statement ID and line number), then update the preview before
confirming. Reusing that reference in the same account skips the saved entry;
conflicting date/title/amount reuse is refused. References are case-sensitive.
Export downloads up to 10,000 records as JSON without
raw provider payloads, external account IDs, tokens, or keys; use a local data
backup for larger or complete database recovery.

Transfer suggestions require nearby, equal-opposite posted records in the same
asset and compatible environments. The owner confirms the accounts belong to
them before linking. Linked records remain visible but are excluded from
income/spending totals; undo restores their previous treatment. Known fees and
currency conversions require a later matching model. Provider changes that
invalidate a match undo that link and retain its history.

Tests use isolated databases and synthetic provider responses. Run
`bun run test:connect` for the read model, Plaid lifecycle, imports and API checks.
Actual Plaid sandbox credentials have not been exercised in this implementation.
PayPal/Cash App connections and production bank access remain future work. See
the [US-first integration plan](../docs/unified-money-layer-2026-09-29.md).

Architecture, standards, activation gates, and exact implementation files are
documented in [`../WALLET-CONNECTIVITY.md`](../WALLET-CONNECTIVITY.md).

## What's next (honest roadmap)

- **Owner coordinators** for external signing and provider consent, plus
  broader finalized position adapters beyond Base ETH/native USDC.
- **Lightning**, **more rails** (SEPA, UPI, SOL), **payment pointers**
  (`you@cashloom`), and **receipt import** without any cloud AI.
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
