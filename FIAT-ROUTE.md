# CashLoom fiat route — the legal, transparent, non-custodial plan

> **Status: plan, not shipped.** 2026-07-10. This is the design + compliance map
> for how CashLoom connects to fiat. **It is NOT legal advice.** Money movement
> is heavily regulated and the law is mid-transition in every jurisdiction below;
> a licensed fintech lawyer must sign off, per target country, before any fiat
> feature ships. Every legal claim here is grounded in a current (2024–2026)
> source, cited at the end.

## The intention (stated plainly, up front)

Let anyone, anywhere, move between fiat and crypto **without CashLoom ever
touching their money, holding their keys, or becoming a gatekeeper** — and be
completely honest about who does what. No scam. No hidden fee. No lock-in.
Always welcome, always free to go. If a step needs a license, we say so and let
a licensed partner do it; we never pretend, and we never evade.

## The one line that decides everything

Across the US (FinCEN + 50-state MTL + NY BitLicense), the EU (MiCA), the UK
(FCA/FSMA), Singapore (PSA/DTSP), Switzerland (AMLA), and the FATF template, the
licensing trigger converges on **two acts**:

1. **Taking custody/control** of a user's funds or keys, and
2. **Being the party that exchanges fiat ↔ crypto** (the on/off-ramp itself).

Do either, and you are a licensed money transmitter / VASP / CASP. Do neither —
be pure non-custodial software that connects a user to their *own* licensed
rail — and you can stay outside that perimeter. This is **architecture, not a
loophole.** The exchange step is unavoidably licensed; our design puts it on a
partner who already holds the licenses.

CashLoom already lives on the right side of this line (see `PROTOCOL.md`): the
node binds `127.0.0.1`, the vault seals keys locally (Argon2id → AES-GCM) that
never leave the machine, connectors are read-only, and `pay()` signs locally and
broadcasts the user's *own* signed transaction. Under FinCEN's 2019 CVC guidance
(FIN-2019-G001), software that never has "total independent control" over value
and never "accepts and transmits" it is **not** a money transmitter. **The fiat
route must be added without breaking any of that.**

## The compliant architecture — CashLoom is the door, not the transmitter

The flow, end to end, where the **user transacts directly with a licensed
provider** and CashLoom only opens the door:

1. The user runs their CashLoom node locally and holds their own key (e.g. the
   EVM key whose address is public).
2. CashLoom opens a **licensed on-ramp** as a hosted redirect or embedded widget,
   passing **only the user's own destination address** — no fiat, no PII, no key
   material crosses into CashLoom.
3. The user completes KYC and pays (card/bank) **directly with the licensed
   provider**, which is the merchant of record and runs KYC + sanctions
   screening.
4. The provider delivers USDC/crypto **non-custodially** straight to the user's
   own address.
5. CashLoom's read-only connector merely **observes** the arrival (`fetchBalance`
   / `fetchTransactions`).
6. From there the user runs their own on-chain steps with the local `pay()`
   primitive, signing locally.

At no step does CashLoom hold fiat, custody crypto, hold a key on a server, or
see KYC data. The money-transmission obligation attaches to the **licensed
provider**, not to CashLoom.

## Provider shortlist (real, operating, cited — verify licensing before use)

| Provider | Model | Custody to CashLoom | Notes |
|---|---|---|---|
| **Onramper** | Non-custodial **aggregator** of 30+ licensed on-ramps, one API | None (routes to licensed providers) | KYC handled by the underlying licensed ramps; referral fee model = pass-through. Cleanest "inherit compliance through one integration" fit. |
| **Stripe onramp** / **Sardine** | **Merchant of record** | None | Provider is contractually the principal + absorbs KYC/fraud/sanctions liability — the **strongest** firewall keeping CashLoom out of the chain. |
| **Coinbase Onramp** | Non-custodial, headless API | None | **0% fee on USDC** on/off-ramp — matches our USDC-on-Base rail. |
| **Ramp** | Non-custodial SDK | None | Holds FinCEN + FCA + Central Bank of Ireland registrations + **EU MiCAR** authorization. Some US states on-ramp-only. |
| **Transak / MoonPay** | Non-custodial delivery | None | Registered MSBs with 10–47 state MTLs + NY BitLicense. |
| **Kado** | Non-custodial, **Cosmos-native** | None | The only fiat ramp that reaches Cosmos appchains (Osmosis etc.). ⚠️ **Its current MSB/MTL status must be verified** (FinCEN MSB registry / NMLS) before use. |

