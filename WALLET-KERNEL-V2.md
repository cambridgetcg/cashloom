# CashLoom Wallet Kernel v2

> Status: implemented backend kernel. Live outbound rails are Base ETH, Base
> USDC, and Bitcoin mainnet P2WPKH. Other request types and custody modes in
> this document are extension contracts, not claims of live execution support.

Wallet Kernel v2 is the asset-qualified, authorization-bound core beneath the
local CashLoom node. It keeps the simple public rite—quote, inspect, confirm—
while making every signing decision durable, replay-safe, and reconcilable.

## The kernel boundary

```text
account + asset position
        │
        ▼
canonical intent ──► quote + simulation ──► resource reservation
        │                                      │
        └──────── intent hash ─────────────────┤
                                               ▼
policy / human or agent authorization ──► prepared sign request
                                               │
                                  request hash + one-time approval
                                               │
                                               ▼
                                  isolated signer / local vault
                                               │
                                  durable signed wire envelope
                                               │
                                               ▼
                                      submit ──► observe
                                                  │
                                                  ▼
                                      reconcile + journal + receipt
```

The critical boundary is between preparation and signing. The signer never
accepts an arbitrary callback or opaque bytes with a loose approval. It receives
a typed request, recomputes its canonical request hash, checks a one-time
authorization bound to the intent, key, and request, reconstructs the
transaction internally, and returns only signed wire bytes.

## Identity and money

Wallet Kernel records economic identity explicitly instead of routing by a
display ticker such as `ETH` or `USDC`.

| Concept | Canonical form | Example |
|---|---|---|
| Chain | CAIP-2 | `eip155:8453` |
| Crypto account | CAIP-10 | `eip155:8453:0x…` |
| Crypto asset | CAIP-19 | `eip155:8453/erc20:0x…` |
| Fiat currency | ISO 4217 | `USD` |
| Position | account + asset | deterministic `PositionId` |
| Amount | canonical base-10 atomic string | wei, satoshi, cents; never `Number` |

An account, asset, destination, amount, and fee asset must be chain-consistent.
A direct transfer cannot silently cross chains; only an intent explicitly
labelled `bridge` may name a destination on another chain. Stable database IDs
cannot later be rebound to another chain, contract, decimal precision, account,
or custody mode.

Core domain code lives in [`sovereign/src/wallet/domain/`](sovereign/src/wallet/domain/):

- `identities.ts` — CAIP/ISO parsers and position identity.
- `money.ts` — exact signed and unsigned atomic values plus BigInt arithmetic.
- `intent.ts` — immutable `cashloom.payment-intent/1`, canonical JSON, SHA-256.
- `lifecycle.ts` — the allowed payment state graph.
- `signing.ts` — typed EVM, EIP-712, PSBT, and Solana request contracts.
- `custody.ts` — custody capabilities without pretending every mode is live.

## Lifecycle

The shared lifecycle is deliberately richer than `success | failure`:

```text
draft → validated → quoted/simulated → reserved → authorized → prepared
                                                        │
                                                        ├─ provider submit
                                                        └─ signed → submitted
                                                                     │
                                           accepted / pending / settled
                                                                     │
                                      ambiguous / replaced / reorged / dropped
```

Terminal refusals include `expired`, `declined`, `failed`, and `cancelled`.
Post-settlement evidence can produce `reversed`, `charged_back`, `refunded`, or
`reorged`. `ambiguous` never means “retry”: the node must observe or explicitly
rebroadcast the exact already-signed bytes.

The transition graph is enforced both by domain functions and by versioned
compare-and-set writes. An execution outcome cannot be inserted as the first
event in an intent's history.

## Signing and custody

The local vault implements the live self-custody signer:

- Argon2id (`64 MiB`, three passes) derives an AES-256-GCM master key.
- Sealed private keys live in SQLite; plaintext is opened only inside a signing
  call and the byte buffers are cleared afterward where JavaScript permits.
- There is no `revealForSigning` or arbitrary private-key callback.
- EVM and Bitcoin requests are reconstructed and validated inside the vault.
- A durable signing authorization is consumed only in the same SQLite
  transaction that appends its exact signed artifact.
- The signed transaction ID and bounded wire envelope are append-only and are
  persisted before network submission.

