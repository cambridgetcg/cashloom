# Service and workspace release — 29 September 2026

Status: public website deployed and verified at https://cashloom.io on
29 September 2026. Source is published to the existing private repository.
At this website release, the Fly API update was pending authentication. It was
subsequently deployed; see the [INFO rollout record](release-info-rollout-2026-09-29.md).
The private workspace remains a local developer pilot. Evidence below records
the original website release and its then-unavailable Capital flows API.

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
| Public pages and read proxy | Existing Cloudflare Pages project `cashloom-atlas`; `cashloom.io` and `www.cashloom.io` | Deployed after preview verification; uses same-origin public read APIs |
| Public INFO service | Existing Fly app `cashloom-api` | Existing deployment unchanged; tested replacement is a separate public-only image |
| Private workspace | Local source/build | No public hosting, live bank activation, or payment-provider activation |

Cloudflare access was verified using the existing Wrangler login. Fly's CLI
reported no access token for `cashloom-api`; an existing CashLoom-specific
credential wrapper or local login was requested. No unrelated app credential
was substituted. A final `fly status --app cashloom-api --json` check still
reported no access token. The website ships against the existing INFO service
and the new Capital flows API remains unavailable. The public page states that
gap explicitly instead of repeatedly retrying. Resuming that deployment needs
a CashLoom-authorized Fly login or scoped wrapper, not new website approval.

## Verification evidence

- Public: 237 unit tests, TypeScript, build and 18 desktop/mobile browser
  checkpoints, including page-load recovery and a missing Capital flows feed.
- Private: 68 read-layer tests and 133 UI tests, TypeScript/build checks,
  22 fixture journeys and 10 isolated actual-node checks. Provider requests use
  synthetic fixtures. The final 390-pixel import review keeps row selection and
  references visible without horizontal scrolling.
- Public INFO: 713 tests passed, one optional live test skipped. The build
  context contains 46 allowlisted files; runtime contains only the INFO bundle
  and the two public rights documents. Custody/private route probes return 404.
- Linux/amd64 image tested with one CPU, a hard 256 MiB memory limit and no
  swap. Cold Capital flows, World and network reads returned 200. One hundred
  cached Capital flows reads at concurrency 20 returned identical bytes; HEAD,
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

The initial source checkpoint is `71066a5`; it was pushed only to the new release
branch. Its public preview, `0e857a10-9190-4b28-b7de-0524c61a7cf2`, passed all
19 deployed-site checks with zero assertion, page, asset, external-request or
unintended-write failures. The one recorded capability gap was
`GET /v1/capital-flows` returning 404 from the unchanged hosted API. The smoke
runner correctly exits 2 and reports `releaseReady: false` for that incomplete
API rollout. The website-only release decision accepts the clearly disclosed
gap; it does not mark the full API release complete.

Final review replaced unsafe single-file live-database backup advice with the
consistent snapshot command and clarified the architecture guide's limits.
Native publisher CSV/TIC fixture whitespace was preserved; the staged source
whitespace check passes when those fixtures are excluded.

Final deployed source: `932bdc5b6fc3fb2806be8aac6c9689d12e9eaa63`.

| Environment | URL | Result |
|---|---|---|
| Final preview | https://449cf6c3.cashloom-atlas.pages.dev | 19 passed, zero failures; Capital flows API 404 gap |
| Production | https://cashloom.io | 19 passed, zero failures; same disclosed API gap |
| Production deployment | https://4fe327f3.cashloom-atlas.pages.dev | `4fe327f3-de34-44c5-b280-464dbd91fb4e`, source `932bdc5` |

The production entry JavaScript and CSS match the local release build byte for
byte. `https://www.cashloom.io/plan` returns 308 to
`https://cashloom.io/plan`. The production browser run checks all eight pages,
desktop and narrow mobile layouts, synthetic planner arithmetic, opt-in saving,
source-access disclosure, public INFO identification and the private-route
boundary. It records no page errors, asset errors, external resource requests,
planner data requests or unintended writes. These checks describe this run;
they are not an availability or privacy guarantee for hosting infrastructure.

Local evidence: `/tmp/cashloom-release-final-preview-20260929/result.json`,
`/tmp/cashloom-release-production-20260929/result.json` and
`/tmp/cashloom-release-production-20260929/asset-verification.json`.
Documentation-only commits after the deployed source record this outcome and do
not change the deployed artifact. The original development worktree remains
uncommitted and both public/private local builds were refreshed.
