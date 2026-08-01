# CashLoom custody mesh

> Status: protocol foundation, 2026-07-31. This document defines evidence
> vocabulary and authority boundaries. It is not a provider endorsement,
> insurance promise, payment licence, escrow agreement, or production release.

## Decision

CashLoom provides an open publication and evaluation protocol for physical
custody services. A shop, authenticator, carrier handoff point, dispute
resolver, or other service provider can publish a profile without asking
CashLoom or a marketplace for permission. Any participant can publish a
bounded attestation about that profile.

Publication proves only that a self-certifying key signed exact bytes.
Attestation proves only which key made an exact assertion. Neither proves that
the provider is legitimate, independent, insured, competent, solvent, or
honest.

CashLoom does not publish a global provider score, an approved list, a
`verified` badge, or a default trust policy. A trader chooses the evidence they
want to inspect, the issuers they care about, and the exact local policy they
apply. The result means only `this supplied bundle matches this policy`. The
protocol names that state `bundle_matches_policy` so an interface cannot
quietly shorten it to “trusted”.

## What registration means

A service creates an Ed25519 key locally, signs a service-profile record, and
publishes the canonical bytes to any number of sovereign nodes, direct peers,
or community mirrors. No CashLoom account, company number, legal name, hosted
login, or platform-issued identity is required.

Admission means only `schema valid + self-certifying key valid + signature
valid + content ID valid`. Public profiles can be mirrored. Targeted private
profiles can be shared directly; a public attestation may not depend on a
private profile. The current append-only store deliberately exposes no list
operation, so storage cannot silently become the canonical directory.

## Roles remain separate

```text
marketplace             creates the trade and presents choices
CashLoom                carries signed claims and evaluates caller policy
physical service node   handles or assesses an asset
settlement provider     holds, releases, refunds, or reverses money
resolver                decides a dispute under chosen terms
trader                   selects evidence, policy, providers, and risk
index or mirror          helps locate records; inclusion is not endorsement
```

A physical service claim and a regulated-funds-custody claim are different
claims. A profile cannot authorize payment release merely by declaring either
capability.

## No authoritative registry

The protocol has records, not a canonical directory. Records can move by file,
QR code, direct peer transport, a community mirror, a marketplace index, or a
future content-addressed network. An index says only that it knows where a
record can be retrieved.

Indexes may apply their own spam, safety, privacy, or content rules, but must
describe those as index policy. Hiding a record does not prove the provider is
fraudulent; listing it does not prove the provider is safe.

The hosted `cashloom.io` information surface is not the v2 authority or data
plane. A sovereign node verifies records locally.

## Provider profiles

A provider chooses how much to disclose. A valid profile may contain no
human-readable identity information. Optional claims can cover:

- display label and coarse service region;
- physical intake, local exchange, authentication, secure storage, dispatch,
  return inspection, or dispute-evidence capabilities;
- supported card games or asset classes;
- opening, contact, or private address-reveal methods;
- value limits, fees, handling terms, or liability-policy digests;
- insurance, bond, accreditation, equipment, or process assertions; and
- content-addressed evidence references.

Omission means `not disclosed`, not false. A public value is intentionally
mirrorable. A commitment hashes the claim type, value, and a secret random
128-bit nonce under a protocol-specific schema; hashing a low-entropy fact
without that secret salt is not private. The underlying reveal can be shared
selectively out of band. Evidence URLs are canonical, query-free HTTPS
locators, remain inert labels, and are never fetched automatically.

Every profile claim has self-asserted provenance. CashLoom validates its shape,
bounds, content identity, key and signature; it does not validate the external
fact.

## Participant attestations

Any key can make an attestation. Useful structured claims include:

- a premises visit was observed;
- custody intake or handoff occurred;
- an asset assessment agreed or disagreed with a later assessment;
- a trade completed, was disputed, or was cancelled;
- a return was handled;
- loss or damage was reported; and
- a prior assertion is challenged or withdrawn.

Attestations classify their basis:

- `unlinked_assertion`: no protocol interaction reference;
- `claimed_interaction_reference`: the issuer names a content-addressed trade
  or custody digest;
- `claimed_evidence_references`: the issuer names one or more inert evidence
  digests.

