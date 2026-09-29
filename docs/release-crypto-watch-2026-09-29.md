# Base wallet watching — 29 September 2026

The local workspace now saves a public Base address through **Connections →
Add crypto wallet** and opens its account. **Check balances** explicitly reads
finalized ETH and native USDC evidence from two distinct HTTPS RPC providers.
Accounts and Overview reuse saved evidence without background RPC requests.
Watching neither establishes ownership nor creates signing or spending authority.
There is no transaction-history import, token discovery, or WalletConnect flow.

Creation is owner-only, bounded, and transactional. Repeated requests reuse an
active account for the same Base address while preserving its name and custody.
An uncertain response offers a retry of the original address. Archived accounts
remain intact; incompatible active identities produce a conflict. Creation does
not call providers, generate keys, or populate observed balances.

Agent context adds scoped `base_holdings` for selected active accounts. It reads
saved immutable finalized evidence without RPC, migrations, or projection writes.
Exact atomic amounts remain strings; legacy crypto scalar balances remain null.
Missing or contradictory evidence has no holdings. A failed later check retains
dated evidence with its failed-check status. The projection omits public addresses,
provider URLs, raw snapshots, and unselected account IDs. MCP validates this shape
and cannot create watched accounts, refresh balances, or spend funds.

The public website adds a Base wallet card and a `/wallet#crypto` guide. The
guide explains the local flow and provider disclosure; it collects no addresses.
Private source remains in the existing private repository, with access required.

## Provider compatibility

Balance observations now default to `https://mainnet.base.org` and
`https://base.drpc.org`. Operators may explicitly override the existing scoped
RPC environment variables. Transaction-evidence defaults are unchanged.

