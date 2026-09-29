# TCG Trades — records and an escrow rehearsal

Cashloom's private wallet is growing a trade workspace for collectors who agree
sales anywhere: a show, a group chat, a marketplace, or directly with each other.
The first workflow is a shipped card or bundle sale, not a new marketplace.

**This is not an escrow service. No funds are held or protected by Trades.**
It does not yet authenticate two independent remote parties, verify cards, or
operate a payment/refund provider. It is not part of the public Cashloom World.

## Two deliberately different things

| Workspace | What it does | What it does not establish |
|---|---|---|
| **Trade record** | Stores versioned terms and owner-reported evidence | Independent acceptance, ownership, payment, delivery, or protection |
| **Escrow simulation** | Rehearses funding, inspection, disputes, returns, release and refund using fictional amounts | Custody, an executed payment, legal escrow, or actual adjudication |

The record label is **“Record only — no escrow protection.”** The sandbox label is
**“Simulation — no funds held or protected.”** Playing a buyer, seller, or
adjudicator in the simulator does not create another authenticated person.

## Use it locally

Use the [advanced local wallet](sovereign/README.md), not the World/INFO entrypoint.
Open **Trades** after initializing/unlocking a local owner session. No signing key,
funded wallet, provider account, or network lookup is needed for Trades itself.
Other wallet screens retain their existing real-money capabilities; the sandbox
is not a safety switch for the rest of the wallet.

1. Create a trade with buyer/seller labels and the channel where it originated.
2. Describe the card or bundle: game, printing, language, variant, quantity,
   condition, and any grading claims. Unknown metadata can remain unknown.
3. Specify exact consideration in one asset, shipping/charges, inspection and
   dispute/return terms. Cashloom's fee remains zero. The planned payment method
   is separate from the amount's denomination.
4. Save the agreement. Editing its terms creates a new immutable revision.
   Evidence and acceptance claims remain bound to the revision they concerned;
   they do not silently approve revised terms.
5. Record evidence as plain text and optional source links. Links are not fetched
   or embedded. Recording a cash payment or transaction reference does not verify
   it or turn it into protected funding.
6. Choose **Try escrow simulation** to copy one revision into a separate run.
   Simulate both acceptances, funding, dispatch, delivery, inspection and release;
   or rehearse a condition dispute, authorized return and full refund.

Runs survive reload/restart. A run continues to use its copied terms when the
source trade changes; it does not approve the new revision. Lists and history
have explicit **Load more** pagination rather than silently hiding older records.
Pending or unknown simulated outcomes must be resolved using the same operation,
not another release/refund. Dispatch, elapsed time and tracking references never trigger
release automatically. An open dispute blocks ordinary release.

An uncertain HTTP response retains its exact retry only while that Trades view
remains mounted. Leaving the view or locking clears this private in-memory retry;
check saved records/runs before attempting a new command. Persisted simulation
operations can still be reopened and reconciled. There is no browser-storage
recovery of an unsaved form.

## What “understanding the card” means here

- **Printing is not a physical copy.** A catalog/SKU identifies a printing; local
  item IDs distinguish represented copies/lots without proving possession.
- **Condition and grading are claims.** A grade or certificate number is not
  authentication. A homogeneous lot should not hide materially different cards.
- **Game metadata is not legality certification.** Manual game/set/variant and
  other metadata support the agreement, not a current tournament rules engine.
- **Reference prices are observations, not money.** Sources, observation times
  and rights/unknown status remain attached. References do not change agreed
  totals, wallet balances, collateral eligibility or guaranteed sale proceeds.
- **Amounts are exact.** One qualified fiat/crypto asset per agreement, integer
  atomic strings and BigInt arithmetic. Only identifiers and matching scales in
  the existing local asset registry are accepted; this is not global currency
  coverage. No implicit FX, mixed-asset total or conversion from a floating-point
  card valuation.

There is no automated catalog/pricing ingestion in this increment. Source-qualified
IDs remain opaque; no duplicate SKU parser or absolute sibling-project import.
The form edits catalog references, game metadata and grading claims. Optional
reference valuations are supported by the record API and displayed with their
provenance, but there is no valuation-entry form; editing terms preserves them.

## Storage, authority and privacy

Real owner records live in additive `tcg_*` tables in `sovereign.db`. The sandbox
uses a separate, lazily created `tcg-sandbox.db` under `CASHLOOM_DATA_DIR` (default
`~/.cashloom`). Reading an unused sandbox does not create that file. Sandbox state
never posts to wallet accounts, journals, payments or real trade evidence.

The separation is enforced by code, types and distinct database connections; it
is not OS-process isolation. Both are local SQLite data, **not wholly encrypted
by the wallet passphrase**. Key encryption does not encrypt trade history. Device
access, backups and evidence privacy still matter; avoid unnecessary personal
information and do not put secrets into evidence. There are no new uploads,
remote images, or persistent browser copies of trade data.

