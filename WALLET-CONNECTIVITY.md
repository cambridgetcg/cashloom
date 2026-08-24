# CashLoom wallet connectivity

> Status: verified integration foundation. The local node can parse, bind, and
> independently verify the contracts described here. External execution stays
> disabled until an owner completes the named deployment/provider policy and a
> coordinator atomically joins verification to the core Wallet Kernel artifact
> and authorization transaction.

Wallet connectivity is not a collection of SDK buttons. Every integration is
an adapter around the same durable Wallet Kernel decision:

```text
canonical intent + exact prepared request + one-use owner authorization
                              │
                              ▼
                  external interaction request
                              │
                 browser / device / provider
                              │
                              ▼
             independent local output verification
                              │
                              ▼
       atomic artifact + authorization + resource commitment
                              │
                              ▼
                   submit, observe, reconcile
```

The integration cannot change the account, chain, asset, beneficiary, amount,
calldata, nonce, fee fields, provider account, or expiry after approval. Raw
pairing topics, OAuth tokens, PKCE verifiers, WebAuthn challenges, device
APDUs/PINs, provider credentials, and webhook bodies never enter the durable
integration ledger.

## Two execution lanes

External integrations do not fit behind one generic `sign()` method.

### Exact signed-artifact lane

Hardware wallets and WalletConnect `eth_signTransaction` return signed wire
bytes. CashLoom decodes those bytes locally, recovers the signer, and compares
every transaction field with the authorized request. A future coordinator must
append those exact bytes through the core signed-artifact transaction before
any broadcast. A timeout after broadcast is ambiguous; recovery may submit
only the same retained bytes.

### Provider-execution lane

ERC-4337 bundlers and regulated bank providers may accept a request without
returning a raw network transaction. CashLoom therefore persists the exact
prepared request and provider idempotency/nonce claim before I/O, treats a
transport acknowledgement as nonterminal, and settles only from a separate
observer. It never retries an ambiguous provider operation by creating a new
request.

The current local Base and Bitcoin senders remain the compatibility path for
live self-custody. They are not weakened or routed through the external lane.

## Implemented modules

| Integration | Implemented boundary | Release state |
|---|---|---|
| WebAuthn passkeys | Strict registration/assertion contracts, real ES256 verification, RP ID/origin/challenge/UP/UV/counter checks, durable one-use ceremony and credential bindings | Smart-account execution policy blocked |
| Ledger / Trezor-style EVM | Vendor-neutral structured handoff; exact Base type-2 decode, hash and recovered-signer verification | Browser vendor transport not enabled; device provenance is explicitly unattested |
| WalletConnect v2 | CAIP namespace/session binding, browser-side topic stripping, `eth_signTransaction` only, exact signed transaction verification, versioned one-use persistence guard | Relay/session coordinator not enabled |
| ERC-4337 v0.7 | Semantic `PackedUserOperation`, 192/64 nonce domain, EntryPoint-domain hash, caller-supplied bounded EntryPoint registry, and one-attempt bundler transport | Production EntryPoint/factory/account/paymaster registry not pinned; no inclusion claim |
| GoCardless Bank Account Data | Fixed-origin, bounded, read-only GBP/EUR agreement/requisition/status/revoke adapter | Credentials may configure AIS; never payment initiation |
| Yapily Connect | Exact one-off domestic GBP preparation, fixed idempotency, bounded authorize transport, separate read-only status observer | Live PIS legally/provider policy blocked; consent/account coordinator not enabled |

`GET /api/wallet/v3/integrations` is a networkless local capability projection.
It reports configuration as booleans, never credential material. No integration
listed there is labelled executable merely because an SDK or API adapter exists.

## Passkeys

Files:

- `sovereign/src/wallet/integrations/requests.ts`
- `sovereign/src/wallet/adapters/webauthn-verifier.ts`
- `sovereign/ui/src/integrations/webauthn.ts`
- `sovereign/src/wallet/infrastructure/sqlite/integration-store.ts`

The RP ID and canonical origin are deployment policy, not derived from `Host`,
proxy, or request headers. HTTPS is required except exact
`http://localhost[:port]`; HTTP IP loopback origins are deliberately refused.
Spending assertions require both user presence and user verification.

The verifier uses the credential public key from the durable credential
projection, not a browser-supplied key. The ceremony binds the credential,
signer, account, RP ID, origin hash, challenge hash, intent hash, prepared
request hash, one-use authorization, expiry, and prior sign counter. Registration
with attestation `none` makes no hardware-backed or enterprise assurance claim.

Standards: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) and
[FIDO CTAP 2.1](https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html).

## Hardware EVM

Files:

- `sovereign/ui/src/integrations/hardware-evm.ts`
- `sovereign/src/wallet/adapters/hardware-evm-verifier.ts`

The browser bridge accepts one structured EIP-1559 handoff. It never exposes an
arbitrary byte-signing callback. The server independently validates the raw
transaction type, Base chain ID, nonce, destination, value, calldata, gas,
fee fields, access list, transaction hash, and recovered account before
returning a frozen artifact projection.

The current verifier proves that the expected external account signed the
authorized transaction. It cannot prove that a particular Ledger, Trezor, USB
path, secure element, or physical device produced it, so the evidence says
`unattested_hardware_handoff`.

## WalletConnect

Files:

- `sovereign/ui/src/integrations/walletconnect.ts`
- `sovereign/src/wallet/adapters/walletconnect-verifier.ts`

Pairing URIs/topics are bearer secrets and remain browser-session material.
Only hashes and an allowlisted public session projection cross the durable
boundary. Every request binds the exact session, CAIP-2 chain, CAIP-10 account,
method, parameters hash, authorization, request hash, version, and expiry.

