# CashLoom as the KINGDOM payment layer

Status: architecture contract for the current sovereign node, 2026-07-30.

## Decision

CashLoom should be the KINGDOM's payment **control and execution protocol**,
not a pooled wallet or an unlicensed shadow ledger.

- `cashloom.io` is the public door: documentation, discovery, compatibility
  metadata, and status. It does not receive private keys or user funds.
- A CashLoom sovereign node owns local quotes, policy, encrypted signing keys,
  durable operation state, and reconciliation.
- Licensed payment processors own fiat onboarding, card/bank collection,
  safeguarding, disputes, and payouts under their contracts.
- A facilitator may verify and relay a payer-signed onchain authorization, but
  it must not gain authority to alter the payer, payee, asset, or amount.

This shape lets CashLoom unify the experience without pretending all rails have
the same custody, finality, reversibility, compliance, or fee model.

## One canonical payment envelope

Every rail adapter should consume the same semantic envelope before producing
rail-specific bytes:

```ts
interface KingdomPaymentIntent {
  schema: "kingdom.payment/v1";
  intentId: string;          // globally unique semantic operation
  idempotencyKey: string;    // stable across transport retries
  payer: string;             // CAIP-10 account or provider account reference
  payee: string;             // CAIP-10 account or provider destination
  asset: string;             // CAIP-19 for crypto; ISO-4217-prefixed id for fiat
  amountAtomic: string;      // positive integer string
  maxFeeAtomic: string;
  purpose: string;
  expiresAt: string;
  capabilityRecordId?: string;
  simulationRecordId?: string;
}
```

The envelope is not itself signing authority. A rail adapter must bind it to
the exact provider request or chain-native unsigned bytes and prove that
binding again immediately before signing or submission.

The durable lifecycle is forward-only:

```text
quoted
  → reserved
  → signing
  → signed
  → submitting
  → submitted
  → settled

terminal before egress: rejected_pre_submit | expired
sticky after egress:    submission_unknown
later provider events:  reversed | disputed
```

`submission_unknown` is never converted to a clean failure merely because a
timeout occurred or a lookup returned no result. Reconciliation must use the
persisted provider operation ID or locally computed transaction hash.

## AgentTool and asset modules

`@agenttool/wallet` is the policy primitive, not the payment engine. CashLoom
currently:

- verifies descriptor, capability, intent, and simulation signatures;
- requires the simulation adapter key ID to be locally trusted;
- derives cumulative spend, record replay, and signed intent-nonce state from
  local SQLite;
- repeats the capability check inside an atomic reservation;
- returns a vault-signed `authorized-not-bound` attestation.

It intentionally does **not** let that attestation call `confirmPayment()`.
The next adapter slice must:

1. decode the chain-native intent payload;
2. bind chain, source account, destination, asset, amount, nonce, calldata, and
   maximum fee to one CashLoom quote;
3. re-check and bind the existing durable signed-intent-nonce reservation to
   the EVM account-nonce reservation (or a UTXO reservation) at sign time;
4. verify the exact signed bytes and source account;
5. persist the signed payload hash before network egress; and
6. make the CashLoom confirmation consume that one authorization exactly once.

Until those checks exist, authorization evidence and payment execution stay
separate. This is a deliberate refusal to turn a valid capability into vague
signing power.

### x402

AgentTool's current custom-facilitator client expects x402 v2-compatible
`POST /verify` and `POST /settle` endpoints, but sends no origin-scoped
credential to a custom URL. Do not point production AgentTool traffic at a
private CashLoom facilitator yet.

The safe sequence is:

1. use the existing authenticated CDP facilitator path for the first production
   x402 seller flow;
2. add a separate AgentTool change for an origin-bound custom-facilitator
   credential plus a real readiness handshake;
3. implement a self-hostable CashLoom x402 v2 adapter with strict schemas,
   request authentication, rate limits, idempotency, signed-payload persistence,
   and sticky settlement ambiguity; then
4. canary on Base Sepolia before any mainnet allowlist.

