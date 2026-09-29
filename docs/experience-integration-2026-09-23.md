# CashLoom connected experience and local pilot

Locally implemented and verified on 2026-09-23 in
`feature/capital-flows-20260909`, over HEAD
`e421a1ac4a3e397d0afb8ae65efe2cb5580a515c`. This work builds on the existing
uncommitted Capital flows and TCG implementation. Nothing was committed,
published, or deployed. The [earlier survey](current-map-2026-09-23.md) records
the starting state.

## Connected journeys

| Journey | Result | Boundary |
|---|---|---|
| World ↔ Capital flows ↔ Onchain ↔ Atlas ↔ Your wallet | Shared public navigation; `/wallet` introduces the local wallet and setup. | Public pages never probe or attach to a private node. |
| Keys → Accounts | A supported address key prepares account creation with the matching identity. | The person still reviews and saves; record-signing secrets have no payment-address actions. |
| Overview → Accounts / Ledger | Saved balances link to their account and activity. | Missing observations remain unknown; unlike assets are not summed. |
| Accounts → Pay / Receive / Ledger | Selection carries into the next view; Back/Forward restores it during the unlocked session. | URLs contain view names only. Account/key context stays in bounded memory, is absent after reload, and clears on lock/session loss. |
| Accounts → Record balance → Overview | Manual accounts can save an exact observed balance and server timestamp. | Restricted to active manual non-crypto accounts; no payment or Ledger mutation. |
| Ledger → Record | The selected account, exact amount, and selected local calendar date reach the API correctly. | Activity records and observed balances remain independent. |
| Pay → Review recovery | Eligible signed Base ETH/USDC records expose explicit rebroadcast of their durable transaction. | Review and confirmation required; no new signing, automatic retry, or recovery action for ambiguous executions. |
| Trades ↔ Ledger / Accounts | Agreements and simulated settlement sit alongside account activity. | Records do not prove payment; the rehearsal holds no real funds or protection. |
| Connections → Accounts / Keys | Existing local actions are reachable from integration readiness. | External-wallet execution and bank-payment activation gates remain closed. |

The private wallet also links out to public World with no referrer or private
identifiers. All nine wallet destinations remain visible at desktop and narrow
mobile widths. Native form labels now identify their controls without including
unrelated hints or sibling actions.

## Daily use and recovery

The follow-up production inspection focused on returning safely to saved work.
The [local pilot guide](local-pilot.md) now gives one path through installation,
a separate manual-account dataset, daily use, and recovery.

- Ledger loads archived account metadata explicitly, retains currency precision,
  and exposes read retries without discarding drafts or matching saved rows.
  Unknown metadata shows raw atomic units. The API atomically refuses manual
  entries for archived accounts.
- A read-only session endpoint supplies server time and expiry. Opening or
  returning to the tab checks access without renewing it. Bounded return checks
  hide private views while retaining draft state; confirmed expiry or invalid
  sessions unmount them. Local timer scheduling also handles observed expiry.
  Private API responses use `private, no-store`.
- Startup resolves the wallet UI independently of cwd and gives a clear error
  when it has not been built. Installation uses frozen lockfiles; builds do not
  install dependencies. Main database files use owner-only permissions.
- One explicit-path data CLI backs up, verifies, and restores into a new
  directory. It includes committed WAL data and the optional TCG sandbox;
  hashes, integrity checks, compatible schemas, private output permissions, and
  exclusive targets guard the recovery path. It never starts a restored node.

Snapshots are consistent per database, not atomic across both databases. SQLite
may create source coordination files or checkpoint its journal while capturing
a snapshot; the tool does not edit application records or migrate schemas.
Verification and restore leave the backup unchanged. Neither hashes nor a
restored signing record establish current financial truth. A backup still needs
the vault passphrase and is not wholly encrypted.

Session checks detect another tab's lock on return/check, not instantly in every
tab. Browser suspension can delay timers. An unavailable node leaves session
status unknown; the UI distinguishes local session removal from a confirmed
node-wide vault lock.

## Balance and payment integrity

Overview reads accounts independently of optional payment history and saved
positions. For Base ETH/native USDC, it uses finalized position evidence, groups
aliases of the same chain address, and selects the newest saved finalized block.
Conflicting, missing, invalid, and retained observations remain explicit. Other
account balances require a saved observation timestamp; an unsynced default zero
is not presented as an observed zero.