CashLoom permits raw transaction signing only. It refuses
`eth_sendTransaction`, because a remote wallet broadcast has uncertain
acceptance semantics and cannot satisfy the artifact-before-network invariant.
`accountsChanged`, `chainChanged`, session update, expiry, or disconnect freezes
the request and requires owner approval again.

Standard: [WalletConnect session namespaces](https://docs.walletconnect.network/wallet-sdk/web/usage).

## ERC-4337 smart accounts

Files:

- `sovereign/src/wallet/integrations/requests.ts`
- `sovereign/src/wallet/adapters/erc4337-builder.ts`
- `sovereign/src/wallet/adapters/erc4337-bundler.ts`

The v0.7 request binds the EntryPoint, sender, counterfactual deployment fields,
call data, packed gas fields, paymaster fields, chain, and the 192-bit nonce key
plus 64-bit sequence. The owner binding and protocol UserOperation hash exclude
only the signature. The local builder recomputes both hashes and requires an
exact match in its injected, bounded EntryPoint registry. CashLoom does not yet
ship a production-approved Base EntryPoint/runtime-code registry.

The bundler is a fixed HTTPS, no-redirect, bounded-response, one-attempt
transport. As a transport preflight, it asks that same endpoint for EntryPoint
support and runtime code and compares the configured expected hash; a bundler
cannot turn that self-report into independent chain proof. A returned
UserOperation hash means transport acceptance only. It is not inclusion,
execution success, or finality. Settlement requires canonical EntryPoint event
evidence from the chain; that observer/coordinator is not yet enabled.

Standards: [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) and
[ERC-4337 JSON-RPC methods (EIP-7769)](https://eips.ethereum.org/EIPS/eip-7769).

## Open banking

Files:

- `sovereign/src/wallet/open-banking/`
- `sovereign/src/wallet/adapters/gocardless-bank-data-broker.ts`
- `sovereign/src/wallet/adapters/yapily-connect-executor.ts`
- `sovereign/src/wallet/adapters/yapily-payment-status-observer.ts`

Bank data and payment initiation are separate authorities. The GoCardless
adapter is AIS/read-only and has no payment endpoint. The Yapily adapter is a
bounded PIS transport for one immediate domestic GBP payment, but remains
disabled until CashLoom can bind the provider consent/token to the durable
source-account projection and the operator has established the applicable
provider and legal policy.

Preparation fixes the source account, institution, beneficiary, amount,
currency, reference, expiry, authorization state, and provider idempotency key.
Provider POST states—including terminal-looking strings—remain nonterminal.
Only the separate status observer can report provider terminal state, which a
future reconciler must journal with authoritative provider evidence.

For a live OAuth/FAPI deployment, the coordinator must provide exact registered
redirect matching, one-use state, PKCE S256, issuer binding, token rotation, and
sender-constrained tokens. Webhooks must be verified over raw bytes before JSON
parse, deduplicated, sanitized, and corroborated by an authoritative status
read before settlement.

Standards: [OAuth 2.0 Security BCP (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700.html),
[FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html),
[DPoP (RFC 9449)](https://www.rfc-editor.org/rfc/rfc9449.html), and
[OAuth mTLS (RFC 8705)](https://www.rfc-editor.org/rfc/rfc8705.html).

## Durable records and secrecy

The additive integration schema depends on the Wallet Kernel core connection,
signer, intent, and execution projections. It records:

- versioned integration connections and signers;
- expiring interactions and append-only interaction events;
- WebAuthn credentials and one-use ceremonies;
- hashed WalletConnect session bindings;
- external artifact fingerprints;
- permanent ERC-4337 nonce tuple claims;
- fiat consents, redirect-state/PKCE hashes, payee hashes, request attempts,
  and sanitized webhook evidence.

Revoking a connection or signer invalidates its pending ceremonies, sessions,
and authorizations. Identity fields are immutable; counters can only advance;
append-only evidence cannot be updated or deleted. The schema has no field for
raw OAuth credentials, WalletConnect topics, APDUs, PINs, IBANs, provider URLs,
or webhook bodies.

The separate integration ledger is not a substitute for the core signed
artifact table. Live activation requires one SQLite transaction that verifies
the current interaction/session version, appends the exact artifact or durable
provider request, consumes its one-use authorization, and claims its nonce or
provider idempotency resource. Until that coordinator exists for a given
adapter, `execution_enabled` remains false.

## Agent boundary

Agents may discover the catalog, inspect saved state, prepare proposals, and
explain the next required owner action. They cannot complete WebAuthn,
hardware, WalletConnect, OAuth, provider-consent, or recovery ceremonies.
Connection, credential, signer, paymaster, bundler, beneficiary, or provider
changes require owner authority and revoke outstanding approvals. New private
routes must be explicitly mapped to a scoped local session; unmapped routes
fail closed.

## Activation checklist

An integration moves from foundation to executable only when all items are
true:

- exact owner journey, origin/RP/provider/device policy, and recovery policy;
- canonical account/chain/asset or provider-account identity;
- typed prepared request and one-use authorization over the same hash;
- atomic verified artifact/provider-attempt persistence and resource claim;
- bounded fixed-origin transport with no raw upstream errors;
- explicit accepted, ambiguous, rejected, expired, reorged/reversed, and
  settled paths;
- independent read-only observer and exact journal/reconciliation rules;
- restart, concurrency, replay, substitution, cancellation, timeout, and
  secret-canary tests;
- local custody bundle isolation from the hosted INFO server;
- operator/legal/provider enablement where regulated money movement applies.