The custody vocabulary also describes `watch_only`, `external_signer`,
`smart_account`, `managed_mpc`, and `regulated_fiat_provider`. Those are adapter
contracts. They do not imply that CashLoom currently operates an MPC service,
bank, card processor, or remote custodian.

Signer contracts are in [`sovereign/src/wallet/ports/signer.ts`](sovereign/src/wallet/ports/signer.ts).
Every `ApprovalProof` binds:

- the authorization ID;
- the canonical payment-intent hash;
- the canonical prepared-request hash;
- the approving actor and intended signer;
- issuance and expiry.

## Payment execution

The compatibility facade in [`sovereign/src/pay.ts`](sovereign/src/pay.ts)
projects the existing `quotePayment()` / `confirmPayment()` API into the v2
kernel:

1. Resolve the source account, CAIP chain/account/asset, vault key, and fee
   asset. Symbol-only routing is refused at the custody boundary.
2. Ask the selected rail for a quote and exact reservation claims.
3. Persist the canonical intent, quote, expiry, resource reservations, and
   immutable quote fingerprint in one SQLite transaction.
4. On confirm, recompute the intent and prepared-request hashes from persisted
   data. Any destination, amount, fee, calldata, coin-selection, nonce, chain,
   asset, or key substitution fails before signing.
5. Atomically claim the payment, consume agent authority when applicable, and
   create the one-shot signer authorization plus prepared execution. Resource
   reservations remain exclusively active at this point.
6. Sign inside the vault. In one SQLite commit, append the signed bytes and
   transaction ID, consume the one-shot signer authorization, and consume every
   nonce/UTXO reservation. Link that immutable artifact to the execution before
   RPC submission.
7. Record an accepted, ambiguous, failed, or settled observation without
   silently retrying. Once bytes exist, transport failures and non-idempotent
   node rejections remain ambiguous until reconciliation proves otherwise.
8. Post exact, per-asset balanced journal entries and immutable receipts.

### Live rail adapters

| Rail | Live scope | Important behavior |
|---|---|---|
| Base | ETH and native Base USDC; EIP-1559 | Exact nonce, gas, calldata, recovered signer, and RPC-returned hash verification. The quote separates the hard EIP-1559 execution cap from block-pinned L1 data/security and operator estimates; their total is not called a hard maximum. |
| Bitcoin | Mainnet P2WPKH | Confirmed UTXOs only, exact coin selection, dust and fee-rate guards, anti-fee-sniping locktime, deterministic transaction reconstruction, and cryptographic witness/`SIGHASH_ALL` verification on recovery. |

Both adapters implement exact-byte `resumeBroadcast()`. If a process stopped
after the owner-confirmed prepared authorization was committed but before a
signed artifact existed, recovery may finish that exact still-active signing
request once. It never creates a quote, authorization, nonce, UTXO selection,
destination, or fee. After the artifact exists, recovery can only link or
rebroadcast those immutable bytes and never signs again. A consumed nonce or
UTXO remains claimed until append-only reconciliation evidence proves a dropped
or replaced execution and explicitly proves the resource reusable.

### Base observation and settlement

Base payments have an evidence-only truth loop in
[`sovereign/src/wallet/adapters/base-observer.ts`](sovereign/src/wallet/adapters/base-observer.ts)
and [`sovereign/src/wallet/base-reconciler.ts`](sovereign/src/wallet/base-reconciler.ts):

1. The observer starts from the immutable locally signed type-2 transaction;
   no caller may submit an address, fee, block, or outcome as evidence.
2. It decodes the bytes, recovers the signer, and re-proves the exact chain,
   nonce, target, value, calldata, gas caps, beneficiary, and asset. For USDC,
   it also requires the fixed Circle contract and one exact, non-removed
   `Transfer` log from the signer to the approved beneficiary.
3. Two fixed, independently named Base RPC providers must agree on the exact
   transaction, receipt, canonical block hash/number/timestamp, execution
   result, and fee components. Provider URLs and errors never enter receipts.
4. `latest`, `safe`, and `finalized` are explicit Base/OP Stack tags. Unsafe
   and safe sightings remain pending evidence. Only two-provider finalized
   consensus can settle the wallet lifecycle or post economic journals.
5. Exact final fee is `gasUsed × effectiveGasPrice + l1Fee + operatorFee`, all
   as decimal strings. A fee above the quoted estimate is recorded and flagged;
   chain truth is never rejected to make the quote look right.
