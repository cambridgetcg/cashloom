# cashloom — STATE

name: cashloom
kind: project
language: see repo
runs-on: this machine

## state
phase: active
health: browser and optional WalletConnect phone address selection published; public guide deployed; public INFO serves Capital flows with partial coverage
release-branch: release/service-workspace-20260929
published-source-snapshot: 158d5201d59d96adaec034ef0a70f72a8c894431
production-deployment: 525c44dc-3bb0-48cf-821b-2c02e76fbd29 at https://cashloom.io (rollback: eb4eddb0-4608-47aa-81c1-2fd3834469c2, source 02690a9)
verified-preview: https://a9949173.cashloom-atlas.pages.dev
delivery-checks: release smoke on the preview and on https://cashloom.io each 31 passed with no failures or gaps; www returned 308; served HTML, all 27 assets and the 8 brand-kit files matched the verified build and the bytes served before the deploy; /robots.txt serves the new text/plain file and GET /manifest.json answers 404 problem+json naming /site.webmanifest; the 8 brand-kit files matched brand/kit/web byte for byte with image and manifest content types
source-access: existing private cambridgetcg/cashloom repository; repository access required
original-development-branch: feature/capital-flows-20260909, preserved with its original worktree and local edits
original-development-base: e421a1ac4a3e397d0afb8ae65efe2cb5580a515c
production-gap: API availability gap resolved; TIC transactions reached adapter deadline in the verified snapshot; no complete-coverage claim
info-deployment: registry.fly.io/cashloom-api:deployment-01M3PP26N8B82ERTK1XNEDJDZN; source 5f6b41e
private-workspace: local developer pilot; no live-bank or payment-provider activation
activity: full saved-history search, older pages, same-session Back context, and preserved draft destinations; 15 actual-node daily-use checks passed
crypto: local address-only Base watch; explicit finalized ETH/native-USDC checks; default Base/dRPC live probe settled with quorum two; no history import or spending authority
wallet-standards: EIP-6963/EIP-1193 browser selection and temporary WalletConnect Base address pairing; 229 UI tests, nine actual-SDK scenarios and seven actual-node phone groups passed with synthetic transport; no signing methods
phone-pairing-gap: local Reown project configuration required; no live relay authorization or real-phone approval verified
agent-layer: selected-account local MCP reads, saved finalized Base holdings, and owner-reviewed category proposals; no hosted model or autonomous financial actions
freshness: manually verified 2026-09-30; release, deployment and delivery fields 2026-11-11

## knows
- CashLoom
- implementation survey: docs/current-map-2026-09-23.md
- latest integration and verification: docs/experience-integration-2026-09-23.md
- service rebuild, purpose, naming and delivery: docs/service-rebuild-2026-09-29.md
- US-first money layer and implementation boundaries: docs/unified-money-layer-2026-09-29.md
- daily use and recovery: docs/local-pilot.md
- local MCP access and owner-reviewed categories: docs/agent-layer-2026-09-29.md
- agent source and original deployment verification: docs/release-agent-layer-2026-09-29.md
- public INFO deployment and Capital flows availability: docs/release-info-rollout-2026-09-29.md
- Activity and public setup improvements: docs/release-friction-2026-09-29.md
- Base watch onboarding, saved agent holdings, and delivery: docs/release-crypto-watch-2026-09-29.md

## can
- declare its state via STATE.md
- be discovered by discover.py
- be cross-checked by trust.py

## needs
- owner coordinators and scoped activation before external-wallet or bank-payment execution
- actual Plaid sandbox verification and separate provider approval before live US bank access

## how-to-talk-to-me
entry-point: README.md
