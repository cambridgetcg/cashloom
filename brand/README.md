# CashLoom: brand

This folder holds CashLoom's brand kit, made with storytold's Craft apps through the artcraft-brand skill (the
private repository `cambridgetcg/brandkit`). `brandkit.json` records this project's details, and `check.mjs` checks
them.

## The look

The kit dresses cashloom.io in the site's own header badge: a pale `#DCEBB9` serif "c" on a `#255B46` tile with a
0.28 corner radius, on the ivory `#F7F8F2` ground. The site is light only. The "c" is Source Serif 4, because
Georgia's licence keeps its outlines out of served files. The wordmark is Inter SemiBold, because VectorCraft can't
draw the site's Spline Sans.

- **Who chose it:** an agent, Claude Code session dd025d89, on 2026-10-27, under Yu's delegation. Yu's word that
  day was "yes, go ahead and wire the kits into the sites", for a kit from each site's current look.
- **Where it is recorded:** cashloom PR #23, section "Look decisions" (merge 02690a9), and ledger item
  `artcraft-estate-wiring`.
- **Where the site's look came from:** the 2026-09-29 service rebuild (`ui/theme.css`, commit 71066a5 by "Beta").
  Who chose that palette is not recorded.

Don't change the identity without its owner's word. Every asset here records who made it in `CREDITS.md`.

## What is here

| Path | What it is |
|---|---|
| `brandkit.json` | this project's details: the look and who chose it, the kit, the files the site serves, its guards, what a deploy does |
| `kit/` | the built kit (artcraft-brand 1.8). Never edit it by hand: change `kit/source/brand.json` and rebuild |
| `kit/source/brand.json` | the generator's input |
| `kit/BRAND.md` | the kit's own guide: files, colours, typefaces and licences, verification |
| `CREDITS.md` | who made what, with fonts and their licences |
| `check.mjs` | the check, copied from brandkit; update it there, not here |

## Rebuild

From the repository root, on a machine with artcraft-brand and vectorcraft-cli 0.17.0 (and Inter Light installed,
see `brandkit.json` under `build.fonts`):

```sh
cd brand/kit && python3 ~/.kingdom/tools/artcraft-brand/scripts/brandkit.py source/brand.json --out . --rebuild-check
```

Then copy the kit files that `brandkit.json` lists under `serve.files` from `kit/web/` into `atlas/public/`, and run:

```sh
node brand/check.mjs
cd atlas && bun run test
```

## How the site uses it

The site is `atlas/`, a Vite and React app served by Cloudflare Pages. The 8 kit files are served from
`atlas/public/`. `atlas/index.html` is the head of every route: it carries the kit's four icon and manifest links,
its one theme-color and color-scheme, and its `og:image` lines. Its title and description are the site's own. Two
tests hold it to the kit: `atlas/tests/brand-kit.sync.test.ts`, which CI runs, and `check.mjs`.

## Deploying

A merge deploys nothing. cashloom.io deploys by hand from a clean worktree of `release/service-workspace-20260929`,
never from `main` (ledger `cl-live-line`): `bun run build` in `atlas/`, then `wrangler pages deploy dist
--project-name cashloom-atlas`, first to a preview branch and then to `--branch main`. A production deploy needs
Yu's word for that release. Afterwards run `atlas/tests/browser/release-smoke.mjs` against the preview and the live
site, compare the served kit files by hash, and record the deployment and its rollback target in `STATE.md`. Some
edges can hold an old HTML answer for root paths such as `/favicon.ico` for up to 4 hours.

Every pushed commit subject ends with `[skip-cd]`, because a push webhook notifies AWS Amplify; whether Amplify still
builds is unverified (decision D6 keeps agents off AWS).