6. A finalized revert restores the provisional transfer posting but retains
   the exact fee, marks the execution/intent failed, and keeps the nonce
   consumed. A missing receipt, timeout, split view, or nonce advance never
   proves a drop and never releases a nonce.

Provider sightings, consensus, normalized observation, receipt,
reconciliation link, journals, and lifecycle transitions are append-only or
committed in one SQLite transaction. Repeated checks are idempotent. Competing
finalized consensus is surfaced as `conflicted` and cannot rewrite the first
posted economic event.

## Agents and `agent-wallet/0.1`

CashLoom uses `@agenttool/wallet` signed descriptor, capability, transaction
intent, and simulation records. Caller-provided usage counters are ignored;
CashLoom derives and reserves grant usage in its own SQLite transaction.

The agent path is:

1. The owner creates a short-lived delegated vault session bound to one exact
   wallet descriptor, descriptor authority, capability record, grant, delegate
   key, and an allowlist of trusted simulation-adapter keys. Internally valid
   but self-issued records are not authority.
2. The agent may read accounts, request a quote, and ask CashLoom to authorize
   a signed intent. It cannot receive `payments:confirm`, key-management, or
   account-write authority.
3. CashLoom verifies record signatures, grant/revocation state, source account,
   economic beneficiary, asset, amount, exact calldata, simulation result, and
   expiry. Unbound capability decisions can be recorded once with the minimum
   expiry across capability, intent, and simulation.
4. A payment-bound Base request stops at proposal review; neither
   `/api/pay/agent/authorize` nor `/api/pay/agent/confirm` can turn it into a
   signing authorization.

Base has one unavoidable standards wrinkle: only the EIP-1559 execution term
is transaction-capped. The L1 data/security and operator terms are estimates
from the Base GasPriceOracle at a named block and can change before inclusion.
An autonomous Base agent therefore remains proposal-only. The agent-wallet
standard treats signed `max_fee` as a hard bound, while Base's L1
data/security and operator terms are not transaction-hard-capped. A local
owner session must use the ordinary two-step quote/confirm boundary; CashLoom
will not reinterpret an estimate or a host-side toggle as broader delegate
authority. Human confirmation keeps the same explicit disclosure without
pretending a protocol estimate is a cap.

For Base USDC, the signed call target is the Circle token contract while the
economic payee comes from the verified transfer effect. The host independently
checks the ERC-20 calldata, so permission for the contract alone cannot become
permission to choose an arbitrary beneficiary.

Human owner sessions retain the deliberate ability to confirm their own quote
without an agent capability. Agent sessions cannot use that human route.

## Fiat and other non-crypto wallets

The kernel models fiat without pretending CashLoom is a bank or transmitter:

- fiat assets use ISO 4217 and provider-qualified opaque account references;
- `regulated_fiat_provider` cannot sign locally;
- a fiat `Executor` prepares a provider-authorized operation, preserving the
  same intent, approval, idempotency, observation, reconciliation, and journal
  contracts;
- connectors remain read-only `Observer`s; an execution adapter is a separate,
  more privileged module;
- card reversals, chargebacks, refunds, bank pending states, and webhook
  idempotency fit the existing lifecycle and inbox/outbox tables.

No fiat execution adapter is live in v2. A future adapter must integrate a
licensed provider and preserve the non-custodial/legal boundary described in
[`FIAT-ROUTE.md`](FIAT-ROUTE.md).

## Ports

The rail-neutral interfaces live in [`sovereign/src/wallet/ports/`](sovereign/src/wallet/ports/):

| Port | Responsibility |
|---|---|
| `Observer` | Read balances and append-only activity from a rail. Never move money. |
| `Signer` | Sign one typed, hash-bound request under a one-time approval. |
| `Executor` | Prepare, submit, and check an execution; declare ambiguity honestly. |
| `Reconciler` | Match observations to executions and propose evidence-backed transitions. |

This separation is what lets a hardware wallet, WalletConnect session,
passkey-backed smart account, bank-payment provider, or Solana adapter be added
without teaching a balance connector how to move funds.

## Storage

Wallet Kernel tables use the `wk_*` namespace and are installed additively into
the existing sovereign SQLite file. Important groups are:

- identity: wallets, assets, accounts, positions, connections, signers;
- decision: intents, append-only events, idempotency keys, quotes, simulations,
  authorizations;
- execution: resource reservations, append-only signed artifacts, executions,
  receipts;
