# Public INFO rollout — 29 September 2026

The public `cashloom-api` Fly service now serves `GET /v1/capital-flows`, directly
and through cashloom.io. This resolves the API 404 recorded in the earlier
[website](release-service-workspace-2026-09-29.md) and
[agent](release-agent-layer-2026-09-29.md) releases. The private workspace,
account connections, vault, payment routes and local Assist API remain separate.

## Deployed artifact

- Source: `5f6b41e` on the private `release/service-workspace-20260929` branch.
- Image: `registry.fly.io/cashloom-api:deployment-01M3PP26N8B82ERTK1XNEDJDZN`.
- Manifest digest: `sha256:08346fcc192adbda184d025fde06177b14b4e46fb5cc8296c254a2807482a512`.
- INFO bundle SHA-256: `08f287852bbf93cbbb760f4e252af5e17683852b03f13906c881cc3687d36acb`,
  byte-identical to the previously audited Linux/amd64 image.
- Existing London machines: `86545d4ae236d8` (running) and `83d92dc7197298`
  (stopped spare), each one shared CPU / 256 MiB, no volumes. No machine added
  or resource size changed; the rollout used the existing rolling strategy.

The deploy image's runtime file allowlist and absence of custody/Assist symbols
were rechecked. It contains the bundled INFO program and two rights documents.
The Docker context remains an explicit public-source allowlist; no operator
workspace, provider credentials or private node modules were deployed.

Fly accepted the authenticated deployment and the running machine's HTTP health
check passed. The stopped spare's check says it has not started, as expected.
The CLI's optional DNS check timed out querying `8.8.8.8`; direct HTTPS and
same-origin website requests subsequently succeeded using normal resolution.

## Live verification

Twenty-six direct and same-origin API checks passed: INFO metadata; Capital
flows schema and actual publisher observations; empty HEAD; conditional GET
(304 observed); gzip; existing World/onchain doors; and 404s for accounts,
vault session and all four Assist endpoints.

The observed snapshot contained 22 registered series and 404 observations.
US Treasury daily cash financing, ECB securities issuance and ECB investment
fund sources were current. US TIC transactions reached the adapter deadline
and were explicitly unavailable. The API accurately reported `health: partial`
and `launchReadiness: notAssessed`. HTTP availability and release smoke checks
do not establish complete coverage, financial accuracy or launch certification.

Each machine keeps an independent RAM cache. ETag or Age differences across
requests can reflect different validated snapshots; restarting clears that
cache. Publisher cadence, bounded refresh and failure backoff remain unchanged.

Evidence is under `/tmp/cashloom-info-fly-rollout-20260929`: `before.json`,
`after.json` and `api-checks.json`. Public website verification follows the
Connections copy update and is recorded below when complete.

## Rollback

Previous image: `registry.fly.io/cashloom-api:deployment-01M23HMS8VBCYX34QDXMP91QTB`.
Deploy that image to the same `cashloom-api` app with the current public-only
Fly configuration if rollback is needed. That restores the prior public INFO
version and makes the new Capital flows API unavailable again. It does not
restore private records; this app has no private workspace or persistent volume.

The original development branch/worktree remains preserved. Source and rollout
documentation are checkpointed in the separate release worktree; Git main is
unchanged.
