# CashLoom — what's actually required vs skippable

*Researched 2026-06-04. **Informational only, NOT legal advice** — confirm with a UK/EU/US solicitor + a tax adviser before launch. The UK Data (Use and Access) Act 2025 is phasing in through 2026, so re-check ICO pages near launch.*

The principle: do what's genuinely required, skip the theater. Below is what survived hard fact-checking (verified, sourced to the ICO + the law) and what still needs confirming.

## ✅ Verified — and mostly *skippable* friction (UK data protection)

1. **Users' financial data is NOT "special category" data** under UK GDPR. Income/expenses/card details are sensitive in the everyday sense but are *not* on the Article 9 list (health, religion, politics, etc.). → Rely on an ordinary lawful basis. **Skip** the heavyweight "sensitive data" consent/DPIA regime built for that. *(ICO)*

2. **AI insights only become "special category" if you set out to infer one** — health, religion, politics. "You spend more on dining at month-end" = fine. Inferring religion from charity/tithing patterns = not fine. → Keep prompts/outputs to money patterns; don't ask the AI to guess sensitive traits. *(ICO; note EU users get a broader test, so don't surface transactions that indirectly reveal sensitive traits.)*

3. **No mandatory DPIA, no forced human-review workflow.** The strict regime (Article 22) only covers *solely automated* decisions with *legal or major* effects. Your insights are advice the user acts on themselves — outside it. → **Skip** the mandatory-DPIA theater. *(ICO)*

4. **For the AI feature the real minimum is small:** (a) record a lawful basis, (b) working access / delete / correct processes, (c) let users opt out of the insights/profiling. That's it. *(ICO)*

5. **No cookie-consent banner needed — IF** you set only strictly-necessary cookies (login / session / security) and NO analytics or marketing trackers. → **Skip** the banner entirely. The moment you add analytics or ads, consent is required for those. *(ICO PECR)*

**The pattern:** the "sensitive financial data → heavy compliance" fear is legally wrong for a tracker. The biggest friction everyone adds here is theater.

## ⚠️ Still to confirm (researched but not verified this run — strong hypotheses, get a source or lawyer)

- **FCA line:** a non-custodial tracker that never connects to bank APIs very likely sits outside FCA open-banking (AISP) licensing and money/e-money rules — and factual "information" isn't regulated "advice." Plausible, not confirmed here. Stay clearly informational; add a "not financial advice" line.
- **Gemini:** use the **paid** API tier (the free tier forbids sensitive data; the paid tier should exclude your data from training and give you a DPA). Confirm against Google's current terms.
- **Tax + payments:** a **merchant-of-record** (Paddle / Lemon Squeezy) likely offloads VAT / sales-tax remittance AND PCI burden (down to SAQ-A or nothing) — probably the friction-killer vs raw Stripe. Confirm.
- **Email:** scheduled reports are probably "transactional" (the user asked for them) — still always include an unsubscribe link. Confirm.
- **Pricing / cancellation:** make cancelling as easy as signing up (FTC click-to-cancel + EU/UK rules trend this way). No dark patterns. Confirm specifics.

## The playbook

**DO:** one plain privacy policy · a lawful basis on record · working "see/delete my data" + an insight opt-out · paid Gemini tier · a merchant-of-record for billing · easy one-click cancel · "not financial advice" framing on AI insights.

**SKIP:** cookie-consent banner (no trackers) · "sensitive data" consent flows · mandatory DPIA · FCA licensing (as long as you never touch money or bank APIs) · building your own tax/PCI stack (let the merchant-of-record do it).
