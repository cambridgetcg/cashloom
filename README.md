# CashLoom World — understand money, with source receipts

**[Open CashLoom World at cashloom.io](https://cashloom.io/)** — public,
read-only money information. No account or wallet required.

Read policy and cash rates, available sovereign yields, currency and crypto
references, fee observations, and scheduled policy meetings. Open a **Receipt**
to inspect a source, its timestamps, method, and limitations. Coverage is partial:
stale observations keep their labels and timestamps; unavailable and rights-withheld
data remain explicit gaps, not estimates.

- **[Product guide](https://github.com/cambridgetcg/cashloom/blob/release/moneyworld-wallet-kernel-v2-20260823/MONEYWORLD.md)** — what World shows, currency references, and local Watching filters.
- **[Machine orientation](https://cashloom-api.fly.dev/v1/orientation)** — existing public read-only API doors and their boundaries.
- **[Onchain](https://cashloom.io/onchain)** — a secondary view of selected network, stablecoin, credit, pool, and bridge observations; no wallet connection or execution.

## Run World locally

Prerequisites: Git, a current [Bun](https://bun.sh/) release, a browser, and
internet access. Clone the named World release, **not the older default `main`**:

```bash
git clone --branch release/moneyworld-wallet-kernel-v2-20260823 https://github.com/cambridgetcg/cashloom.git cashloom
cd cashloom
(cd sovereign && bun install --frozen-lockfile)
(cd atlas && bun install --frozen-lockfile)
```

Start each terminal from the `cashloom` checkout root.

**Terminal 1 — read-only INFO service:**

```bash
cd sovereign
CASHLOOM_BIND=127.0.0.1 CASHLOOM_PORT=4747 bun run src/info-server.ts
```

**Terminal 2 — World frontend:**

```bash
cd atlas
VITE_CASHLOOM_API_BASE=http://127.0.0.1:4747 bun run dev --host 127.0.0.1
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173/`). Both
processes bind to loopback; stop each with Ctrl+C. No wallet setup or provider
credentials are required for this World path. Do **not** use `bun start` here:
it starts the separate local wallet, not the read-only INFO service.

Local hosting is not offline operation. INFO still reads upstream public data
services and RPC endpoints; their availability and usage terms still apply.
Provider failures can leave partial coverage. For local machine discovery, read
`http://127.0.0.1:4747/v1/orientation`.

## Source and advanced paths

[Published World source](https://github.com/cambridgetcg/cashloom/tree/release/moneyworld-wallet-kernel-v2-20260823)
is on `release/moneyworld-wallet-kernel-v2-20260823`. Release links identify
published source, not the exact revision running on the hosted service.

- **[Advanced: local wallet](sovereign/README.md)** — separate owner-controlled custody, signing, and connector setup, with activation boundaries.
- **[Wallet code atlas — advanced](https://cashloom.io/atlas)** — the interactive local-wallet/code explainer in `atlas/`, which also contains the World frontend.
- **Protocol and wallet design:** [Protocol](PROTOCOL.md), [Wallet Kernel v2](WALLET-KERNEL-V2.md), [Connectivity](WALLET-CONNECTIVITY.md), [Fiat route](FIAT-ROUTE.md), and [zerone](ZERONE.md).

## Privacy, license, and rights

See the existing [public-service data practices](https://cashloom-api.fly.dev/v1/data-practices)
for application scope and hosting, network, browser, operator, and upstream
caveats. Read-only access and local preferences are **not an anonymity claim**;
external layers may see request metadata or retain logs.

[MIT](LICENSE) — free to use, run, modify, and distribute. CashLoom adopts
[`xenia.rights/0.1`](RIGHTS.md): guests, human or agent, are subjects; reading
without registration is a right. The rights text is pinned and vendored in
[RIGHTS.md](RIGHTS.md).
