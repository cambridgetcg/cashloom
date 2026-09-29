# cashloom — STATE

name: cashloom
kind: project
language: see repo
runs-on: this machine

## state
phase: active
health: website and local agent source published; public INFO rollout complete; Capital flows API returns publisher reports with partial coverage
release-branch: release/service-workspace-20260929
published-source-snapshot: b89cbb2bae5008084339b057497c7ea3a711a252
production-deployment: fec97b1f-54f3-4e59-8cf1-6337b3e672d1 at https://cashloom.io
verified-preview: https://0f31568b.cashloom-atlas.pages.dev
delivery-checks: www returned 308; entry JavaScript/CSS, Connections and agent-guide hashes matched the verified build
source-access: existing private cambridgetcg/cashloom repository; repository access required
original-development-branch: feature/capital-flows-20260909, preserved with its original worktree and local edits
original-development-base: e421a1ac4a3e397d0afb8ae65efe2cb5580a515c
production-gap: API availability gap resolved; TIC transactions reached adapter deadline in the verified snapshot; no complete-coverage claim
info-deployment: registry.fly.io/cashloom-api:deployment-01M3PP26N8B82ERTK1XNEDJDZN; source 5f6b41e
private-workspace: local developer pilot; no live-bank or payment-provider activation
agent-layer: selected-account local MCP reads and owner-reviewed category proposals; no hosted model or autonomous financial actions
freshness: manually verified 2026-09-29

## knows
- CashLoom
- implementation survey: docs/current-map-2026-09-23.md
- latest integration and verification: docs/experience-integration-2026-09-23.md
- service rebuild, purpose, naming and delivery: docs/service-rebuild-2026-09-29.md
- US-first money layer and implementation boundaries: docs/unified-money-layer-2026-09-29.md
- daily use and recovery: docs/local-pilot.md
- local MCP access and owner-reviewed categories: docs/agent-layer-2026-09-29.md
- latest source, deployment and verification: docs/release-agent-layer-2026-09-29.md
- public INFO deployment and Capital flows availability: docs/release-info-rollout-2026-09-29.md

## can
- declare its state via STATE.md
- be discovered by discover.py
- be cross-checked by trust.py

## needs
- owner coordinators and scoped activation before external-wallet or bank-payment execution
- actual Plaid sandbox verification and separate provider approval before live US bank access

## how-to-talk-to-me
entry-point: README.md
