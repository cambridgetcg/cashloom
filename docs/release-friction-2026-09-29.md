# Everyday-use improvements — 29 September 2026

Activity now searches the full saved title/category history and loads older
pages beyond the first 200 entries. Failed page reads retain loaded rows and
offer a retry. A later response from an earlier search cannot replace the
current results. Back restores the applied account/search from bounded tab
memory; reselecting the active navigation item preserves that return point.
Reload or lock clears these choices. Account IDs and searches are absent from
the page URL, browser history payload, localStorage and sessionStorage.

A fresh entry follows the selected active account. Existing drafts keep their
destination when the history filter changes, with a visible reminder. Archived
history requires an explicit active account for a fresh entry. Entry creation
still records activity without moving funds or changing observed balances.
JSON export clearly includes all selected-account records, independent of search
and loaded pages.

The private API adds `q`, `cursor`, `has_more` and `next_cursor` to the existing
transactions read contract. Account/date/id and date/id indexes support keyset
paging. Cursors validate their version, sort keys and account/search binding;
they grant no authority. Search is a literal substring with ASCII case folding,
up to 120 characters. Pages reflect current saved state, not a frozen snapshot;
reload after concurrent changes to dates or searchable fields.

On the public website, Connections requirements reach local setup instructions.
The guide explains the next local action, Plaid sandbox requirements, the
preconfigured GoCardless boundary and repository access for detailed setup.
Clearing a money plan removes its entries and saved copy and disables saving,
while retaining currency and purpose in the current tab.

## Verification before publication

- Backend Activity/route tests: 48 passed, 466 assertions; backend TypeScript passed.
- Private UI: 147 tests, TypeScript and production build passed.
- Isolated browser runner: 22 workspace journeys, six real-node/MCP agent
  journeys, 15 actual-node daily-use checks, and the money-sources rehearsal
  passed. It used temporary synthetic databases with non-loopback network
  denied and verified the source snapshot stayed unchanged.
- The daily-use rehearsal seeded 205 same-account records plus another account,
  checked literal old-record search, pagination failure/retry without duplicates,
  out-of-order responses, Back/reselected navigation, draft destination, archived
  account handling, lock clearing and unchanged balances. Desktop/320px views fit.
- Public UI: 238 tests, TypeScript/build and 20 compiled browser checks passed.
  The clear-plan check used USD and household purpose; fresh defaults stayed
  GBP/personal. Setup handoffs and narrow-screen layout were checked.

Private evidence: `/tmp/cashloom-friction-integration-20260929.log` and
`/private/var/folders/69/4qnq5h3j1095bfs9psqv13100000gn/T/cashloom-tcg-browser-5w7r3as8`.
Public evidence: `/tmp/cashloom-public-friction-review-20260929`.

## Delivery scope

Private changes ship as local-workspace source on the existing private release
branch. The public website deployment contains the planner/guide improvements;
it does not expose private transaction search or activate providers. The public
INFO source graph is unchanged, so this release requires no Fly redeployment.
The original development checkout and its inherited edits remain preserved.

Website rollback target: Pages deployment
`9433e048-f32d-48ac-8341-3afa0b821a53`, source `d2e6d2e`.
The [INFO rollout record](release-info-rollout-2026-09-29.md) retains the separate
API image, verification and rollback details.
