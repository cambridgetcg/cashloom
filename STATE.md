# cashloom — STATE

name: cashloom
kind: project
language: see repo
runs-on: this machine

## state
phase: active
health: private release source published; Cloudflare preview verified with 19 checks and zero failures; production deployment pending
release-branch: release/service-workspace-20260929
published-source-snapshot: 602699a6c06e6adfe370da6a356d14d303ce8d07
source-access: existing private cambridgetcg/cashloom repository; repository access required
original-development-branch: feature/capital-flows-20260909, preserved with its original worktree and local edits
original-development-base: e421a1ac4a3e397d0afb8ae65efe2cb5580a515c
preview-gap: hosted /v1/capital-flows returns 404; page explicitly reports the unavailable feed
freshness: manually verified 2026-09-29

## knows
- CashLoom
- implementation survey: docs/current-map-2026-09-23.md
- latest integration and verification: docs/experience-integration-2026-09-23.md
- service rebuild, purpose, naming and delivery: docs/service-rebuild-2026-09-29.md
- US-first money layer and implementation boundaries: docs/unified-money-layer-2026-09-29.md
- daily use and recovery: docs/local-pilot.md

## can
- declare its state via STATE.md
- be discovered by discover.py
- be cross-checked by trust.py

## needs
- owner coordinators and scoped activation before external-wallet or bank-payment execution
- actual Plaid sandbox verification and separate provider approval before live US bank access
- production website deployment and verification; source publication and preview are complete
- separate hosted INFO deployment for the Capital flows API

## how-to-talk-to-me
entry-point: README.md
