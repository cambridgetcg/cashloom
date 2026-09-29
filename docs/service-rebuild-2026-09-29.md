# CashLoom: a service for sorting your money

Local implementation, 29 September 2026. Builds on the existing Capital flows,
wallet, and TCG work in `feature/capital-flows-20260909`. This is a development
checkout, not a production-release record.

## Purpose

Help people understand what they have, give their money a purpose, keep useful
records, and make deliberate decisions. Start with a useful action before asking
someone to understand accounts, wallets, connectors, or the code architecture.

Keep the **CashLoom** name. Use **“Your money. Your direction.”** as the promise.
Replace internal module names in everyday navigation with the task a person can
accomplish. Retain route and API identifiers to preserve compatibility.

## People and jobs

| Situation | A useful first outcome | Current boundary |
|---|---|---|
| Individual | A monthly plan showing commitments and money remaining | Estimates are entered by the person; no bank connection needed |
| Household | A plan of contributions and shared costs to discuss | One operator on a device; an exported copy is not live collaboration |
| Independent work | Separate expected income, costs, and chosen set-asides | No tax calculation, invoicing, or statutory accounting |
| Small group/project | A reviewable plan of contributions and project costs | No member permissions, joint approvals, automated splitting, or shared custody |

These are useful starting contexts, not a claim to have four separately built
financial products. No role grants access to anyone else's records.

## Service map and naming

| User-facing destination | Existing foundation | Purpose |
|---|---|---|
| Overview, `/` | New service entry | Choose a job or situation and reach a useful action |
| Money plan, `/plan` | New browser module | Calculate monthly income minus commitments, spending, and set-asides; optionally save locally; import/export a plan |
| Your workspace, `/wallet` | Existing local wallet guide | Explain installation, the first manual-account workflow, and private workspace capabilities |
| Connections, `/connections` | Existing connector and integration implementations | Explain capability, setup, and limitations with a next step; never claim live account connection status |
| Money insights, `/world` | World and its original APIs | Understand rates, currencies, policy dates, and source evidence |
| Capital flows, `/capital-flows` | Existing Capital flows implementation | Inspect published, scoped financing and transaction data |
| Network insights, `/onchain` | Existing Onchain implementation | Inspect selected network, stablecoin, pool, and fee observations |
| How it works, `/atlas` | Existing code Atlas | Inspect technical architecture and implementation decisions |

The public header gives primary tasks direct links. Additional research lives in
a labelled disclosure; an active research destination remains visible. Existing
`/blockchain` and trailing-slash behavior remain supported.

Inside the private workspace, keep the internal navigation IDs but group everyday
tasks and setup. Pay becomes **Send money**; Receive becomes **Receive money**;
Ledger becomes **Activity**; Trades becomes **Agreements**; Keys becomes **Signing
keys**. The overview gives a new person concrete account/record/payment steps.
Advanced protocol functionality remains reachable outside the main daily journey.

## Data and integration design

There are three deliberate data locations:

1. **Money plan:** exact decimal input, monthly estimates, no account identifiers,
   no payment commands. Editing works in memory; browser saving is an explicit
   choice. A JSON export is a portable copy, not a backup of private account data.
   Browser saving detects observed changes from other tabs and pauses for review;
   it is not a multi-user collaboration or transactional synchronization system.
2. **Private workspace:** the existing local node, authenticated session, SQLite
   records, vault, review steps, and signing restrictions remain in force. Public
   pages do not probe localhost or attach to it. A link from the private overview
   to the public planner sends no account or balance context. The link is enabled
   only when the private UI build names an available service origin with
   `VITE_CASHLOOM_SERVICE_ORIGIN`; unconfigured builds do not link to the
   unpublished hosted planner.
3. **Public insights:** existing read APIs, bounded caches, source receipts, and
   partial-coverage behavior. These observations are not used to invent a personal
   balance or a spending recommendation.

The Connections page describes supported capabilities from the current source;
it is not a health monitor and does not imply provider availability or credentials.
Manual accounts work without providers. Stripe, GoCardless, Esplora, Alchemy, and
AgentTool readers need their existing local configuration and permitted access.
Base ETH/native USDC and the supported Bitcoin path retain the existing local-key
payment review. Hardware wallets, WalletConnect, smart-account execution, and bank
payments retain their implementation/activation boundaries.

Both applications use the locally bundled Fraunces, Spline Sans, and Spline Sans
Mono fonts. Opening the planner requires no Google Fonts request. The normal hosting/network
metadata caveats still apply; see the public data-practices endpoint.

## Design choices

- Use a calm ivory and forest palette throughout all modules, readable sans-serif
  body text, clear headings, visible keyboard focus, and touch-friendly controls.
- Each module says what it helps with, what data it uses, and what a person can
  do next. Preserve uncertainty and distinguish estimates, records, observed
  balances, submitted payments, and confirmed settlement.
- Start empty with useful prompts. Avoid invented balances, activity, customers,
  connection status, or promises of guaranteed financial outcomes.
