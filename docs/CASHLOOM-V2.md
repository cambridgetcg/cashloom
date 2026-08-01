# CashLoom v2: the operatorless payment playground

Status: implementation contract for the v2 foundation and first BTC execution
slice, 2026-07-31.

CashLoom v2 is a signed-record payment protocol with a sovereign reference
node. It is not a hosted payment service. A payer and payee must be able to
exchange and verify the protocol records without a hosted CashLoom account, a
CashLoom-operated database, or access to `cashloom.io`.

## Non-negotiable boundary

- Protocol authority comes from self-certifying keys and exact signed records.
  Rail evidence needs a separate rail-specific verifier; the generic v2
  verifier authenticates only the issuer's evidence reference and assertion.
- `cashloom.io`, DNS, TLS, GitHub, package registries, relays, RPC endpoints,
  indexers, and processor APIs are replaceable transport or distribution
  edges. None is a CashLoom identity authority.
- A sovereign node keeps keys and records local and chooses policy locally.
  Exact non-secret policy bytes are embedded in signed consent for replayable
  verification; no policy service or registry is required.
- A relay can deliver bytes but cannot authorize a payment or prove
  settlement.
- A processor can prove the state of its own operation. It cannot rewrite the
  payer's signed intent.
- Fiat adapters remain optional and user-operated. The CashLoom project does
  not supply a shared processor account, receive customer funds, or become the
  merchant of record.

Losing `cashloom.io` may make discovery less convenient. It must not make a
valid record unverifiable or stop two nodes that already know each other's
doors from paying.

## Authority map

| Claim | Authority |
|---|---|
| “These are my offered payment terms” | payee's protocol key |
| “I accept exactly those terms within this exposure” | payer's protocol key |
| “This intent fits this Agent Wallet capability” | the local wallet host and its retained Agent Wallet evidence |
| “These exact bytes were committed for execution” | the executing sovereign node |
| “These bytes were submitted” | the submitting node plus the rail operation identifier |
| “I observed this settlement outcome and reference this evidence” | settlement-receipt issuer; generic v2 verification does not authenticate the referenced chain/provider evidence |
| “This asset on this rail has these trust properties” | manifest issuer; the local node still decides whether to trust that issuer and permit the asset |
| “Send to this key at this network location” | signed descriptor plus the node-key fingerprint and exact transport origin the caller selected together out of band |

No discovery listing, HTTP response, human-readable alias, email address,
company name, or CashLoom account is authority for any row above.

## Record chain

The complete v2 direction is:

```text
NodeDescriptor

PaymentRequest
  -> PaymentIntent
  -> ExecutionCommitment
  -> SubmissionReceipt
  -> SettlementReceipt  (mandatory `issuer_assertion_only` scope)

AssetTrustManifest  (an independently signed assertion consumed by local policy)
```

Every record is:

- closed and size-bounded;
- canonicalized before hashing;
- domain-separated before signing;
- signed with Ed25519 in this version;
- content-addressed by a SHA-256 record identifier;
- bound to an issuer key fingerprint, audience, nonce, creation time,
  expiration, disclosure class, and exact parent record identifiers; and
- immutable after signing.

Payment consent also binds the rail, destination, exact asset-trust manifest
record and manifest-authority pin, and the exact local policy bytes plus their
content hash. A friendly policy label is never authority. Given the referenced
manifest, `verifyV2AssetTrustBinding` replays the signature, authority, rail,
asset, policy hash, and acceptance decision without a registry. A public
request must bind a publicly retrievable manifest; private payer manifest
evidence can remain private.

Protocol records contain no dedicated fields for a legal name, email address,
company, CashLoom username, or centrally allocated identity. A closed schema
cannot stop a user from putting identifying data into an opaque rail
coordinate or operation identifier; public requests are public. A stable
public key is pseudonymous, not anonymous, and account addresses plus
public-chain settlement remain linkable.