Open crypto standards CashLoom can speak natively (but they do **not** cross the
fiat boundary — they are not ramps): **x402** (open HTTP-402 stablecoin standard,
now a Linux Foundation project, zero protocol fee), **ERC-681** payment URIs,
Circle **CCTP**. Avoid custodial stablecoin infra (Bridge.xyz/Stripe treasury) —
it conflicts with the non-custodial keystone.

## Per-jurisdiction compliance map (what triggers a license; what we avoid)

Everything below is **NOT LEGAL ADVICE** and is mid-transition — re-verify with
counsel near launch.

- **United States** — Custodial exchange/conversion = FinCEN-registered MSB +
  money-transmitter licenses in ~50 states + NY BitLicense. Non-custodial
  software that never controls value is **not** an MSB (FIN-2019-G001). *But*
  the safe harbor is contested: DOJ charged the non-custodial Tornado Cash and
  Samourai developers with unlicensed transmission; *Lewellen v. Bondi* (2025)
  is testing the line. Sanctions (OFAC) screening is **non-negotiable** at the
  licensed rail. A token like ZRN could be a "security" (Howey) — enabling its
  fiat sale escalates into securities/exchange registration.
- **European Union** — MiCA CASP authorization (live 30 Dec 2024, national
  transition to ~July 2026) is required to custody, exchange crypto-for-fiat, or
  operate a platform; AMLR AML rules bite **10 July 2027**. A *passive*
  non-custodial frontend can be outside scope, but **reception & transmission of
  orders** (active order-routing) or an *identifiable controlling operator*
  (Recital 22) pulls you in.
- **United Kingdom** — FCA cryptoasset **AML registration** (MLRs) applies to
  exchange and custodian-wallet providers; non-custodial-that-never-holds is out.
  **Separate trap:** the s.21 **financial-promotions** regime (Oct 2023) — the
  FCA found non-custodial wallet providers were the top offenders via on/off-ramp
  widgets; promoting cryptoasset purchase without an authorised/approved route is
  a **criminal** offence. Full FSMA authorization arrives **25 Oct 2027**.
- **Singapore** — Payment Services Act (DPT licensing) + the new **DTSP** regime
  (live 30 June 2025, no transition; MAS "will generally not license"
  offshore-only models). Facilitation-without-possession can be in scope.
- **Switzerland** — AMLA financial-intermediary status turns on "control over
  client assets"; SRO membership route; self-hosted-wallet exception.
- **FATF (global template)** — VASP definition + Travel Rule; DeFi/non-custodial
  treatment is explicitly **unsettled** and unevenly enforced. A design safe
  today can be pulled in by 2027–2028 rules.

## Three ways a "non-custodial" app still gets caught — design to trip none

1. **Marketing / promotions.** Even correct non-custody can be criminal via how
   you advertise (UK s.21; EU MiCA marketing rules). We disclose, we don't
   solicit investment; every fiat CTA names the licensed provider.
2. **Arranging / order-routing.** "Arranging with a view to" exchange (UK),
   "reception & transmission of orders" (EU), "facilitating without possession"
   (SG) can capture software that *shapes or routes* the transaction. We open the
   door; we don't optimize or route the trade.
3. **Identifiable operator.** If one party can upgrade, fee, or freeze the
   frontend, the "fully decentralised / no intermediary" carve-out fails. The
   node is the user's own local process; we take no fee on the fiat leg.

## ZRN is explicitly OUT of scope (the honest part)

**There is no fiat ↔ ZRN route anywhere, and CashLoom will not build one now.**
ZRN is play-value on a custodial-launch chain with only a thin, operator-seeded
liquidity pool — no market, no defensible valuation, not listed on any ramp.
Turning ZRN ↔ fiat would (a) require a real market that does not exist, and
(b) make whoever runs the conversion an "administrator/exchanger of convertible
virtual currency" (FinCEN → money transmitter) **and** push into
securities/exchange registration. So: **the legal fiat route is fiat ↔
USDC/major-crypto via licensed partners, into the user's own key.** ZRN stays a
separate, additive, read-only on-chain token that CashLoom *reads* (the
`/api/zerone` gateway) but never fiat-ramps. We claim **no fiat price for ZRN**,
and we will not build a ZRN cash-out until a real, disclosed market and a proper
legal wrapper exist — reviewed with counsel.

## Transparency + "always welcome and free to go"

- **Full disclosure at the confirm screen:** name the licensed provider, state
  that *they* do KYC and hold the license, and itemize every fee — provider fee
  vs on-chain gas vs **"No CashLoom fee, ever."**
