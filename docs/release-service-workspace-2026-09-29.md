# Service and workspace release — 29 September 2026

Status: release candidate under verification. Publication authorization was
given for CashLoom in this session; deployment results are recorded below once
verified.

## Scope and source

The public release replaces the information-only front page with the service
overview, browser money planner, Connections guide, and workspace setup guide.
The private workspace remains a local developer pilot requiring access to the
private source repository. Its API, vault and provider tokens are not deployed
to the public website.

Source branch: `release/service-workspace-20260929`, in the existing private
`cambridgetcg/cashloom` repository. It follows the approved development checkout
and the currently deployed Pages source, `e421a1a`. Remote `main` contains a
divergent development line; this release does not replace or merge that branch.
The original development worktree and its edits are preserved.

The release adds clearer setup and repository-access guidance, accurate Atlas
capability descriptions, route metadata and recovery when a page bundle fails
to load. The local CSV importer also gains individual duplicate review with
stable references for separate transactions that happen to look identical.

## Deployment boundaries

| Component | Target | Release boundary |
|---|---|---|
| Public pages and read proxy | Existing Cloudflare Pages project `cashloom-atlas`; `cashloom.io` and `www.cashloom.io` | Preview first, then production; uses same-origin public read APIs |
| Public INFO service | Existing Fly app `cashloom-api` | Separate public-only image; no private money or custody code |
| Private workspace | Local source/build | No public hosting, live bank activation, or payment-provider activation |

Cloudflare access was verified using the existing Wrangler login. Fly's CLI
reported no access token for `cashloom-api`; an existing CashLoom-specific
credential wrapper or local login was requested. No unrelated app credential
was substituted. If that access remains absent, the website can ship against
the existing INFO service and the new Capital flows API remains unavailable.
The public page states that gap explicitly instead of repeatedly retrying.

## Verification evidence

- Public: 237 unit tests, TypeScript, build and 18 desktop/mobile browser
  checkpoints, including page-load recovery and a missing Capital flows feed.
- Private: 68 read-layer tests and 133 UI tests, TypeScript/build checks, and
  an isolated actual-node import journey. Provider requests use synthetic fixtures.
- Public INFO: 713 tests passed, one optional live test skipped. The build
  context contains 46 allowlisted files; runtime contains only the INFO bundle
  and the two public rights documents. Custody/private route probes return 404.
- Linux/amd64 image tested with one CPU, a hard 256 MiB memory limit and no
  swap. Cold Capital flows, World and network reads returned 200. One hundred
  concurrent cached Capital flows reads returned identical bytes; HEAD,
  conditional 304 and gzip behavior passed. Peak cgroup memory was 149.69 MiB,
  with zero OOM events; this describes the exercised workload, not every
  possible upstream response. TIC's adapter deadline remained an explicit
  partial-data result.
- Candidate-source credential-pattern scan found no private-key blocks,
  live payment keys or recognized cloud-token strings. This is a bounded scan,
  not proof that arbitrary files can never contain sensitive information.

The deployed-site runner is `atlas/tests/browser/release-smoke.mjs`. It uses a
fresh browser, checks the public planner and navigation, reads INFO metadata,
verifies that private endpoints remain inaccessible, and records unavailable
capabilities separately from successful checks.

## Publication and rollback

Previous production Pages deployment:
`f1113944-b573-4176-a351-7006a3d46145` (source `e421a1a`). Retain it as the
rollback target. Cloudflare Pages production branch is `main`; this identifies
the deployment environment and does not require changing the Git main branch.

New deployment IDs, source commit and live verification: pending.