x402 v2 uses CAIP-2 network identifiers and the `PAYMENT-SIGNATURE`,
`PAYMENT-REQUIRED`, and `PAYMENT-RESPONSE` headers. A facilitator verifies and
settles payer-signed payloads; it is not a substitute for CashLoom's capability
and budget reservation. See the
[official x402 v2 migration guide](https://docs.cdp.coinbase.com/x402/migration-guide),
[facilitator role](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator),
and [settle API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/settle-payment).

## Existing processor path

### 1. Stripe Connect first for fiat

Start with connected accounts and Stripe-hosted Checkout or Payment Links.
Prefer **direct charges** when one KINGDOM citizen sells directly to one buyer:
the charge is created on the connected account, and Stripe documents how the
connected account can carry its own payment fees, refunds, and disputes. This
keeps CashLoom out of the funds flow more clearly than collecting on a platform
balance and transferring onward.

Use destination charges only when the KINGDOM intentionally acts as the
customer-facing platform and accepts the corresponding fee, refund, dispute,
and negative-balance responsibilities. Defer separate charges and transfers
until a real multi-party cart requires them; Stripe describes that path as more
complex and platform-liable.

Primary references:

- [Stripe Connect charge types](https://docs.stripe.com/connect/charges)
- [Direct charges with hosted Checkout](https://docs.stripe.com/connect/direct-charges)
- [Connect Payment Links](https://docs.stripe.com/connect/payment-links)
- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)

Implementation rules:

- add a new outbound `PaymentSender`; never add movement to the read-only
  Stripe connector;
- use a separate, least-authority write credential reference;
- send one provider idempotency key derived from the CashLoom intent ID;
- persist the PaymentIntent/Checkout Session ID before returning;
- ingest signed webhooks into a deduplicated append-only inbox before changing
  payment state; and
- reconcile asynchronous methods from provider events, not browser redirects.

### 2. GoCardless for mandates and recurring bank collection

The existing GoCardless Bank Account Data connector stays read-only. A future
bank-payment sender should use a separate GoCardless Billing Request/payment
credential and signed webhooks. GoCardless's current getting-started flow
creates a Billing Request so a customer can authorize a mandate before a
payment is created:
[GoCardless Billing Request quickstart](https://developer.gocardless.com/getting-started/send-your-first-api-request).

This is a good second fiat rail for UK/EU recurring collection, not a shortcut
for arbitrary instant payouts.

### 3. Adyen only when multi-party scale justifies it

Adyen for Platforms is the enterprise alternative when the KINGDOM needs
multi-party balance accounts, split instructions, broader acquiring, and
formal marketplace operations. Its model explicitly includes a platform
liable balance account and webhook-driven split reconciliation:
[Adyen split transactions](https://docs.adyen.com/marketplaces/split-transactions) and
[liable accounts](https://docs.adyen.com/marketplaces/manage-liable-accounts).
That is useful capability, but it is a larger compliance and operational
commitment than the first Stripe direct-charge slice.

## Regulatory guardrail

“Non-custodial” is an architecture property, not an automatic legal
classification. Do not ship a flow that receives customer money into a
CashLoom-controlled platform balance, controls onward transfers, or operates a
hosted payment service based only on the repository's wording.

The UK FCA specifically warns that an online marketplace may be providing a
payment service when it receives customer money before passing it to a seller,
including money received into an account with its acquirer, and recommends
independent legal/compliance advice:
[FCA marketplace payment-services guidance](https://www.fca.org.uk/firms/consider-if-you-provide-payment-services).
Provider underwriting, supported countries, merchant-of-record allocation,
refund/dispute liability, sanctions screening, tax reporting, and privacy
obligations must be fixed in the operating contract before a fiat production
launch.

## Release order

1. **Shipped:** EVM persist-before-submit, quote-bound fees, atomic
   confirmation, cross-process durable EVM account-nonce coordination, and
   durable Agent Wallet authorization evidence with signed intent-nonce
   replay protection.
2. **Next:** add a deliberately narrow Agent Wallet → CashLoom binding for a
   newly signed Base-mainnet EOA/native-ETH profile. It must re-check validity
   at sign time, bind the already-reserved signed intent nonce, bind the
   actual quote fee, and decode/recover the exact EIP-1559 bytes before
   egress. A separate Sepolia adapter can canary that contract before live
   execution.
3. **Then:** implement Stripe Connect direct-charge Checkout in sandbox with
   signed webhook ingestion and idempotency tests.
4. **In parallel:** add AgentTool origin-scoped custom-facilitator auth; keep
   payouts hard-resting.
5. **Canary:** x402 v2 on Base Sepolia, then a tightly allowlisted mainnet
   facilitator only after threat review and operational/legal sign-off.
6. **Expand:** GoCardless mandates; Adyen only if multi-party platform
   requirements and liability justify it.

## Deployment boundary

The current `cashloom-api` Fly image runs `sovereign/src/info-server.ts`.
It does not import the vault, SQLite ledger, `pay()`, or payment senders.
Payment-only changes therefore require a pushed branch and CI, but **not** a
Fly deployment. Centralizing the sovereign node merely to make a deploy happen
would violate the architecture.