`PaymentIntent.fee_limit_scope` is fixed to
`total_fee_asset_exposure`; `max_fee_atomic` is therefore the payer's total
fee-asset exposure ceiling for the operation, not an RPC estimate and not an
L2-only subtotal. An
execution adapter must prove that the exact unsigned payload cannot exceed it
before CashLoom may create an `ExecutionCommitment`. When the payment asset and
fee asset are the same, total sender exposure is
`amount_atomic + max_fee_atomic`; otherwise the two CAIP-19 assets remain
separate limits.

## Storage and projections

The sovereign node stores canonical records append-only. Mutable UI and ledger
views are projections, not the source of signed consent.

- A duplicate delivery of identical canonical bytes is idempotent.
- Reuse of one issuer nonce for different bytes is refused.
- One payer key may create only one intent for a request; different payer keys
  may still answer a public request.
- A child whose parent is absent or has the wrong kind is refused rather than
  silently queued as valid.
- Competing execution commitments or receipts for the same immediate parent
  are refused atomically; byte-identical redelivery remains idempotent.
- Existing v1 rows remain visible as legacy local evidence. CashLoom never
  invents signatures for historical rows.
- Private records are available through the unlocked local API only. Public
  retrieval serves only records that explicitly carry a public disclosure
  class.
- The data directory is tightened to mode `0700` and SQLite database/WAL/SHM
  files to `0600`; startup fails rather than accepting permissive local
  storage.

## Portable Pay Links

The first human handoff is a self-contained, canonical JSON file rather than a
CashLoom URL:

```text
merchant node
  -> public .cashloom-pay
  -> payer verifies and signs
  -> private .cashloom-accept
  -> merchant verifies and imports evidence
```

A `.cashloom-pay` bundle carries exactly one public node descriptor, public
Bitcoin-mainnet asset-trust manifest, public payment request, and a small
signed-purpose preimage with an optional public note. The recipient can inspect
the destination, satoshi amount, expiry, merchant key fingerprint, signatures,
record links, and asset policy entirely offline. The carrier is capped at
64 KiB, must be exact canonical UTF-8 JSON, and permits neither remote fetches
nor hidden executable instructions.

Accepting creates a separate `.cashloom-accept` bundle. It embeds the complete
verified offer plus a fresh payer-signed private asset-trust manifest addressed
to the merchant key and a private payment intent referencing the exact request.
Merchant-side acceptance inspection and import always pin that audience to the
merchant node's local key. Public request inspection is first-contact unless
the payer supplies a merchant-key fingerprint obtained through another path.
The file is sensitive plaintext because it links the payer protocol key and
source Bitcoin address; share it only with the intended merchant and do not
publish it, upload it to a cloud preview, or treat a clipboard as private
storage.

Both artifacts are consent evidence, not a transaction, rail/provider
authorization, balance reservation, settlement proof, invoice-paid signal, or
instruction to an execution adapter. Creating, inspecting, accepting, and
importing them moves no money and performs no external, counterparty,
processor, relay, or CashLoom network fetch; the browser still talks to its own
loopback sovereign node. Exact redelivery is idempotent; a payer cannot silently
replace already-signed acceptance terms for the same request.

### Payer-local Bitcoin execution

Execution is a separate local action, not a property of either portable file.
Only the payer node that locally authored the active `PaymentIntent` may name
that record to the adapter. A carrier bundle ID, merchant-imported copy, public
alias, hosted CashLoom account, or company identity is never execution
authority.

The first adapter uses three deliberately distinct moments:

```text
accept locally       -> signed consent evidence; no UTXO reservation
prepare review       -> exact PSBT + fee + local reservation; no signature
Send ... BTC now     -> ExecutionCommitment + one sign/broadcast attempt
```

Prepare requires an active local BTC account whose vault key derives the exact
`source_account` in the intent. It queries the node's configured Esplora
service, so that service can observe the public source-address lookup. It then
stores one append-only binding from the intent to the payment, account,
reservation, canonical unsigned PSBT v0 bytes, byte hash, exact network fee,
and short expiry in the same transaction as the quote. The review is derived
from that stored state and discloses amount, fee ceiling, exact fee, total,
source, destination, network, and the earlier of quote/intent expiry. It never
returns the PSBT or coin-selection detail through HTTP.

