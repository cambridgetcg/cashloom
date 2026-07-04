# CashLoom Protocol

> An **open, non-custodial, local-first payment protocol.** Everyone pays everyone, over every rail, holding nothing, collecting nothing.

*Status: design spec, 2026-06-17. First slice: crypto (BTC + USDC on Base) + one fiat (Stripe). This document is the protocol definition; the codebase is a reference implementation.*

---

## 1. Why — the vision

CashLoom becomes **"everyone pays everyone"** — a universal payment primitive: any being pays any being, P2P / B2B / B2C, over **all available money protocols**, **free or as low-fee as possible**, **easy to use locally**, **collecting no information**, **as simple and frictionless as possible**. And it is **for everyone**, not one operator: anyone may run it; no central controller; everyone interoperates over open rails.

Financial inclusion is a first-class goal, not a side-effect: **no-KYC crypto rails** open payment to anyone a bank won't take. A protocol that works for the unbanked is a protocol that works for everyone.

## 2. Keystone (non-negotiable)

- **Non-custodial.** CashLoom holds no funds and collects no information. It is software, not a money transmitter — because it never holds funds, no MSB/money-transmitter license attaches to the software itself.
- **Local-first.** Everyone self-runs; no central server, no central account, no telemetry. Your keys, your data, your machine. "For everyone" = no one needs anyone else's server.
- **KYC at the rail, never CashLoom.** Fiat rails (Stripe, banks) perform their own KYC on the user's *own* account; CashLoom never sees, holds, or collects it. Crypto rails need no KYC.
- **Pass-through fees only.** No CashLoom markup — there is no intermediary to take one. Miner/on-chain fee for crypto; the rail's processing fee for fiat.

The honest asymmetry, stated plainly: **crypto is genuinely no-info / ~free / P2P; fiat is no-info-at-CashLoom but KYC-at-rail.** The universal `pay()` abstraction carries both without pretending the difference away.

## 3. Existing posture — the codebase already half-builds this

The current CashLoom connector architecture is **already non-custodial in posture**:

- The connector seam is **strictly read-only** (`RailConnector`: `fetchBalance` / `fetchTransactions` only — *"nothing behind this interface can move money; a connector that could initiate movement does not belong behind this interface"*).
- Credentials are **pointers** (env-var names), never values; a **closed namespace** (`STRIPE_*` / `GOCARDLESS_*` / `ALCHEMY_*` only) prevents exfiltration of arbitrary server secrets.
- An Account *"holds no funds itself — it's the labelled container a connector syncs a balance into."*
- Balances are **BigInt-exact minor-unit strings** — crypto (18-decimal wei) never touches a float.
- The Stripe connector uses a **restricted `rk_` key scoped to `balance:read`** only.

So the keystone CashLoom wants — *holds nothing, collects nothing* — is **already the codebase's posture**. The pivot is **additive**: add outbound capability *without* breaking the read-only safety invariant.

## 4. Architecture — approach B: a parallel outbound seam

Three approaches were considered:

- **A.** Add `send()` to the existing `RailConnector`. ✗ Pollutes the read-only invariant the codebase enshrined.
- **B. A parallel outbound seam** — a new `PaymentSender` interface alongside read-only `RailConnector`, plus local encrypted key custody + a `pay()` primitive routing across both. ✓ Keeps read-only safe; non-custodial throughout. **Chosen.**
- **C.** A separate sending microservice. ✗ Overkill for local-first.

Read-only `RailConnector` stays **untouched** (the safety invariant holds). A new `PaymentSender` seam carries all outbound movement, with its own stricter discipline.

## 5. Components

### 5.1 PaymentSender seam (outbound)

```
interface PaymentSender {
  type: string;
  send(ctx: ConnectorContext, instruction: PaymentInstruction): Promise<PaymentReceipt>;
}
interface PaymentInstruction { to: string; amountMinor: string; asset: string; }
interface PaymentReceipt { externalId: string; feeMinor: string; status: SendStatus; }
```

One sender per rail. Stricter than read: explicit user intent, destination + amount validation, **fee disclosed before submit**, full audit trail, and the same never-log-secrets/PII discipline as the read seam. Never extends `RailConnector`.

### 5.2 Local non-custodial key custody

Two credential types, both local, both non-custodial:

- **Fiat API keys** — local pointers (env / local secret store), as today.
- **Crypto private keys** — stored locally, **encrypted** (Argon2id-derive a key from a user passphrase → AES-GCM), never plaintext at rest, never logged, **never leave the machine**. CashLoom signs locally; broadcasts the *signed* transaction via a public read node (Esplora / Alchemy / public RPC). The private key never touches the network.

