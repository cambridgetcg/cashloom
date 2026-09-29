# cashloom — STATE

name: cashloom
kind: project
language: see repo
runs-on: this machine

## state
phase: active
health: service rebuild, shared UI and unified money read layer locally verified; hosted deployment unchanged
branch: feature/capital-flows-20260909
last-commit: e421a1ac4a3e397d0afb8ae65efe2cb5580a515c
uncommitted: existing Capital flows, TCG, connected-experience and recovery work; service rebuild, consistent UI, Plaid sandbox read flow, unified observations, reviewed imports/exports and internal transfers
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
- separate publication/deployment review for this development checkout

## how-to-talk-to-me
entry-point: README.md