The word `claimed` is deliberate: the base evaluator verifies neither the
referenced event nor the evidence material. Policies can require distinct
interaction digests and accepted evidence kinds, but colluding issuers can
still invent them. A later trade-evidence resolver must verify referenced
records separately. Free keys make raw counts and average stars easy to
manipulate. Consumers decide which issuer keys, claim types, interaction
references, recency, and evidence classes matter to them.

The first slice deliberately excludes unbounded public review text. Structured
claims reduce accidental personal-data publication and defamation/moderation
pressure without pretending that those risks disappear.

## Trader-selected policy

There is no built-in `safe shop` policy. A policy must be supplied explicitly
and is content-addressed so its friendly label cannot hide changed rules.

Example intent:

```text
require capability physical_intake
require the insurance claim to be public or commitment-disclosed
require two interaction-bound completion attestations
count only issuers selected by this trader
reject any selected-issuer loss challenge in the supplied evidence bundle
require one of the trader's accepted dispute-resolver key IDs
require a separate acceptance attestation from that resolver if desired
```

Evaluation returns its explicit time, exact policy hash, complete supplied
record-ID list, out-of-scope IDs, and a content hash of the whole evidence
bundle. A policy must choose either the exact current profile or all supplied
profiles signed by the same service key. History mode prevents a routine
profile refresh from silently shedding earlier attestations; it still cannot
discover records the caller or mirrors omitted.

Evaluation does not infer that the supplied bundle is complete, that selected
issuers are independent, or that a matching result transfers liability.
Signed mirror checkpoints and multi-mirror reconciliation are a future
optional completeness aid, never a global registry.

Interfaces should say:

- `self-published by <key>`;
- `asserted by <key>`;
- `linked to interaction <digest>`;
- `this supplied bundle matches your selected policy`; or
- `insufficient supplied evidence`.

They must not silently translate those facts into `CashLoom verified`,
`Cambridge approved`, `legitimate`, or a platform-global reputation score.

## Binding a provider to one trade

Discovery and vetting do not delegate custody. Before payment, buyer, seller,
and selected service node should sign or otherwise accept one immutable
custody agreement containing:

```text
trade commitment
provider key
exact profile record ID
service and fee snapshot hashes
handling and evidence requirements
accepted resolver and settlement provider
required custody-event signer(s)
release predicate
participant policy hash
```

A later profile update cannot rewrite that agreement. Exact premises can be
revealed privately for the trade rather than published in the profile.

Example release predicate:

```text
origin intake declared by the selected node
AND carrier handoff observed
AND destination identity match declared
AND inspection window elapsed
AND no open dispute
```

The settlement provider decides whether it accepts that predicate and remains
responsible for its regulated money role. A service profile never gains
payment authority merely by being discoverable.

## Threats that remain visible

- **Sybil attestations:** traders choose issuer roots; CashLoom does not turn
  account count into trust.
- **Collusion:** interaction linkage proves a reference exists, not that the
  parties are independent.
- **Curated bundles:** a caller or mirror can omit adverse evidence; a bundle
  match is not a claim that no other record exists.
- **Forked profiles:** conflicting signed publications must remain visible;
  an index must not silently choose the convenient branch.
- **Lost or rotated keys:** continuity needs explicit old-key/new-key evidence.
  Without it, reputation does not automatically move.
- **False insurance or regulatory claims:** they remain assertions until a
  trader or settlement provider checks acceptable evidence.
- **Index censorship or promotion:** users can consult other mirrors or direct
  records; ranking must expose its local policy.
- **Public-data permanence:** public signed records may be mirrored forever.
- **Physical fraud:** signatures identify declarants but cannot inspect a card.
- **Chargebacks:** card issuers are not bound by CashLoom custody evidence or
  internal dispute decisions.

## Implemented protocol boundary

The reusable slice now includes:

1. closed, bounded service-profile and attestation payloads;
2. salted disclosure commitments and self-certifying provider references;
3. content-addressed local trader policies;
4. signed v2 envelopes with exact profile-to-attestation linkage;
5. append-only known-ID storage that permits many independent attestations;
6. deterministic, history-aware evaluation whose only public path verifies
   every signature, record ID, authority, and supplied parent first; and
7. no network fetch, hosted registry, global score, default roots, payment
   release, KYC, insurance verification, or dispute judgment.

Direct transport already carries the generic records. Discoverable community
indexes, signed index checkpoints, key continuity/revocation, custody
agreements, verified trade/evidence resolvers, local projections, and the
CambridgeTCG due-diligence UI remain the next composition layers. None may
change who decides whom to trust.
