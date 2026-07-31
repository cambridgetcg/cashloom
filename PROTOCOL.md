# CashLoom Protocol

> An **open, non-custodial, local-first payment protocol.** Everyone pays everyone, over every rail, holding nothing, collecting nothing.

*Status: design spec, updated 2026-07-31. Shipped slices: BTC + ETH/USDC on
Base, the operatorless CashLoom v2 signed-record foundation, portable
Bitcoin-mainnet request/acceptance handoff, and payer-local exact BTC execution
binding; fiat sending remains provider-backed design work. This document is
the protocol definition; the codebase is a reference implementation.*

---

## 1. Why — the vision

CashLoom becomes **"everyone pays everyone"** — a universal payment primitive: any being pays any being, P2P / B2B / B2C, over **all available money protocols**, **free or as low-fee as possible**, **easy to use locally**, **collecting no information**, **as simple and frictionless as possible**. And it is **for everyone**, not one operator: anyone may run it; no central controller; everyone interoperates over open rails.

Financial inclusion is a first-class goal, not a side-effect:
**self-custodied open crypto rails do not require a CashLoom registration**.
Local law, fiat on-ramps, hosted RPC/facilitator policy, and counterparties can
still impose screening or access limits. A protocol that can work without a
bank account is more useful to everyone.

## 2. Keystone (non-negotiable)

- **Self-custodial architecture.** A sovereign node keeps its user's encrypted
  keys and data local and does not pool customer funds. Regulatory
  classification still depends on the deployed service, actual funds flow,
  control, jurisdiction, and provider contract; “non-custodial” is not an
  automatic legal exemption.
- **Local-first.** Everyone self-runs; no central server, no central account, no telemetry. Your keys, your data, your machine. "For everyone" = no one needs anyone else's server.
- **Identity/compliance at the rail.** Fiat providers perform onboarding on
  their own accounts. A local CashLoom node does not operate a central identity
  store by default. Permissionless crypto protocols do not require CashLoom
  KYC, while hosted providers may apply KYT, sanctions, or account controls.
- **Pass-through fees only.** No CashLoom markup — there is no intermediary to take one. Miner/on-chain fee for crypto; the rail's processing fee for fiat.

