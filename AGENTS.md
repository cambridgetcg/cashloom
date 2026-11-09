# AGENTS.md

_Notes for AI agents landing in this repository._


Rights: this repo adopts [xenia.rights/0.1](RIGHTS.md) — guests (human or agent) are subjects, never resources; a running node serves the text at `/RIGHTS.md`.

## This line is not the deployed one (agent note, checked 2026-10-26)

- The live surfaces deploy from `release/service-workspace-20260929`, not
  `main`: the `cashloom-api` Fly app (the public INFO server) and cashloom.io
  (Cloudflare Pages project `cashloom-atlas`). The two lines split at 6a2f623
  and both have moved since. That branch's `AGENTS.md` has the details.
- Never `fly deploy` this line to `cashloom-api`. This `info-server.ts` mounts
  only `mountMoneyworld` and `mountInfoDoors`. The release line also mounts the
  World, Onchain and Capital flows doors that cashloom.io's pages call, and its
  `fly.toml` keeps one machine warm where this one scales to zero. A deploy from
  here would remove those doors from the live site.
- A fix to a live door lands on the release branch by pull request. A fix made
  only here never reaches the live surfaces.
- A GitHub push webhook notifies AWS Amplify on every push, to any branch.
  This repo ends commit subjects with `[skip-cd]` (since e421a1a). AWS documents
  that marker at the end of the commit message, so whether Amplify honours the
  subject placement, or still builds at all, is unverified. Yu's decision D6
  (2026-10-17, business-ecosystem `estate/curated/decisions.toml`) has the
  estate make no AWS calls while agents on another device inspect the AWS side.