Private routes are under `/api/tcg/trades` and `/api/tcg/simulations`, with
`trades:read`, `trades:write`, and `trades:simulate` scopes. They additionally require
a local owner principal. Existing delegated-agent permissions are not expanded.
Locking or session expiry removes access. Responses are private/no-store; these
routes are not published by World/INFO or public discovery.

Mutations use bounded idempotency keys and expected versions. Identical replay
returns the recorded response; conflicting reuse/stale writes are refused.
Append-only history is an application record, not a tamper-proof external witness.
Hashes bind agreement bytes, not truth, freshness, identity or consent.

## Existing foundations and limits

The wallet already contains Base ETH/USDC and Bitcoin transfer implementations,
scoped authorization, exact accounting and durable receipts. Those capabilities
are not escrow: a local reservation is not conditional custody, and a transfer
receipt does not prove an agreed card arrived in the promised condition.

TCG domain research used Cambridge TCG source at `a99cc3b4` (September 10, 2026),
not its stale June checkout. That reference contains SKU knowledge, stored trade
terms, durable GBP Stripe checkout attempts, swaps without escrow, testnet address
linking and limited static OPTCG rules. This is source evidence, not verification
of its deployment, migrations or providers. Its inspected dispute/return refund
paths recorded outcomes without executing processor refunds; its crypto escrow
“contract” was TypeScript state logic, not deployed conditional custody.

The private `@cambridge-tcg/sku` package is a future pinned-reuse candidate. Its
Apache-2.0 code licence and notice obligations do not grant rights to upstream
card images, price histories or other data. No such package/data is copied here.

## Local verification

From the repository root:

```sh
python3 sovereign/tests/tcg-browser/run.py
```

This offline harness requires macOS arm64, `sandbox-exec`, installed Python/Bun/Node,
the exact platform-applicable `sovereign/ui/bun.lock` packages in the local Bun
cache, and cached Playwright Core 1.59.1 with its matching Chromium headless shell
(revision 1217). Missing prerequisites fail explicitly; nothing is installed or
downloaded. `--keep-temp` retains its diagnostic fixture; the default stops test
processes and removes only its own temporary fixture.

It runs all wallet UI tests, TypeScript checking, a Vite build, and browser journeys
against the actual private UI and TCG routes/stores. Authentication and wallet data
are synthetic. The harness uses a cleared environment and disposable HOME/data,
disables automatic Bun `.env` loading, and restricts networking to loopback; the
browser additionally accepts only its fixture origin. The separate
`sovereign/src/index.test.ts` suite checks actual vault/session/scope integration.
Never point these checks at an existing wallet or a production endpoint.

Initial verification on September 14, 2026:

| Check | Result |
|---|---|
| TCG domain, persistence and routes | 55 passed |
| Mounted private API, including real-process sandbox reopen | 18 passed |
| Existing wallet/agent-pay and vault tests | 192 and 13 passed |
| Complete wallet UI suite | 65 passed |
| Backend/UI TypeScript and exact-lock UI build | Passed |
| Actual browser journeys | 13 checkpoints passed; desktop/mobile screenshots inspected |
| Additional independent backend review tests | 14 passed |
| Broader domain/INFO/connector/util regression | 945 passed, 1 failed, 1 skipped |

Browser checks include both full settlement journeys, duplicate-response recovery,
unknown-operation reconciliation across server restart, discovery of 101 saved
records, lock-time clearing, separate sandbox storage, and unchanged contents of
all 35 wallet fixture tables. These checks do not certify live providers or escrow.

The broader regression is **not green**: unchanged `sovereign/src/info/fx.test.ts`
uses an August 20 reference date now rejected by the FX freshness gate. That
unrelated fixture failure remains unresolved; the skipped test is not a pass.

## Before any real protection

A separate reviewed implementation must establish:

- Independent-party identity/authentication and consent to the exact terms.
- Actual custody/conditional release with an eligible rail, jurisdiction,
  contracting entity, provider terms and legal review.
- Executed and reconciled release/refund operations, including ambiguity,
  reversals, failures, segregation and liability.
- Accountable physical-card dispute adjudication, returns, complaints and support.
- Recovery/device loss, privacy, sustainable fees and exit/continuity arrangements.

[Stripe delayed payouts](https://docs.stripe.com/connect/manual-payouts) are not
escrow services. [Escrow.com's API](https://www.escrow.com/api/docs) is a discovery
candidate, not an approved partner or verified TCG eligibility. A partner's licence
is not blanket authorization for Cashloom. A hosted Revolut-like service would
also require an explicit change to today's self-run/pass-through-only model.

Not included: live transfers/custody, provider sandboxes, credit/cards/FX, remote
onboarding, marketplace/chat, protected swaps/show-floor payments, partial refunds,
split rails/payouts, file uploads, proposal import/export or public deployment.
