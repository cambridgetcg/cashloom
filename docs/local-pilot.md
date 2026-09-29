# Using CashLoom locally

This guide applies to the published `release/service-workspace-20260929` source,
including the local workspace, Capital flows, and TCG features. The workspace is
a developer pilot requiring access to the **private CashLoom repository**; it is
not a hosted workspace sign-in. Start with a small manual account and recorded
activity. Public sources and connected-account refreshes can use external
providers; the manual steps below do not require them.

Release status on 29 September 2026: the source branch is pushed and the
Cloudflare preview passed 19 checks with zero failures. Its sole capability gap
is the hosted Capital flows API (404). Production deployment is pending; these
preview results do not activate bank access or private payments.

## Install, build, and start

With Git and Bun installed, authenticate Git using a GitHub account that has
repository access, then clone the current release:

```sh
git clone --branch release/service-workspace-20260929 https://github.com/cambridgetcg/cashloom.git cashloom
cd cashloom
```

[Source and setup guide](https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929/sovereign#run-it)
also requires repository access. Without it, GitHub may show “Page not found.”
Public information remains available at [Money insights](https://cashloom.io/world)
without repository access. The public planner belongs to the separately released
website; it does not open or connect to your private node.

From that checkout root:

```sh
cd sovereign
bun install --frozen-lockfile
(cd ui && bun install --frozen-lockfile)
bun run build:ui
CASHLOOM_DATA_DIR="$HOME/.cashloom-pilot" bun start
```

Choose an unused pilot directory to keep the exercise separate from an existing
wallet. The node binds to loopback and prints its address. A second node using
the same port will fail; stop the first with Ctrl+C before restarting. Startup
does not install dependencies, build assets, sync accounts, or enable the
optional Base reconciliation scheduler. The wallet UI is resolved relative to
its source, so launching the entrypoint from another directory serves the same
build.

Create a passphrase in the local UI. Keep it separately: a database backup does
not reset or recover a forgotten passphrase. New data directories and database
files are created with owner-only permissions. Existing user-selected parent
directory permissions are not changed. Wallet records are not wholly encrypted;
the vault seals key material, while account and trade records remain local data.

## A daily loop

1. In **Overview**, choose **Add an account**. Create a manual cash account in
   your currency.
2. In **Accounts**, choose **Record balance** and enter an observed amount.
   Overview shows the amount and when it was recorded.
3. Open that account's **Activity** and record an expense or receipt. This records
   activity separately from the observed balance; it does not transfer money.
4. Reopen the app later. Check the saved timestamps, record a new balance when
   appropriate, and use **Reload saved history** for a fresh local read.
5. If useful, record a card agreement in **Agreements**. Its separate escrow
   simulation is a rehearsal with no real funds or protection.

Activity retains archived account names, currencies, and precision. Archived
accounts remain available in its history filter but cannot receive new manual
entries. If account metadata cannot be read, amounts show exact atomic units
with an explicit missing-metadata label instead of a guessed currency scale.

Account refresh and payment actions remain explicit. Saved balances are dated
observations, not a promise of current provider or chain state. Different
assets and networks retain their own units.

**Connections** now brings these sources into one view with freshness and data
permissions. Its US-bank connection uses **Plaid sandbox test accounts only**;
see [setup and limits](../sovereign/README.md#unified-money-view-local-pilot).
**Activity** can preview a CSV into a manual account, export saved records as
JSON, and review matching transfers between accounts you own. These actions
organise records and do not move money. Connected accounts cannot receive CSV
imports until cross-source duplicate review is implemented.

## Returning, locking, and interrupted connections

The wallet checks its session when opening or returning to the tab and schedules
local expiry from the server's remaining session time. While a return check is
pending or the node cannot answer, private content is hidden; an existing draft
remains in memory so a successful retry can restore it. Confirmed expiry or an
invalid session removes private views and their drafts. A fresh reload does not
recover unsaved form drafts.

The check does not renew a session or call external providers. It detects another
tab's lock on the next return/check, not instantaneously across every tab.
Browsers can suspend timers; returning to the tab checks again. **Lock** drops
this tab's session immediately and requests a node-wide vault lock. If the node
cannot confirm that request, local removal alone does not prove every server
session was revoked.

## Back up, verify, and restore separately

From `sovereign/`, stop the node with Ctrl+C and run:

```sh
bun run data backup --source "$HOME/.cashloom-pilot" --target "$HOME/cashloom-pilot-backup"
bun run data verify --source "$HOME/cashloom-pilot-backup"
bun run data restore --source "$HOME/cashloom-pilot-backup" --target "$HOME/.cashloom-pilot-restored"
```

Both output directories must be new, including for repeated backups. The CLI
requires explicit paths and never chooses an existing wallet implicitly. It
captures committed SQLite WAL contents, includes the optional `tcg-sandbox.db`
when present, and records lengths, hashes, capture times, and schema receipts.
Outputs have owner-only directory/file permissions. Verification checks hashes,
SQLite integrity, and compatibility with this checkout; it does not prove backup
authorship or current financial truth.

Each database snapshot is consistent independently. They are captured at separate
instants; stopping the node avoids a trade changing between those snapshots.
The tool does not stop or lock a running node for you. Copying only
`sovereign.db` while it is open can omit committed WAL data.
Opening a snapshot source can create SQLite coordination files or checkpoint its
journal. The tool does not edit records or run migrations.

Restore creates a separate directory and never overwrites, migrates, unlocks, or
starts a wallet. After inspecting the result, this starts the restored pilot:

```sh
CASHLOOM_DATA_DIR="$HOME/.cashloom-pilot-restored" bun start
```

The original passphrase is still required. Keep one chosen wallet instance
active: old backups can contain old signing state and unresolved transactions.
Restoration does not justify repeating a payment. Review saved payment evidence
and current chain truth before further financial actions.

Backup files include private records, sealed keys, and durable signed artifacts;
the whole backup is not encrypted. Store it privately. No credential environment
files or unrelated data-directory files are copied. Keep any provider setup
separately. On failure, a partial new output directory is retained for inspection;
missing `manifest.json` means incomplete output. Existing source data is not
overwritten.

## Rehearse without a real wallet

On the verified macOS arm64 development environment, from the checkout root:

```sh
python3 sovereign/tests/tcg-browser/run.py --keep-temp
```

This uses cached locked dependencies, a temporary HOME and dataset, a copied
node source tree, and a browser restricted to loopback. It exercises the built
UI against both the existing TCG fixture and the actual local node. The daily
journey initializes a synthetic vault, records a balance and Ledger entry,
checks session return behavior and archived precision, restarts the node,
backs up both databases, restores separately, and unlocks the restored copy.
It does not use the operator's wallet or send real payments. `--keep-temp`
retains synthetic diagnostics; omitting it removes the runner's own temporary
directory after checks finish.
