# cashloom.io product and authority boundary

cashloom.io is the public map for CashLoom. It is useful when it helps a person
understand, inspect, and run the protocol. It must remain optional to payment,
identity, recovery, and participant trust.

## The product now

| Door | Job | Authority |
|---|---|---|
| `cashloom.io` | Explain shipped capabilities, limits, safety, and source | None |
| `cashloom-api.fly.dev` | Serve public facts and the machine-readable capability contract | None |
| Source repository | Let anyone inspect, run, fork, and mirror the node | Chosen by the participant |
| `127.0.0.1:4747` | Operate the sovereign node and local dashboard | Participant's local vault and policy |
| `.cashloom-pay` | Carry a public signed Bitcoin request offline | Requester's signing key; no payment authority |
| `.cashloom-accept` | Carry private payer acceptance evidence offline | Payer's signing key; no payment finality |

The hosted site must not contain vault, key-generation, payment-confirmation,
escrow, refund, dispute, or marketplace mutation routes. It may link to a local
dashboard but must never proxy or embed it.

## Why source and dashboard come before an app download

The existing node and dashboard are real and auditable. A desktop download
would be friendlier, but it would also create new promises: cross-platform
asset embedding, code signing, release checksums, update integrity, optional
mirrors, atomic backup and tested restore, rollback, and crash recovery around
money egress. Until those are verified, the honest primary call to action is
**Run from source**, not **Download app**.

Bun can compile cross-platform standalone executables, so a checksummed GitHub
Release is the smallest likely next package. A desktop shell is the following
step if it remains a loopback wrapper and does not introduce a hosted account.

## Payment truth shown on the site

The site presents payment as an append-only sequence of narrower claims:

1. request;
2. acceptance;
3. execution commitment;
4. rail submission;
5. settlement under an explicit finality rule;
6. later adjustment, including refund, reversal, or chargeback.

No earlier stage is labelled paid or settled. A browser redirect is navigation,
not payment evidence. An ambiguous send outcome remains unknown and blocks a
replacement attempt until the exact local and rail evidence is reconciled.

## Markets, shops, escrow, and CambridgeTCG

CashLoom is infrastructure, not the authority that declares a shop legitimate.
A future provider profile can be self-issued; other participants can publish
signed attestations, evidence, or revocations; each node applies its own local
trust policy. Discovery services may list claims but must not issue a universal
CashLoom legitimacy score.

Escrow can later be performed by a chosen shop or third-party provider under
named terms. CashLoom should record the parties, policy digest, deadlines, and
evidence without becoming the custodian or dispute judge.

CambridgeTCG payment mutation remains blocked until its durable attempt ledger,
provider-derived idempotency, immutable provider binding, reconciled event
inbox, owned release SLA, and refund/chargeback adjustment lifecycle pass their
contract tests. Until then the website must not advertise a Cambridge payment
adapter, escrow protection, or marketplace checkout as live.

## Public-site acceptance checks

- The site names BTC and Base ETH/USDC as current local sends and labels Stripe,
  GoCardless, Agent Wallet execution, escrow, and desktop packaging honestly.
- The built static bundle contains no local vault or payment mutation endpoint.
- No analytics, remote fonts, fingerprinting, or hosted account is required.
- The machine capability endpoint and built page consume the same source
  schema. Because they deploy independently, each reports a deterministic
  content fingerprint that callers compare when exact parity matters.
- The hosted info process continues to return 404 for v2 and execution routes
  and never creates the sovereign database.
- The local UI clearly distinguishes loopback authority from cashloom.io,
  blocks sensitive access over non-loopback plain HTTP, and warns on remote
  HTTPS origins that CashLoom does not certify their ingress or device policy.