- **No lock-in:** all data + keys live in one local file the user owns; export
  the ledger and walk away anytime. The passphrase *is* custody — no CashLoom
  account to close, no recovery, no telemetry.
- **Symmetric exit:** sending out is the same local `pay()` as coming in; no gate
  on the way out that isn't on the way in.
- **No dark patterns:** click-to-cancel parity for any paid tier; plain "not
  financial advice" + "ZRN is play-value, no fiat price" framing; a published,
  plain-language statement of exactly which party does what.

## The line — what CashLoom will never do

1. Custody fiat or crypto, or hold a user's private key on any server.
2. Be the money transmitter / on-ramp itself, or net/pool/route user funds.
3. Build any flow whose purpose is to **evade** KYC/AML, sanctions screening, or
   the Travel Rule. The compliant design *keeps* KYC/sanctions at the licensed
   rail; it never removes them. Evasion is illegal and is the "scam" we refuse.
4. Run a ZRN ↔ fiat conversion, or imply a fiat price for ZRN.

## Phased build plan

- **Phase 0 — legal (before any code ships):** written regulatory-perimeter
  opinion from licensed counsel in each target market (minimum: one EU member
  state as MiCA home, UK, US) confirming the embed/redirect boundary keeps
  CashLoom out of MSB/CASP/DTSP scope; confirm each provider's licenses cover the
  target user's country; a financial-promotions review of the UI/marketing.
- **Phase 1 — one merchant-of-record provider, redirect-only:** integrate the
  strongest-firewall option (Stripe onramp or Sardine) as a hosted redirect
  passing only the user's address. Ship the disclosure screen. US + EU first.
- **Phase 2 — aggregator for coverage:** add Onramper (or Coinbase Onramp for
  0% USDC) for country/asset breadth once the boundary is proven.
- **Phase 3 — Cosmos leg (only if warranted):** evaluate Kado for a native
  Cosmos fiat leg **after** verifying its licensing — still fiat ↔ USDC/ATOM/etc.,
  never fiat ↔ ZRN.
- **Re-verify before every launch** — the law is changing (EU AMLR 2027, UK FSMA
  2027, SG DTSP, FATF DeFi guidance). A snapshot is not a standing clearance.

---

## Sources (fetched 2026-07-10; verify against primaries before relying)

- FinCEN 2019 CVC guidance (FIN-2019-G001) — non-custodial wallet software is not an MSB; four-factor "total independent control" test. (fincen.gov; Jones Day summary.)
- FinCEN withdrawal of the 2020 unhosted-wallet KYC NPRM (2024-04-12) — area unsettled.
- Stripe fiat-to-crypto onramp docs — Stripe is merchant of record, users transact directly with Stripe, KYC/sanctions handled by Stripe, non-custodial delivery. (docs.stripe.com/crypto/onramp)
- Onramper — non-custodial aggregator, KYC at underlying licensed ramps, inherit coverage. (onramper.com)
- Transak / MoonPay / Coinbase Onramp / Ramp / Kado — provider licensing + non-custodial delivery models. (provider docs)
- ESMA MiCA hub — CASP go-live 30 Dec 2024, ~July 2026 transition. (esma.europa.eu)
- MiCA Art. 3(1)(23) / Art. 80 + Recital 22 — RTO / active-frontend / "fully decentralised" analysis.
- EU AMLR — applies 10 July 2027; AMLA supervision from 2028.
- FCA — cryptoasset AML registration (who must register); s.21 financial-promotions regime + fiat↔crypto ramp widgets; Aug-2024 finding non-custodial wallets top promotion offenders. (fca.org.uk)
- UK FSMA cryptoasset regime (SI 2026/102) in force 25 Oct 2027; "identifiable controlling person" test. (HM Treasury / Latham & Watkins)
- MAS — Payment Services Act expansion (2024) + DTSP regime live 30 June 2025. (mas.gov.sg; Allen & Gledhill)
- FINMA / AMLA — "control over client assets" test, SRO route, self-hosted-wallet exception.
- FATF June 2024 Targeted Update — VASP/DeFi/Travel-Rule state (~70% legislated, weak supervision).
- DOJ Tornado Cash (2023) / Samourai (2024) prosecutions + *Lewellen v. Bondi* (2025) — the non-custodial safe harbor is contested.

*Truth is. Money you can read. 字在,愛在,零一在。 We build the legal door, name
every hand in the flow, take nothing, and let you leave whenever you want.*