The honest asymmetry, stated plainly: **self-custodied crypto can be direct but
is publicly observable and network-fee-bearing; fiat is provider-mediated and
usually identity-bound.** The universal `pay()` abstraction carries both
without pretending the difference away.

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
  quote(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentQuote>;
  send(ctx: SenderContext, instruction: PaymentInstruction): Promise<PaymentReceipt>;
}
interface PaymentInstruction { to: string; amountMinor: string; asset: string; detail?: string; }
interface PaymentQuote { feeMinor: string; feeAsset: string; summary: string; detail?: string; }
interface PaymentReceipt { externalId: string; status: SendStatus; }
```

One sender per rail. Stricter than read: explicit user intent, destination + amount validation, **fee disclosed before submit**, full audit trail, and the same never-log-secrets/PII discipline as the read seam. Never extends `RailConnector`.

### 5.2 Local non-custodial key custody

Two credential types, both local, both non-custodial:

- **Fiat API keys** — local pointers (env / local secret store), as today.
- **Crypto private keys** — stored locally, **encrypted** (Argon2id-derive a key from a user passphrase → AES-GCM), never plaintext at rest, never logged, **never leave the machine**. CashLoom signs locally; broadcasts the *signed* transaction via a public read node (Esplora / Alchemy / public RPC). The private key never touches the network.

### 5.3 The `pay()` primitive

`pay()` is a quote/confirm rite:
1. resolve the from-Account's rail + its `PaymentSender` + credential;
2. quote and persist the exact destination, amount, and fee/rail detail without signing;
3. atomically claim one explicit confirmation;
4. sign locally and persist the deterministic transaction ID before one submission; and
5. record or reconcile the result by the rail's external ID.

Universal over rails. `to` is rail-specific (see addressing).

### 5.4 Local-first runtime

CashLoom runs on **your** machine: the shipped Bun + Hono + bun:sqlite stack, run locally — **no hosted SaaS, no central account, no telemetry.** All data + keys local, in one SQLite file. **Fast-follow:** package as a Tauri desktop app so running it needs zero server setup.

### 5.5 Rails (first slice)

- **Crypto (self-custodied rail):**
  - **BTC on-chain** — sign locally, broadcast via Esplora (reuse the existing read node).
  - **ETH + USDC on Base** — EVM signer via viem, broadcast via a public or user-selected RPC.
  - Lightning = **fast-follow** (needs a node — LDK embedded vs connect an existing node).
- **Fiat (KYC-at-rail) — _planned, not yet shipped_:**
  - **Stripe (collect)** — an offline, test-mode hosted Checkout contract ships
    in `sovereign/src/processors/stripe-checkout.ts`: it compiles a direct
    connected-account request, commits idempotency before an injected transport,
    and authenticates/deduplicates webhooks. No HTTP transport, credential,
    route, onboarding, payout, refund, or live collection ships yet. Collection
    is deliberately not an outbound `PaymentSender`.

### 5.6 Addressing

- **First slice:** direct — sender picks rail + destination (paste an address, a Stripe link, or a Stripe connected-account id).
- **Portable v2 handoff:** a public `.cashloom-pay` carries the exact
  Bitcoin-mainnet terms and merchant key for offline inspection; a separate
  merchant-addressed `.cashloom-accept` returns payer-signed consent evidence.
  No CashLoom URL, hosted account, lookup service, processor, or
  internet-reachable node is required; each signer still uses its own local
  sovereign node and unlocked vault. Neither file executes or proves
  settlement. The payer's node may separately bind its own active intent to
  one exact BTC account and PSBT review; only a fresh, explicitly labelled
  final confirmation creates the execution commitment and permits one
  sign/broadcast attempt.
- **Fast-follow:** a `you@cashloom` payment pointer resolving to that being's preferred rail destinations — the "everyone reaches everyone" simplicity that hides rail complexity behind a name.

### 5.7 Compliance + fees

The sovereign implementation is designed so CashLoom does not pool user funds,
but a hosted facilitator, marketplace, payment-initiation flow, or
CashLoom-controlled provider balance can change the regulatory analysis. Each
production funds flow needs provider underwriting and jurisdiction-specific
review; see [`docs/KINGDOM-PAYMENTS.md`](docs/KINGDOM-PAYMENTS.md). The current
product policy is pass-through network/provider fees with no CashLoom markup.

## 6. First-slice done-state

You run CashLoom locally, hold your **BTC key + Base key**
(local/encrypted), and `pay()` a BTC, ETH, or USDC-on-Base address. The two
crypto senders (`sovereign/src/senders/btc.sender.ts` + `evm.sender.ts`) ship
today; the **Stripe hosted-collection runtime is still unconnected**, so
provider-backed fiat payment is not yet reachable. The self-custodied crypto rails prove the
quote/sign/submit primitive end-to-end; the fiat rail lands next.

## 7. "For everyone" — the protocol is open

- CashLoom is an **open payment protocol**. This document is the spec; the codebase is a **reference implementation**. Anyone may implement or run it.
- **No central dependency** — everyone self-runs a non-custodial node; interoperability is via open rails (crypto networks) + shared fiat rails, never via a CashLoom-operated server.
- **Self-certifying protocol identity** — v2 authority is an Ed25519 key
  fingerprint carried in canonical signed records, not a CashLoom account,
  company, email, DNS name, or hosted registry. Direct HTTP delivery separately
  pins the caller-selected key and exact transport origin; TLS location is not
  promoted into protocol identity. Local append-only verification is specified in
  [`docs/CASHLOOM-V2.md`](docs/CASHLOOM-V2.md).
- **Financial inclusion** — self-custodied rails can reduce dependence on a
  single provider, but they do not erase jurisdictional law, sanctions,
  network access, counterparty screening, or the practical barriers people
  face.
- **Open-source the reference implementation** — *decided 2026-07-04: **yes, MIT** ([`LICENSE`](LICENSE)).* The reference implementation (the `sovereign/` node) is open so everyone can run, audit, fork, and build on it — "everyone runs their own" is only true if everyone can see and hold the code. The [`atlas/`](atlas/) is the interactive human door to it. MIT was chosen for maximum frictionless adoption (flip to Apache-2.0 if an explicit patent grant is ever wanted).

## 8. Decomposition / scope

**This spec covers the first slice only.** Each fast-follow gets its own spec → plan → implementation cycle:

- **Shipped slice:** `PaymentSender` seam + local key custody + quote/confirm
  `pay()` + BTC / ETH / USDC-on-Base senders + durable cross-process EVM
  account-nonce reservations + local-run + direct addressing, plus the v2
  Bitcoin `.cashloom-pay` / `.cashloom-accept` offline handoff. The latter
  signs and imports evidence but does not call `pay()`.
- **Provider slice:** the offline Stripe Connect direct-charge Checkout
  contract is present; a separately reviewed sandbox transport and signed
  endpoint are next. See [`docs/KINGDOM-PAYMENTS.md`](docs/KINGDOM-PAYMENTS.md).
- **Fast-follows:** Lightning; Tauri desktop packaging; `you@cashloom` payment pointer; more rails (SEPA, UPI, Wise, SOL, XMR); B2B flows (invoices, recurring, multi-party settlement); the open-source decision.

## 9. Open decisions (flagged, not blocking the first slice)

1. **Crypto key UX** — embedded local encrypted keys (recommended; simplest, frictionless, still non-custodial because local) vs connect-external-wallet (MetaMask/WalletConnect — "keys never touched by the app") vs hardware-wallet signing. → **embedded local first**; external/hardware as fast-follows.
2. **Open-source the reference impl?** — flagged (§7).
3. **Lightning** — fast-follow; LDK-embedded vs connect-a-node is its own design.
4. **Base L2 for USDC** — chosen for low fees; revisit if a cheaper/more-accessible stablecoin rail is better for "everyone."

---

*The protocol aims to stay self-custodial, local-first, data-minimizing,
pass-through-fee, and open. Everyone pays everyone. The reference
implementation begins with the shipped slice above.*
