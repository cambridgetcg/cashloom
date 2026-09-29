# cashloom — STATE

name: cashloom
kind: project
language: see repo
runs-on: this machine

## state
phase: active
health: website deployed; production and final Cloudflare preview each verified with 19 checks and zero failures; separate Capital flows API rollout incomplete
release-branch: release/service-workspace-20260929
published-source-snapshot: 932bdc5b6fc3fb2806be8aac6c9689d12e9eaa63
production-deployment: 4fe327f3-de34-44c5-b280-464dbd91fb4e at https://cashloom.io
verified-preview: https://449cf6c3.cashloom-atlas.pages.dev
delivery-checks: www returned 308; entry JavaScript/CSS hashes matched the verified build
source-access: existing private cambridgetcg/cashloom repository; repository access required
original-development-branch: feature/capital-flows-20260909, preserved with its original worktree and local edits
original-development-base: e421a1ac4a3e397d0afb8ae65efe2cb5580a515c
production-gap: hosted /v1/capital-flows returns 404; page explicitly reports the unavailable feed; smoke releaseReady remains false
info-deployment: unchanged; Fly login unavailable
private-workspace: local developer pilot; no live-bank or payment-provider activation
freshness: manually verified 2026-09-29

## knows
- CashLoom
- implementation survey: docs/current-map-2026-09-23.md
- latest integration and verification: docs/experience-integration-2026-09-23.md
- service rebuild, purpose, naming and delivery: docs/service-rebuild-2026-09-29.md
- US-first money layer and implementation boundaries: docs/unified-money-layer-2026-09-29.md
- daily use and recovery: docs/local-pilot.md
- local MCP access and owner-reviewed categories: docs/agent-layer-2026-09-29.md

## can
- declare its state via STATE.md
- be discovered by discover.py
- be cross-checked by trust.py

## needs
- owner coordinators and scoped activation before external-wallet or bank-payment execution
- actual Plaid sandbox verification and separate provider approval before live US bank access
- separate hosted INFO deployment for the Capital flows API

## how-to-talk-to-me
entry-point: README.md