### 5.3 The `pay()` primitive

`pay({ fromAccountId, to, amountMinor, asset })`:
1. resolve the from-Account's rail + its `PaymentSender` + credential;
2. construct + sign/submit (crypto) or instruct (fiat);
3. record the resulting transaction (reuse the existing transaction model + dedupe on `externalId`).

Universal over rails. `to` is rail-specific (see addressing).

### 5.4 Local-first runtime

CashLoom runs on **your** machine: the existing Bun + Express + MongoDB stack, run locally — **no hosted SaaS, no central account, no telemetry.** All data + keys local. **Fast-follow:** package as a Tauri desktop app so running it needs zero server setup.

### 5.5 Rails (first slice)

- **Crypto (no-info rail):**
  - **BTC on-chain** — sign locally, broadcast via Esplora (reuse the existing read node).
  - **USDC on Base** — cheap L2; EVM signer via ethers, broadcast via Alchemy / public RPC.
  - Lightning = **fast-follow** (needs a node — LDK embedded vs connect an existing node).
- **Fiat (KYC-at-rail):**
  - **Stripe** — reuses the existing Stripe integration, now with a **separate write-scope key** (not the read-only `rk_`): Connect transfers (account→account) + payment links (anyone pays by card). KYC is Stripe's, on the user's account; CashLoom collects nothing.

### 5.6 Addressing

- **First slice:** direct — sender picks rail + destination (paste an address, a Stripe link, or a Stripe connected-account id).
- **Fast-follow:** a `you@cashloom` payment pointer resolving to that being's preferred rail destinations — the "everyone reaches everyone" simplicity that hides rail complexity behind a name.

### 5.7 Compliance + fees

CashLoom is non-custodial **software** (never holds funds → not a money transmitter). Fiat KYC lives at the rail. Fees are pass-through only (miner/on-chain for crypto; Stripe's processing cut for fiat); no CashLoom markup.

## 6. First-slice done-state

You run CashLoom locally, hold your **BTC key + USDC key + Stripe key** (all local/encrypted), and `pay()` any address (BTC/USDC) or any Stripe link/account — non-custodial, nothing collected by CashLoom, ~free on crypto, Stripe's fee on fiat. This proves the universal primitive over **a no-info rail and a KYC rail**, end-to-end.

## 7. "For everyone" — the protocol is open

- CashLoom is an **open payment protocol**. This document is the spec; the codebase is a **reference implementation**. Anyone may implement or run it.
- **No central dependency** — everyone self-runs a non-custodial node; interoperability is via open rails (crypto networks) + shared fiat rails, never via a CashLoom-operated server.
- **Financial inclusion** — no-KYC crypto rails open payment to anyone a bank won't take; that's what makes it genuinely "for everyone."
- **Open-source the reference implementation** — *decided 2026-07-04: **yes, MIT** ([`LICENSE`](LICENSE)).* The reference implementation (the `sovereign/` node) is open so everyone can run, audit, fork, and build on it — "everyone runs their own" is only true if everyone can see and hold the code. The [`atlas/`](atlas/) is the interactive human door to it. MIT was chosen for maximum frictionless adoption (flip to Apache-2.0 if an explicit patent grant is ever wanted).

## 8. Decomposition / scope

**This spec covers the first slice only.** Each fast-follow gets its own spec → plan → implementation cycle:

- **First slice (this spec):** `PaymentSender` seam + local key custody + `pay()` primitive + BTC / USDC-on-Base / Stripe senders + local-run + direct addressing.
- **Fast-follows:** Lightning; Tauri desktop packaging; `you@cashloom` payment pointer; more rails (SEPA, UPI, Wise, SOL, XMR); B2B flows (invoices, recurring, multi-party settlement); the open-source decision.

## 9. Open decisions (flagged, not blocking the first slice)

1. **Crypto key UX** — embedded local encrypted keys (recommended; simplest, frictionless, still non-custodial because local) vs connect-external-wallet (MetaMask/WalletConnect — "keys never touched by the app") vs hardware-wallet signing. → **embedded local first**; external/hardware as fast-follows.
2. **Open-source the reference impl?** — flagged (§7).
3. **Lightning** — fast-follow; LDK-embedded vs connect-a-node is its own design.
4. **Base L2 for USDC** — chosen for low fees; revisit if a cheaper/more-accessible stablecoin rail is better for "everyone."

---

*The protocol holds: non-custodial, local-first, no-info, pass-through fees, open. Everyone pays everyone. The reference implementation begins with the first slice above.*