Final confirmation names only the payment and content-addressed review. The
node rechecks the active local intent, account/source match, local asset policy,
expiry, fee ceiling, stored PSBT bytes and hash, and a freshly keyless
recompilation. It creates or exactly reuses one private signed
`ExecutionCommitment`, then atomically advances the payment from `quoted` to
`confirmed`. The BTC sender recompiles and compares the same PSBT again before
the vault may reveal the private key. A generic `/api/pay/confirm` call cannot
claim a bound payment; concurrent or repeated confirmations cannot sign it a
second time. An unanswered or non-success response from the untrusted
broadcast endpoint stays sticky and must be reconciled by its locally persisted
transaction ID rather than retried.

The session-gated status door accepts only that exact payment/review pair and
reads durable local state without compiling, contacting the indexer, accessing
a private key, signing, or broadcasting. It reports an unclaimed active review,
a currently not-confirmable state, or the conservative stored outcome, together
with the locally bound intent ID. The Pay Links UI keeps only the pair of opaque
payment/review IDs in the current tab's session storage so a refresh can recover
the last exact payment; it keeps no key, address, amount, intent, or portable
bundle there. An unchecked, not-confirmable, or ambiguous marker blocks a
different preparation in that tab until it is reconciled or explicitly
forgotten. An active unclaimed marker can resume only the same intent, through
the same one-time compare-and-swap confirmation gate. Forgetting the tab marker
does not erase durable node state and is not proof of non-submission.

For every claimed row, recovery also requires the exact locally signed
`ExecutionCommitment`; every persisted txid must equal the legacy transaction
ID derived keylessly from the binding's canonical unsigned PSBT. This detects
inconsistent local state, but it remains an operational report from this node,
not independent proof that a peer accepted the broadcast or that Bitcoin
confirmed it. Submission receipts and rail-authenticated settlement evidence
remain future protocol work.

This is distributed authority, not anonymity. Each participant can run an
independent node and exchange verifiable bytes without `cashloom.io`; Bitcoin
settlement and the selected Esplora endpoint are still observable external
dependencies. Users can replace that endpoint and a later node adapter can
self-host it, but this release does not bundle a Bitcoin full node or claim
independent chain verification.

The underlying execution-capable `PaymentIntent` keeps its deliberately short
five-minute default validity (ten-minute protocol maximum). After that window,
the `.cashloom-accept` remains verifiable and importable as historical signed
evidence, and the projection marks the intent inactive. An expired intent
cannot authorize a later execution commitment. Fresh executable consent needs
a new merchant request; the historical intent is never rewritten or silently
renewed.

The first friendly profile is deliberately Bitcoin mainnet only. It validates
mainnet destinations and canonical satoshi amounts and applies the local
fail-closed L1 asset policy. This does not make Bitcoin activity anonymous:
addresses and later public-chain settlement remain linkable.

A valid first-contact signature proves that one self-certifying key made a
coherent offer; it does not prove a legal name, company, account, or the
counterparty the user intended. A previously exchanged merchant-key
fingerprint can raise this to a matched-key check without introducing a
registry.

The payer's `source_account` is a signed declaration with Bitcoin-mainnet
syntax. It does not prove control of that Bitcoin private key, available
balance, reservation, or ability to pay. A stable protocol key and reused
Bitcoin addresses can correlate separate artifacts and may become identifying
when shared through an identified channel. Avoiding a central account is not
anonymity; fresh receive/source addresses and carefully chosen handoff channels
reduce some correlation, while public-chain settlement remains observable.

The UI supports paste and explicit `.cashloom-pay` / `.cashloom-accept` file
handoff. A general single-QR profile is not claimed yet: realistic
self-contained bundles exceed robust high-error-correction QR capacity.
Compression or multipart QR needs a separately bounded, canonical profile that
rejects decompression bombs and trailing compressed bytes.

## Discovery and delivery

A node may publish a signed descriptor at:

```text
GET /.well-known/cashloom/v2
```

Records may be delivered and public records retrieved at:

```text
POST /v2/records
GET  /v2/records/{sha256}
```

The same signed descriptor or record may instead arrive through a local file,
direct handoff, encrypted relay, content-addressed mirror, or a future bounded
QR profile. Consumers verify the record, not the carrier.

A self-signature proves continuity with a key; it does not tell a first-time
caller whose key or network location they intended to reach. Direct transport
therefore requires both an expected node-key fingerprint and exact transport
origin supplied together by an invoice, QR, local contact, or another
user-chosen trust path. The origin is an explicit caller-selected channel pin,
not a fact proved by the descriptor signature. A copied valid descriptor on an
attacker origin cannot redirect private bytes. DNS can locate bytes but is
never silently promoted into protocol identity authority.

The first implementation mounts these doors only on the sovereign process,
whose safe default is `127.0.0.1`. It does not add them to CashLoom's hosted
info-only process. Publishing a sovereign node later requires a separate,
narrow ingress that exposes only the three v2 public routes—not the vault,
local API, UI, metadata, or ledger—and a reviewed admission/anti-DoS policy.
The foundation's bounded append-only remote quota is a safety brake, not
production Sybil resistance.

`postV2Record` sends one canonical payload once and accepts success only when
the pinned origin returns a canonical acknowledgement for that exact record
ID (`201/inserted:true` or idempotent `200/inserted:false`). It does not prove
that an arbitrary caller persisted its own outbound record first. A future
outbound coordinator must persist before calling it and must resend only
identical bytes. Once a provider operation exists, reconciliation stays with
that provider.

## KARMA is scoped evidence, not reputation authority

The KARMA slice adds `cashloom/karma-observation/v2` as an independently
signed root. Its payload says only that one self-certifying issuer observed a
closed, count-valued event. It cannot name a legal identity, declare guilt or
intent, assign account standing, request punishment, or join a platform
blacklist. It is deliberately separate from service attestations and payment
settlement receipts.

The subject is a salted commitment bound to exactly one scope and local
context reference:

- `account.*` metrics require an `account-session` commitment;
- `custody.*` metrics require a `custody-handoff` commitment;
- `market.*` metrics require a `market-trade` commitment; and
- `payment.*` metrics require a `payment-attempt` commitment.

Publishers should create fresh commitment salt for each context. Reusing a
commitment or scope reference can correlate activity; the protocol does not
turn either value into a global identity. The local subject reference stays in
the commitment reveal and is not published in an observation.

`evaluateV2Karma` verifies every signed envelope, then replays one explicit
participant-selected policy at one explicit `evaluated_at` timestamp. Each
rule names its accepted issuer keys, metric, threshold, unique-issuer quorum,
maximum observation-window duration, evidence age, and advisory
recommendation. A five-event burst can therefore match a short-window rule
while the same count accumulated over a day does not. Metric namespaces are
bound to the policy scope, so evidence cannot be laundered between account,
custody, market, and payment contexts. Two participants may intentionally
select different issuer pins or thresholds and reach different
recommendations from the same signed bundle. Evidence age requires both the
window end and issuer observation time to be recent, so delaying or re-signing
a claim does not refresh old behaviour.

The evaluator returns the exact policy hash, bundle hash, supplied/in-scope/
out-of-scope record IDs, every replayed rule and its matching issuer/record
IDs, notices, and one `advisory-only` recommendation. Its capability fields
are always false for payment execution, account mutation, and settlement,
refund, or rerouting. No network client, evidence fetch, payment adapter,
account store, global score, or enforcement hook exists in the module.

Defensive bounds are explicit:

- repeated record IDs and re-signed duplicates of one issuer/subject/metric/
  window slot fail closed;
- separate windows from one issuer cannot amplify a unique-issuer quorum;
- observation windows are capped at 365 days, policies and records have
  canonical byte/array bounds, and an evaluation accepts at most 256 records;
- signatures prove who made a claim, not that the claim is true or that two
  accepted keys represent independent people; and