- accounting: ledger accounts, journal entries, exact postings;
- truth: provider chain sightings, finalized consensus, observations,
  reconciliation links, receipts, and reservation-resolution evidence;
- delivery: webhook inbox and outbox.

Bindings and evidence are protected with SQLite constraints and triggers, not
only TypeScript conventions. Exact amounts remain decimal `TEXT`, because
SQLite integer aggregation and JavaScript `Number` cannot safely represent
18-decimal assets.

Pre-release databases containing two live/consumed claims for the same nonce
or UTXO are not guessed through migration. Startup stops with the exact
account, claim kind, and resource key; the operator must quarantine the file,
reconcile which execution owns the resource from chain evidence, and resolve
the conflicting rows before retrying. This is deliberately an availability
failure instead of a possible double-spend.

## Local API

The custody node is loopback-only: it accepts `localhost`, `127.0.0.1`, or
`::1` and refuses to start on a LAN/public bind. Private routes require scoped,
expiring bearer sessions and reject untrusted Host/Origin values before vault
initialization or unlock. Host and Origin checks are DNS-rebinding controls,
not remote authentication; a future remote mode needs an authenticated TLS
gateway, bootstrap ceremony, and rate limiting rather than another allowlist.

| Route | Required authority |
|---|---|
| `POST /api/vault/init`, `POST /api/vault/unlock` | passphrase ceremony |
| `POST /api/vault/sessions` | `keys:manage`; creates restricted agent session |
| `POST /api/pay/quote` | `payments:quote` |
| `POST /api/pay/confirm` | human `payments:confirm` |
| `POST /api/pay/agent/authorize` | `agent:authorize` |
| `POST /api/pay/agent/confirm` | bound delegated agent + `agent:authorize` |
| `POST /api/pay/recover` | human `payments:confirm`; finish one already-authorized exact request, then exact signed bytes only |
| `GET /api/wallet/v2/positions` | `accounts:read` |
| `GET /api/wallet/v2/intents/:id` | `accounts:read`; signed payload redacted |
| `POST /api/wallet/v2/intents/:id/reconcile` | `accounts:write`; explicit Base evidence check, never a send/retry |

New private routes fail closed until added to the explicit scope map.

## Standards and implementation map

| Standard / convention | Use in v2 |
|---|---|
| CAIP-2 / CAIP-10 / CAIP-19 | Chain, account, and asset identity |
| ISO 4217 | Fiat currency identity |
| EIP-1559 | Live Base transaction construction/signing |
| OP Stack `latest` / `safe` / `finalized` | Base inclusion milestones; only `finalized` settles |
| Base GasPriceOracle predeploy | Quote L1/operator estimates and reconcile the exact operator fee at the receipt block |
| ERC-20 `Transfer` event | Exact native Base USDC beneficiary/amount effect proof |
| EIP-712 | Typed-request schema; adapter not yet live |
| BIP-174 / BIP-370 | PSBT request schema; current live Bitcoin adapter reconstructs a constrained P2WPKH transaction internally |
| Solana transaction bytes | Typed-request schema; adapter not yet live |
| RFC 8785-style canonical JSON | Deterministic intent and request hashing |
| SHA-256 | Domain-separated intent/request/evidence fingerprints |
| `agent-wallet/0.1` | Signed agent descriptor/capability/intent/simulation records |
| SQLite transactions + CAS | Atomic claims, idempotency, lifecycle, audit evidence |

## Extension checklist

A new wallet or rail is not complete until it has all of these:

- canonical chain/account/asset identity and decimal precision;
- a read-only observer distinct from its executor;
- deterministic quote and complete typed preparation data;
- explicit reservation semantics for nonces, UTXOs, balances, or provider keys;
- intent and request hash binding at the signer;
- durable signed/provider-authorized state before external submission;
- defined accepted, ambiguous, replaced, dropped, reorged, and settlement paths;
- evidence-bound reconciliation and exact balanced postings;
- credential-safe errors and receipts;
- networkless unit tests for mutation, replay, concurrency, and crash recovery.

Likely next modules are a hardware/external signer adapter, ERC-4337 smart
accounts with passkeys, WalletConnect sessions, an opt-in bounded background
Base check scheduler, Lightning, Solana, and one
licensed fiat-provider executor. Each should reuse this kernel rather than add
another symbol-routed payment path.
