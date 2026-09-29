# CashLoom — your money, your direction

CashLoom helps people **make a money plan, keep useful records, and understand
their options**. This checkout rebuilds the service around individuals,
households, independent work, and small shared projects, using the existing
private wallet and public information tools.

- **Overview, `/`:** choose a useful task and a starting context.
- **Money plan, `/plan`:** plan a month in your browser, see what remains,
  optionally save on this device, and import/export a portable plan.
- **Your workspace, `/wallet`:** set up the private local application for
  accounts, balance observations, activity, reviewed payments, and agreements.
- **Connections, `/connections`:** understand supported readers and payment
  paths, setup requirements, and what is still unavailable.
- **Money insights, `/world`:** public rates, currencies, and source receipts;
  Capital flows and Network insights remain available as deeper research views.

**Release status — 29 September 2026:** source is published on
`release/service-workspace-20260929` in the private CashLoom repository.
The website and local-agent setup guide are deployed at [cashloom.io](https://cashloom.io).
The public INFO service has now been updated on Fly, and the Capital flows API
returns publisher reports through the same website origin. Coverage remains
partial: source failures and missing observations stay explicit. See the
[INFO rollout record](docs/release-info-rollout-2026-09-29.md) for current
verification and deployment details. Existing account, payment, Capital flows,
and TCG work is preserved.
Household/group planning is one person's editable plan with an export, not shared
accounts or joint payment authority. The private workspace remains a local
developer pilot; this website release activates no live banks or private payments.

Website source checkpoint: `d2e6d2ee15a102e42c87591014b1ad6a4a7ef35a`.
Preview and production each passed all 25 release checks with no failures or
API availability gaps. The `www` redirect returned 308, and deployed entry and
Connections assets matched the verified build. Deployment and rollback details
are in the INFO rollout record above; the earlier
[agent release record](docs/release-agent-layer-2026-09-29.md) preserves that
milestone's verification.

Read the [purpose, naming, architecture, and delivery plan](docs/service-rebuild-2026-09-29.md).
The [US-first unified money layer](docs/unified-money-layer-2026-09-29.md) now
connects the private records view to a Plaid sandbox flow, existing Stripe and
crypto readers, reviewed manual-account imports, and transfer review. Live bank
access and direct PayPal/Cash App connections remain future work.
The [local agent layer](docs/agent-layer-2026-09-29.md) adds selected-account
reads through MCP and category suggestions for owner review. **Setup → Agent
access** controls scope, expiry and revocation. It does not start a model,
refresh providers or grant payment authority.
Both public and private interfaces share colors, fonts, and control tokens from
[`ui/theme.css`](ui/theme.css). Public pages use `PublicHeader`; module styles
own their layouts and reuse these tokens for new screens and states.

For a local preview from this checkout:

```sh
cd atlas
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

Overview, Money plan, Connections, and the workspace guide need no local wallet
or provider configuration. To use insights in a local preview, start INFO and
set `VITE_CASHLOOM_API_BASE` with the commands below; Vite alone does not serve
those APIs. Private workspace setup is
in the [local pilot guide](docs/local-pilot.md).

## Existing public information service

**[Open CashLoom World at cashloom.io/world](https://cashloom.io/world)** — public,
read-only money information. No account or wallet required.

Read policy and cash rates, available sovereign yields, currency and crypto
references, fee observations, and scheduled policy meetings. Open a **Receipt**
to inspect a source, its timestamps, method, and limitations. Coverage is partial:
stale observations keep their labels and timestamps; unavailable and rights-withheld
data remain explicit gaps, not estimates.

- **[Product guide](https://github.com/cambridgetcg/cashloom/blob/release/service-workspace-20260929/MONEYWORLD.md)** — what World shows, currency references, and local Watching filters; private repository access required.
- **[Machine orientation](https://cashloom-api.fly.dev/v1/orientation)** — existing public read-only API doors and their boundaries.
- **[Onchain](https://cashloom.io/onchain)** — a secondary view of selected network, stablecoin, credit, pool, and bridge observations; no wallet connection or execution.

## Run the existing information tools locally

Prerequisites: Git, a current [Bun](https://bun.sh/) release, a browser,
internet access, and access to the **private CashLoom GitHub repository**.
Authenticate Git with a GitHub account that has repository access before cloning.
Without access, GitHub may show “Page not found.” The following command retrieves
the current service/workspace release, including the local INFO and Capital flows
implementation. Public website use does not require repository access.

```bash
git clone --branch release/service-workspace-20260929 https://github.com/cambridgetcg/cashloom.git cashloom
cd cashloom
(cd sovereign && bun install --frozen-lockfile)
(cd atlas && bun install --frozen-lockfile)
```

Start each terminal from the `cashloom` checkout root.

**Terminal 1 — read-only INFO service:**

```bash
cd sovereign
CASHLOOM_BIND=127.0.0.1 CASHLOOM_PORT=4747 bun run src/info-server.ts
```

**Terminal 2 — public service frontend:**

```bash
cd atlas
VITE_CASHLOOM_API_BASE=http://127.0.0.1:4747 bun run dev --host 127.0.0.1
```

Open `/world` on the local URL printed by Vite (normally
`http://127.0.0.1:5173/world`) for Money insights. Both
processes bind to loopback; stop each with Ctrl+C. No wallet setup or provider
credentials are required for this World path. Do **not** use `bun start` here:
it starts the separate local wallet, not the read-only INFO service.

Local hosting is not offline operation. INFO still reads upstream public data
services and RPC endpoints; their availability and usage terms still apply.
Provider failures can leave partial coverage. For local machine discovery, read
`http://127.0.0.1:4747/v1/orientation`.

## Capital flows — source and deployment status

The published private release includes the lazy human route `/capital-flows`
and read-only API `GET /v1/capital-flows` (also conditional GET/HEAD).
As verified on 29 September 2026, the hosted API now returns **200** directly and
through [cashloom.io/v1/capital-flows](https://cashloom.io/v1/capital-flows).
The observed snapshot contained US Treasury financing and ECB securities/fund
reports; TIC transactions timed out and remained explicitly unavailable. This
is selected, delayed coverage, not a complete view of capital flows. The
public-only image excludes private workspace and agent code. To use the API locally, clone
the release above, run the INFO/frontend commands, then open `/capital-flows`
on the local frontend and `http://127.0.0.1:4747/v1/capital-flows`.
[Product guide](MONEYWORLD.md#capital-flows--source-and-deployment-status) ·
[API contract code](sovereign/src/info/capital-flows/model.ts).

- **Scope:** US Treasury published daily cash debt issues/redemptions/net;
  Spain/Germany monthly central-government face-value issuance/redemptions/net;
  quarterly euro-area non-MMF equity/bond/real-estate/private-equity fund-share
  transactions; monthly TIC foreign purchases/sales/net of selected US long-term
  securities. These are scoped populations, not worldwide flows or pure secondary
  trading volume. Crypto/metals flows and other uncovered markets remain gaps.
- **Units and receipts:** keep native USD/EUR millions, exact decimal values,
  reporting periods, sign conventions and geography dimensions. Receipts name
  datasets, series, transformations, rights and original retrieval times; unknown
  publication times stay unknown. No global total or historical conversion with
  today's FX; fund domicile does not identify investors or underlying investments.
- **History and refresh:** on-demand, bounded latest-revised publisher history,
  not archived vintages. Limits are 60 daily, 26 weekly, 24 monthly, 20 quarterly
  observations per series (only selected daily/monthly/quarterly sources enabled).
  Cold responses may be partial/refreshing; source failures retain original
  last-good receipts in RAM for at most seven days after validation. Restart
  clears that cache. Capital reads never enter World's critical path. No accounts,
  execution, alerts, continuous collector or persistent browser snapshot storage.

## Connected experience — release source

World, Capital flows, Onchain, Atlas, and a new `/wallet` introduction share
navigation. The introduction explains how to run the separate local wallet;
the public website does not connect to a private node.

Inside the workspace, Signing keys → Accounts → Send money / Receive money /
Activity carries the selected account or key. Overview shows saved balance evidence, manual accounts can record
a balance observation, and eligible signed Base payments offer reviewed recovery.
Trades remains a records-and-simulation feature. The public MCP adapter now
exposes World, Onchain, and Capital flows alongside its existing read tools.

These changes are published in the private release branch. The public website
and preview were deployed and verified on 29 September 2026. The private
workspace remains local; the separate public INFO rollout now serves Capital flows.
See the [integration report and verification](docs/experience-integration-2026-09-23.md)
and the [earlier implementation survey](docs/current-map-2026-09-23.md).
For daily use, setup, and recovery, see the [local pilot guide](docs/local-pilot.md).

## Source and advanced paths

[Current release source](https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929)
is on `release/service-workspace-20260929` in the **private repository**.
Repository access is required to read or clone it. Release links identify
published source, not the exact revision running on the hosted service. The
original `feature/capital-flows-20260909` development worktree and its edits
are preserved separately.

- **[Advanced: local wallet](sovereign/README.md)** — separate owner-controlled custody, signing, and connector setup, with activation boundaries.
- **[Wallet code atlas — advanced](https://cashloom.io/atlas)** — the interactive local-wallet/code explainer in `atlas/`, which also contains the World frontend.
- **Protocol and wallet design:** [Protocol](PROTOCOL.md), [Wallet Kernel v2](WALLET-KERNEL-V2.md), [Connectivity](WALLET-CONNECTIVITY.md), [Fiat route](FIAT-ROUTE.md), and [zerone](ZERONE.md).

## Privacy, license, and rights

See the existing [public-service data practices](https://cashloom-api.fly.dev/v1/data-practices)
for application scope and hosting, network, browser, operator, and upstream
caveats. Read-only access and local preferences are **not an anonymity claim**;
external layers may see request metadata or retain logs.

[MIT](LICENSE) — free to use, run, modify, and distribute. CashLoom adopts
[`xenia.rights/0.1`](RIGHTS.md): guests, human or agent, are subjects; reading
without registration is a right. The rights text is pinned and vendored in
[RIGHTS.md](RIGHTS.md).