The former confirmation provider, PublicNode, returned HTTP 403 and RPC -32602
for numeric finalized-block balance requests, requesting a personal archive token.
Basic chain/header requests still worked. LlamaRPC returned HTTP 525 at chain ID.
The [documented dRPC Base endpoint](https://drpc.org/docs/base-api/accountinfo/eth_getBalance)
passed the existing production observer with two-provider finalized agreement,
including ETH, native USDC, and a numbered-block header recheck. No fallback,
weaker block binding, or weaker quorum was introduced. Public-provider availability
can change; the UI preserves unknown or dated evidence when a check cannot settle.
These diagnostics used only the public zero address and no database or credentials.
The final probe using the actual defaults settled with quorum two in 1,204 ms;
all 12 requests returned HTTP 200. This verifies compatibility at the recorded
time, not continuous availability.

## Verification

- Watch creation and route tests: 62 passed, 523 assertions.
- Assist tests: 37 passed; MCP tests: 91 passed.
- Finalized position observer: eight passed, 47 assertions.
- Private UI: 158 tests, TypeScript and production build passed.
- Isolated browser rehearsal: 22 workspace checks, six real-node/MCP agent checks,
  five crypto groups, 15 real-node daily-use groups, and money-sources checks.
  The crypto run exercises the real API, SQLite, observer, UI, and MCP with a
  synthetic two-provider transport. It covers lost-response retry, deduplication,
  exact amounts, saved reads without RPC, failed refreshes, contradictory evidence,
  lock, restart, selected agent scope and refused financial authority. Temporary
  datasets and OS network restrictions keep operator state outside the rehearsal.
- Public UI: 238 tests, TypeScript/build, and 21 compiled browser checkpoints
  passed. Desktop and 320px layouts fit, including the actual crypto guide handoff.

Local evidence: `/tmp/cashloom-crypto-integration-final-20260929.log`,
`/tmp/cashloom-crypto-observer-tests-20260929.log`, and
`/tmp/cashloom-crypto-public-review-20260929/result.json`.
The final actual-default live probe is
`/tmp/cashloom-crypto-live-default-20260929.json`; isolated browser artifacts are
`/private/var/folders/69/4qnq5h3j1095bfs9psqv13100000gn/T/cashloom-tcg-browser-_hxpsajs`.

## Delivery

Private changes ship as local-workspace source. The website receives the
Connections card and guide. The public INFO source graph is unchanged and needs
no Fly redeployment. This release activates no hosted private wallet, bank, or
payment provider. The original development checkout and inherited edits remain
preserved.

Source implementation: `3c188b1efa71384896e47ccdaa4f52b73f5e6e3d`, published on
the private `release/service-workspace-20260929` branch. The release public build
matched the checked original build across all 30 artifacts. The original private
UI build matched the final isolated browser-tested build across all six artifacts.

| Environment | Deployment | Verification |
| --- | --- | --- |
| Preview | https://fbd634f0.cashloom-atlas.pages.dev | 30 passed, zero failures or API availability gaps |
| Production | https://cashloom.io, Pages ID `54999b6f-899e-4037-a233-f96100c562be` | 30 passed, zero failures or API availability gaps |

Seven deployed entry, planner, guide, and Connections assets matched local
hashes. `www.cashloom.io/connections` returned 308 to the canonical route.
The new private watch path returned 404 for GET and 405 for an empty POST.
The crypto handoff reaches the guide without a public address-entry form.
Capital flows returned 200 with partial source coverage; this does not imply
complete financial-data readiness.

Final reports: `/tmp/cashloom-crypto-preview-20260929/result.json`,
`/tmp/cashloom-crypto-production-20260929/result.json`, and its adjacent
`asset-verification.json`. The Fly INFO image was unchanged.

Website rollback target: Pages deployment
`fa81b155-a70d-4a3e-828c-3079bfc66eda`, source
`d27378ae2a7debfa313cff46b7869cd14b096892`.

## Browser wallet standards

The next increment adds an address picker to the same local watch flow. The
owner chooses a discovered wallet, approves address sharing in that wallet,
selects an address, and reviews it in the existing watch form before saving.
The wallet must report Base before and after account access and at the final
selection check. This is an explicit CashLoom scope choice to keep the watch
target clear; address discovery itself is not proof of account ownership.

The discovery adapter uses the event handshake and page-lifetime listener from
[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963). It bounds and copies wallet
metadata, treats names as self-reported, omits icons, pins the original provider
reference, and offers a generic legacy provider only when no wallet announces
itself. Discovery does not request account permission. The picker uses
[EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) for `eth_chainId`, explicit
`eth_requestAccounts`, final `eth_accounts`, and account/network/disconnect events.
It sends no signing, payment, permission-revocation, or chain-changing method.
Closing clears local selection and selected-provider listeners; it does not revoke wallet-side
site permission. Wallet implementations can contact their own services.

Saved identity continues to use `eip155:8453:<address>`, consistent with
[CAIP-2 chain identifiers](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
and [CAIP-10 account identifiers](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md).
EVM-specific address normalization remains in the existing backend; CAIP-10
does not prescribe a universal canonicalization rule. No new wallet permission,
provider object, browser-wallet identity, or signing authority is stored with
the account or exposed to agents.

WalletConnect pairing remains a separate next integration. Existing code
projects and verifies signed evidence but has no activated pairing transport
or owner completion coordinator. A usable session needs a configured project,
approved origins, narrowly requested capabilities, and tested expiry/update/
deletion handling. The [official Ethereum provider setup](https://github.com/WalletConnect/walletconnect-monorepo/blob/v2.0/providers/ethereum-provider/README.md)
describes the project and session options. This release adds no relay SDK or
WalletConnect permissions. Solana also needs a separate adapter and balance
reader: its [Wallet Standard connection contract](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/features/src/connect.ts)
uses its own authorized-account flow, and its `silent` option is not a universal
no-prompt guarantee. Neither future integration should inherit EVM address rules
or acquire payment authority merely by sharing an address.

Specifications and source were reviewed on 29 September 2026. Verification uses
synthetic browser providers in an isolated browser and actual local node. It
does not certify interoperability with each wallet brand or use a personal
browser profile, real extension, or real wallet approval.

### Browser wallet verification

- Private UI: 195 tests passed, including 31 controller tests and 17 watch/picker
  presentation tests; TypeScript and production build passed.
- The final isolated runner passed 22 workspace checks, six actual-node/MCP agent
  checks, five Base watch groups, nine new browser-wallet groups, 15 actual-node
  daily-use groups, and the money-sources rehearsal. Its source fingerprint
  remained current through completion.
- New browser checks cover multiwallet discovery, hostile metadata as plain text,
  ignored icons, deduplication, initial permission events, declined access, Base
  gating before/after approval and before copying, changed accounts/network,
  explicit address selection, separate saving, duplicate-safe watch creation,
  late responses after close/navigation/lock, generic legacy fallback, and no
  installed wallet. Only the three allowed read methods ran. No backend RPC,
  keys, activity, wallet metadata, or unselected addresses were created or stored.
- Public UI: 238 Vitest tests, TypeScript/build and 21 compiled browser checkpoints
  passed. The guide explains browser selection, permission cleanup, and the
  remaining WalletConnect boundary. Desktop and 320px layouts fit.

The first new browser run read the wallet list before discovery rendered. A
bounded discovery/render wait fixed the harness; no product change was needed.
The initial public unit command used Bun's runner for a Vitest suite; the correct
package test command passed. These are test-runner issues, not wallet compatibility
evidence.

Final local evidence: `/tmp/cashloom-wallet-standards-integration-20260929.log`,
`/tmp/cashloom-wallet-standards-public-review-20260929/result.json`, and
`/private/var/folders/69/4qnq5h3j1095bfs9psqv13100000gn/T/cashloom-tcg-browser-7lkjzdyk`.