`POST /api/accounts/:id/balance` requires `accounts:write`, an active eligible
account, exact integer minor units, and the previously observed value/timestamp.
An immediate SQLite transaction compares both before saving. A concurrent change
returns a conflict so the owner can reload and review; server timestamps advance
monotonically. The endpoint does not use connectors, signers, or the Ledger.

The recovery UI checks that the saved Base transaction hashes agree and that the
server permits recovery. Immediately before submission it rereads the local
payment and compares the full reviewed identity. It sends one recovery request
and reloads saved truth even if the response is lost. Recovery and reconciliation
share a busy guard. The existing backend does not accept ambiguous executions
for recovery, so those remain on the reconciliation path.

## Agent access

The stdio [MONEYWORLD MCP adapter](../sovereign/src/mcp/moneyworld.ts) has 18
read-only tools. New tools expose the existing public World, Onchain, and Capital
flows snapshots with their versioned media types and original response bodies.
Descriptions explain exact units, receipts, partial responses, and coverage
limits. World/Onchain allow the server's cold snapshot budget; Capital flows
performs one bounded read without polling. This adapter neither opens the wallet
vault nor grants payment authority.

## Verification

Final suite results: **1,595 passed, 0 failed, 1 skipped**.

| Suite | Passed | Skipped |
|---|---:|---:|
| Atlas frontend | 165 | 0 |
| INFO, connectors, utilities, MCP | 942 | 1 |
| Wallet node | 83 | 0 |
| Private API | 31 | 0 |
| TCG backend | 55 | 0 |
| Wallet Kernel | 181 | 0 |
| Agent payment authorization | 11 | 0 |
| Private wallet UI | 114 | 0 |
| Local backup and recovery | 13 | 0 |

Atlas, the private UI, and the backend pass TypeScript checks; both frontends
build. Covenant draft validation passes; that check does not activate adoption.
The initial date-dependent FX test was made deterministic, with an additional
regression confirming genuinely stale production observations remain refused.

The [offline browser runner](../sovereign/tests/tcg-browser/run.py) passes **20
fixture checkpoints**: key/account handoff, manual observations, Ledger submission,
payment/receive context, Back/Forward and reload behavior, reviewed recovery with
a lost response, and the existing TCG create/revise/retry/restart/reconcile/refund/
pagination/lock journeys. Navigation is checked at 1280, 390, and 320 pixels.
It uses the built UI, synthetic wallet routes, actual TCG routes/storage, and
separate temporary data. The wallet-route fixture does not execute real payments;
the private API suite separately exercises the actual manual-balance endpoint.
The original wallet-table separation assertions remain in place.

A further **8 actual-node checkpoints** exercise fresh vault initialization,
manual balance and Ledger creation with a distinct calendar date, session-return
failure/retry with draft retention, archived ETH precision, cross-tab lock
discovery, process restart, backup/verify/separate restore, and missing-build
startup refusal. This uses a copied source tree and synthetic temporary data.
The restored vault unlocks with the original synthetic passphrase, retains both
database identities, and does not generate signing keys or contact providers.

Backup tests additionally cover cleanly stopped WAL databases, active WAL with
an uncommitted transaction, restored sealed-key unlock, exact large amounts,
tampered/partial/incompatible backups, symlinks, nested/existing targets,
permissions, and bounded CLI output. SQLite connection maintenance is permitted;
application data is preserved. Final source checks cover added, changed, and
removed UI, backend, and harness files.

Public browser checks cover all five routes at 1440, 390, and 320 pixels,
keyboard focus, minimum 44-pixel navigation targets, active links, and route
traversal. Screenshots were inspected for desktop/mobile layout. Browser checks
blocked external requests; no live wallet, credentials, providers, or hosted
deployment were exercised.

To repeat the private UI/browser check on this macOS arm64 environment, from the
repository root:

```sh
python3 sovereign/tests/tcg-browser/run.py --keep-temp
```

It requires the exact locked packages and pinned browser already in the local
cache. It creates isolated temporary build/data directories, disables `.env`
loading, denies non-loopback networking, checks source drift, and stops its
processes. `--keep-temp` retains synthetic diagnostic artifacts. Backend and
Atlas suites were also run with temporary data and environment isolation.

## Remaining activation boundaries

The public and private applications remain separate runtimes. This work connects
their navigation and meaning; it does not turn the public site into hosted
custody. External signing still needs its owner coordinator; bank payment
initiation still needs its provider/consent activation; TCG remains records and
simulation. No real broadcast, connector activation, Docker deployment, or
production verification was performed.