- Keep the existing research tools and payment machinery. Reuse their work
  rather than constructing a second account ledger or payment engine.
- Names change at the interface. Routes, schemas, provider names, and internal
  payment identities change only when there is a functional reason.

The consistency pass gives both applications one visual foundation in
`ui/theme.css`: semantic colors, bundled fonts, corners, focus, and page gutters.
Every public route uses `PublicHeader`; the private workspace keeps its task
sidebar and visible local/private identity. Modules own their layouts and
interactions. Forms, filters, tables, charts, receipts, payment review, connection
states, and the Atlas source viewer use the shared palette. Status colors retain
their meaning. Native controls use the light scheme even when the device prefers
dark mode. This is a shared light theme, not a dark-mode implementation.

## Delivery and next decisions

This local rebuild implements the service entry, monthly planning module,
capability guide, purpose-led public navigation, workspace setup guide, and
private workspace navigation/onboarding. Verification results are recorded below
after implementation checks.

The next releases should address these concrete jobs in order:

1. **Private recurring planning:** decide whether plans belong in the private
   workspace database; add versioned storage and explicit import there if so.
   Do not silently sync a public browser plan with private financial records.
2. **Recurring commitments:** introduce due dates, paid/unpaid evidence, and a
   review workflow before calling the product a bill manager.
3. **Provider onboarding:** complete one bank-data consent journey, test consent
   expiry/revocation, and show read freshness before adding more provider badges.
4. **Shared workspaces:** define invited roles, record ownership, consent,
   audit history, export, and revocation before offering household/team access.
5. **Payment expansion:** finish the relevant owner coordinator and provider
   activation before offering new signing or bank-payment routes.

Publishing requires a separate release decision after reviewing this local
result. No deployment, credential activation, bank connection, or real payment
is part of the verification.

## Verification

Final local checks passed:

| Check | Result |
|---|---|
| Public application Vitest suite | 230 passed, including 54 planner cases |
| Public TypeScript and production build | Passed |
| Private UI suite, TypeScript and build | 119 passed; checks passed |
| Public compiled-build browser suite | 16 checkpoints; all eight routes at 1440, 390 and 320 pixels |
| Isolated private browser fixture | 22 checkpoints; every module checked at 320 pixels |
| Isolated actual private node daily-use fixture | 8 checkpoints |
| Source whitespace check | `git diff --check` passed |

Public browser checks use synthetic plan entries and intentionally unavailable
insight API responses. They verify audience handoff, exact arithmetic, invalid
amounts, shortfalls, opt-in persistence, import review, export, clearing, cross-tab
change/removal handling, navigation, assets, shared typography/color scheme, the
Atlas source viewer, and responsive layouts. No uncaught
client errors or failed page assets were observed. Desktop and mobile screenshots
were inspected. Latest artifacts: `/tmp/cashloom-ui-consistency/`.
Separate populated research checks covered Money insights, Network insights,
and Capital flows at 390 and 1280 pixels, including receipt focus and dismissal.

Separately, a loopback-only INFO process returned HTTP 200 for orientation,
Money insights, and Capital flows. The browser rendered the existing versioned
Money insights response over CORS with no uncaught errors. Capital flows still
reported partial/refreshing coverage; HTTP 200 is not a claim of complete data.
These checks read public upstream sources, without a private wallet or credentials.

The private fixture uses temporary synthetic data, an isolated build, and blocked
non-loopback networking. It preserves account handoffs, manual observations,
activity dates, session checks, payment recovery review, trade-record simulation,
restart, and backup/restore behavior. All 30 browser/node checks passed on the
shared-theme implementation, alongside 119 UI tests, TypeScript, and build.
The fixture preserves the repository's shared theme/font layout and verifies
source hashes; it does not substitute a separate test palette.

To repeat the public checks from `atlas/`:

```sh
bun --no-env-file run typecheck
bun --no-env-file run test
bun --no-env-file run build
bun --no-env-file run preview --host 127.0.0.1 --port 5180 --strictPort
```

In another terminal, from `atlas/`, with the locally installed matched browser:

```sh
CASHLOOM_BROWSER_ORIGIN=http://127.0.0.1:5180 \
CASHLOOM_PLAYWRIGHT_PATH=/Users/yu/.bun/install/cache/playwright-core@1.59.1@@@1/index.mjs \
CASHLOOM_BROWSER_EXECUTABLE=/Users/yu/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell \
node tests/browser/service-smoke.mjs
```

Repeat the private fixture from the repository root with
`python3 sovereign/tests/tcg-browser/run.py --keep-temp`. It reconstructs exact
locked UI dependencies from the existing cache; it does not install them or open
the operator's wallet. See the earlier
[integration report](experience-integration-2026-09-23.md) for the inherited
backend work; its historical full-backend counts were not rerun for this UI rebuild.

The review session leaves the public development preview at
`http://127.0.0.1:5181/`, connected to the read-only INFO process at port 4757.
These are temporary local processes, not installed background services or a
deployment. The default production build continues to use same-origin public APIs.