- false positives and poisoned telemetry remain possible, so operators should
  corroborate consequential recommendations locally and must not promote them
  automatically into account, financial, retaliation, or shared-blacklist
  actions. Evidence references contain only a content digest; labels, URLs,
  and other locators stay out of immutable records and travel out-of-band if
  a participant chooses to disclose them.

## Assets are trust-shaped

CAIP-19 identifies an asset; it does not prove that the asset is decentralized
or safe. An asset trust manifest is bound to one exact rail context and makes
material dependencies inspectable:

- settlement model, including a single sequencer or regulated provider;
- issuer powers such as minting, freezing, denylisting, pausing, or upgrading;
- bridge dependence;
- rail-level identity requirements;
- custody model;
- whether reads and broadcasts can be self-hosted; and
- what data leaves the sovereign node.

Manifests are signed assertions, not a blessed global registry or proof that
their factual claims are true. A local policy may reject unknown fields or any
trust property it does not accept. The built-in policy allows only disclosed
L1 proof-of-work/proof-of-stake settlement and rejects provider-attested
finality, regulated providers, issuer controls, single sequencers, bridges,
identity requirements, non-self-hostable access, and unapproved data egress.
Agent Wallet capabilities continue to bind exact CAIP-19 assets and atomic
amounts; CashLoom's local trust policy is an additional signed consent input,
never a silent rewrite of the capability.

## Centralized rails stay at the edge

Stripe, GoCardless, Adyen, banks, and card networks are centralized regulated
rails. They cannot be made identity-free by placing CashLoom in front of them.

The intended adapter contract is bring-your-own-provider:

- the merchant or marketplace operator supplies and owns its provider account;
- credentials and webhook secrets stay in that operator's sovereign node;
- provider metadata carries opaque record identifiers, not names, prompts, or
  agent memory;
- signed webhooks or equivalent provider evidence are verified locally; and
- disabling every provider adapter leaves the signed-record and native-crypto
  core usable.

The existing Stripe Connect sandbox remains evidence for an optional adapter.
It is not a promise that CashLoom will operate a Connect platform.

The path forward is therefore:

1. keep native/self-custody rails on the signed-record core;
2. make every centralized processor an optional, operator-owned adapter;
3. bind adapter idempotency metadata to v2 record IDs;
4. verify provider events locally, then reference their digest in an explicit
   issuer-only settlement attestation; and
5. never make the availability of one processor, RPC, relay, or CashLoom
   domain a prerequisite for verifying the consent chain.

## Shipped foundation, portable handoff, and first execution adapter

This slice ships:

1. strict signed-record primitives and mutation tests;
2. asset trust manifests and fail-closed local policy evaluation;
3. private-permission append-only SQLite storage with replay, parent-order,
   and exclusive execution-successor enforcement;
4. bounded public ingest and public-only retrieval;
5. session-gated local creation with vault-held protocol keys;
6. signed discovery;
7. direct two-node delivery;
8. canonical Bitcoin-mainnet `.cashloom-pay` and private
   `.cashloom-accept` handoff;
9. a session-gated Pay Links UI and closed local workflow routes;
10. offline two-node tests in which `cashloom.io` is unavailable; and
11. a payer-local BTC adapter that binds one active local intent to one exact
    PSBT review, creates its execution commitment only on a fresh final
    confirmation, inherits submit-once/ambiguous-outcome discipline, and exposes
    a read-only local recovery check for that exact payment/review pair.

This slice has one exclusive `settled` issuer assertion. Reversal and dispute
need a future signed adjustment/supersession schema; they are not represented
as contradictory sibling settlement receipts.

It does not claim:

- anonymous public-chain activity;
- decentralized Base sequencing or USDC issuance;
- live fiat collection;
- Agent Wallet execution binding;
- a bundled sovereign Bitcoin full node or independent chain-finality proof;
- v2 submission or settlement receipts for the BTC broadcast;
- same-byte BTC rebroadcast recovery after a crash before the first endpoint
  receives the already-signed transaction;
- private relay metadata protection;
- generic authentication of settlement evidence or chain finality; or
- a production internet-facing sovereign node.

Those are later rides. This slice pours the concrete.
