# Agent access release — 29 September 2026

This extends the [service/workspace release](release-service-workspace-2026-09-29.md)
with selected-account agent access, local MCP tools and owner-reviewed activity
categories. The private workspace and MCP adapter remain local. The website
adds setup guidance; it does not host a model or receive private records.

## Delivered behaviour

- **Setup → Agent access** issues a short-lived grant for selected accounts,
  with category suggestions optional. Credentials are shown once and cleared
  from the view on navigation, hiding, lock or expiry.
- Three local MCP tools read recent saved records, submit category suggestions
  and read this grant's proposals. Unknown balances remain unknown, legacy
  crypto balances are withheld, and bounded activity is not a period report.
- The owner sees the original category, proposed category and submitted reason.
  Acceptance changes only the category and compares current record evidence
  atomically. Replay cannot duplicate a change; stale suggestions cannot apply.
- Individual revocation, expiry, successful node-wide lock and restart end
  access. Saved suggestions and decisions remain for owner review.
- Owner review and agent proposal reads have separate endpoints. An owner token
  accidentally supplied to MCP cannot retrieve the broader owner list.
- The public Connections card opens the Agent access guide. Fragment links wait
  for the lazy guide to mount, so setup links land on their intended section.

The [setup and limits](agent-layer-2026-09-29.md) cover client-secret injection,
proxy refusal, client/model data retention, quotas and the existing SQLite
retention boundary. No model configuration, provider activation or payment
authority is added.

## Verification

- Backend Assist: 29 tests; existing index, vault and signed-payment regressions:
  59 tests. Whole-backend TypeScript check passed.
- MCP adapter: 72 tests, including real Bun stdio and refusal of inherited
  proxy/debug settings before sending a token.
- Private UI: 140 tests, TypeScript/build, and 9 focused synthetic browser checks.
- Final isolated actual-node suite: 22 navigation/payment/trade regression
  checks, 6 complete MCP/owner-review checks, 10 daily-use/recovery checks and
  the money-sources browser journey. All passed; source fingerprints still
  matched when the run ended. Agent review screenshots at 1280 and 320 pixels
  were visually inspected after disabling entrance animations.
- Public UI: 237 tests, TypeScript/build and 18 compiled service browser checks.
- Public-only Linux/amd64 INFO image rebuilt and checked at 256 MiB / one CPU:
  metadata responds, all four Assist routes return 404, runtime contains only
  the bundled INFO program and rights documents, and private custody/Assist
  symbols are absent.

All private browser and MCP verification uses temporary synthetic records.
Operator records, credentials, real bank links and model services are not used.
Local integrated evidence is under
`/private/var/folders/69/4qnq5h3j1095bfs9psqv13100000gn/T/cashloom-tcg-browser-it5qhuv6`
and `/tmp/cashloom-agent-integration-final-20260929.log`.

## Publication

Release branch: `release/service-workspace-20260929` in the existing private
repository. The original development worktree and inherited edits remain
preserved. Source publication does not deploy the local node or connect a model.
Published source: `b89cbb2bae5008084339b057497c7ea3a711a252`.

| Surface | Verified deployment | Result |
| --- | --- | --- |
| Cloudflare preview | https://0f31568b.cashloom-atlas.pages.dev | 24 checks, zero failures |
| Production | https://cashloom.io, deployment `fec97b1f-54f3-4e59-8cf1-6337b3e672d1` | 24 checks, zero failures |

Both deployed checks cover all eight human routes, narrow layouts, local planner
behaviour, guide access disclosure, the Agent access fragment handoff, public
INFO metadata, four absent Assist APIs and the other private-route/write
refusals. There were no page/asset errors, external-resource attempts or
unintended writes. Entry JavaScript/CSS plus Connections and agent-guide assets
match the verified build byte for byte. `www.cashloom.io` returns 308 to the
canonical site.

The runner exits 2 and retains `releaseReady: false` solely for the existing
Capital flows API gap below. The website-only release accepts that disclosed
gap; it does not mark the separate API rollout complete.

Reports: `/tmp/cashloom-agent-release-preview-20260929/result.json`,
`/tmp/cashloom-agent-release-production-20260929/result.json` and
`/tmp/cashloom-agent-release-production-20260929/asset-verification.json`.

Rollback target for the website is the previous production Pages deployment
`4fe327f3-de34-44c5-b280-464dbd91fb4e` (source `932bdc5`). Use the existing
`cashloom-atlas` project. Pages' `main` deployment environment does not require
changing the Git main branch. The original development branch and its local
edits remain uncommitted; release checkpoints are in the separate worktree.

The hosted Capital flows API remains a separate incomplete rollout. A
`fly status --app cashloom-api --json` check still reports no access token and
requests `flyctl auth login`; the INFO app is unchanged. Website release checks
retain this capability gap rather than marking the full API release ready.
