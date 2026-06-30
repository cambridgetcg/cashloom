# CashLoom Development Roadmap

*Generated 2026-06-04 from a module-by-module deep-dive (auth · user · transaction · analytics · report · client-UX · cross-cutting). Lens: less fees · more value · less work · peace of mind. Find the optimum.*

## Progress — shipped so far (2026-06-04, local commits)

Worked the list top-value first. Done + verified (tsc clean, tests green), committed locally:

- **Do-first data bugs** — CSV import no longer stores amounts 100× too small (`insertMany` runs the cents setter); single-delete scoped to owner (closed the IDOR); `lastProcessed` typo fixed.
- **Honest surfaces** — deleted the fake billing tab + stubs, the dead Google buttons, and mock data; root `/` returns `{status:"ok"}` instead of throwing.
- **Safety floor** — helmet, `trust proxy`, body-size limit, and rate limits on `/auth` + the costly AI/import routes (generous for honest use, caps abuse + AI spend).
- **Clearer UI** — per-page tab titles, helpful empty states, title typo + meta/noscript fixed, mobile menu now readable by screen readers.
- **#1 bet — AI Import (whole, end-to-end):** paste a bank/card statement or CSV → Gemini reads it → review the rows → save (reuses bulk import). Backend + client modal + 9 tests on the parsing.

Still open, top value next: per-import **dedupe/idempotency** (#2 — stops double-imports), **password reset** via Resend (#3), persist **AI insights** in-app (#4), CI workflow, dep bumps.

**On money:** the fake billing was cut (it was fiction — see §5). The chosen revenue direction is a **fair-money model** — free to try + a limited-but-generous free tier + a fair paid tier via a **merchant-of-record** (they handle VAT/sales-tax + PCI). BUILD COMPLETE (2026-06-25): Plans config + quota middleware + pricing API + client pricing page. Free tier (3 accounts, 10 AI imports, 10 scans, 50 bulk imports/mo, monthly reports, 30-day history) and Pro tier (£4.99/mo or £49/yr, unlimited accounts, 100 AI ops, weekly+monthly reports, full history). Quota enforced on scan/aiImport/bulkImport/account routes with 429 + upgrade hint. Merchant-of-record webhook hook ready — plan flips FREE→PRO on payment confirmation, not on our say-so.

## 1. State of CashLoom

A personal income/expense tracker — Express 5 + MongoDB backend, React 19 + Redux Toolkit client — imported 2026-06-04 from a 2025-07 contractor build. The happy paths are real and reasonably organized (transactions, analytics aggregations, Gemini receipt-scan + insights, scheduled email reports), but it's a tutorial-grade scaffold straddling two half-finished designs: it ships UI for refresh-tokens, OAuth, and billing that have **no backend**, and it hides or breaks features that *do* work. **The single biggest lever: getting messy real-world money data IN cleanly and correctly.** Today the primary bulk path silently corrupts every imported amount by 100×, and forces hand-mapping real bank CSVs can't satisfy — while a Gemini pipeline that could eat raw statements already sits in the repo, used only for single receipts.

## 2. Must-do hygiene (staleness / test / CI)

- **Zero tests, zero CI** on software doing cents↔dollars math, recurring-date arithmetic, and per-user data isolation. Add Vitest + one GitHub Actions workflow (`tsc --noEmit` + tests) covering currency round-tripping, `calculateNextOccurrence`, savings-rate/%-change math, per-user scoping.
- **No deploy/infra artifacts** (no Dockerfile/Procfile/fly/render) and **no health endpoint** — and root `/` actively `throw`s a test error, so probes can't point at it.
- **Cron gated on `NODE_ENV==='development'`** — recurring transactions AND monthly reports **never run in production**. Both scheduled features are silently dead.
- **Stale/risky deps:** multer 1.x (DoS CVEs) → 2.x; cloudinary 1.x → 2.x; drop deprecated `@types/mongoose@5`; align `date-fns` across client/backend.
- **Debug noise in prod:** strip `console.log` dumping financial data / file paths / full error objects (PII leakage).

## 3. Quick wins (high-impact, low-effort)

| Change | Why | Effort |
|---|---|---|
| Fix CSV bulk-import cents corruption (`insertMany`/pre-`convertToCents`); fix `lastProcesses` typo | more-value — stops silent 100× data loss in the primary bulk path | quick |
| Scope single delete to owner: `findOneAndDelete({_id, userId})` | peace-of-mind — closes IDOR (a guessed id deletes another user's records) | quick |
| Ungate cron from `NODE_ENV`; run on a `RUN_CRONS` flag (default on) | more-value — recurring tx + monthly reports actually run in prod | quick |
| `POST /auth/logout` + 15m token → 7d, **delete** dead refresh/OAuth | less-work + peace-of-mind — ends silent mid-session logout, kills 404-on-expiry, 2 unused secrets, fake Google buttons | quick |
| Remove insecure JWT secret defaults; Zod env-validate at boot | peace-of-mind — no forgeable-token deploy from a public-repo default | quick |
| Issue JWT on register (fix `withTransaction` return bug) | less-work — kills redundant re-login on first use | quick |
| Add `helmet` (installed, unused) + `express-rate-limit` on `/auth/*` and AI/upload routes + `json({limit})` | less-fees (caps runaway AI/storage spend) + peace-of-mind (brute-force) | quick |
| Persist `insights[]` on the Report doc + render in-app | more-value — AI output already paid-for is emailed once then discarded | quick |
| Replace root `/` test-error throw with `GET /health` | less-work — probe-able, no 500 first impression | quick |
| `select: false` on password field | peace-of-mind — no future query leaks the hash | quick |
| Default dashboard `dateRange` to Last-30-Days | more-value — headline cards show instantly, not blank | quick |
| Delete avatar's old Cloudinary asset on replace | less-fees — stops unbounded orphaned-asset storage cost | quick |
| Instant theme toggle (drop duplicate state + "Update preferences" button) | less-work | quick |

## 4. High-value bets (ranked)

1. **AI Import — reuse the Gemini pipeline to eat raw statements & free text.** Real bank CSVs (date/description/amount only) *can't* be imported today without hand-editing + mapping 6 columns. Add one endpoint taking pasted CSV/statement/PDF text → standard transaction array via the same `genAI` call already in `scanReceiptService` → confirm step. **Creates the core value of a finance app — messy money in with near-zero work — from code already in the repo.** *(Pair: auto-map columns by header; make type/category/method optional with smart defaults — infer EXPENSE from negative sign.)*
2. **Import/create dedupe + idempotency.** Re-importing an overlapping bank month or double-clicking Save silently doubles data — the worst trust-breaker in a money app. Skip `(userId+date+amount+title)` matches, report "X imported, Y skipped"; optional client idempotency key; advisory guard on the recurrence cron.
3. **Password reset via the already-configured Resend mailer.** Forgot password = permanent lockout from your own financial data. `POST /auth/forgot-password` + `/reset-password` reusing bcrypt + Resend. Highest peace-of-mind gap, no new infra. *(After cutting dead refresh/OAuth.)*
4. **Feed the AI the comparison data already computed.** Insights see only single-period scalars — yet `summaryAnalyticsService` already computes period-over-period deltas never passed to the model. A real coach ("dining +40% vs last month") with zero new data/AI spend.
5. **Finance-relevant settings (currency + timezone + locale).** Correct money formatting + correct day-boundary bucketing — value the existing features consume immediately.

## 5. The OPTIMUM north star

**The simplest CashLoom: a free-forever tracker where getting accurate money in is effortless and the numbers are always trustworthy.** One coherent auth path (long-lived JWT, real logout, real password reset). One IN funnel where the AI eats whatever you paste — receipts, bank CSVs, free text — dedupes it, stores it correctly in cents. One dashboard that loads instantly with real numbers + a monthly AI coach that compares months and is saved in-app. That's the whole product.

**CUT (subtraction is the optimum move, not "finish later"):**
- **Billing entirely** — no processor in any dependency; `billing.tsx` upsells to a 404, `BillingPlanCard` returns the literal string, the "Free Trial (2 days left)" countdown is hardcoded fiction. A processor for a single-user tracker = recurring fee + PCI/webhook/dunning/tax burden with no revenue model. Delete the tab, stubs, dead RTK tag, fake trial. *(If revenue ever wanted: one optional one-time "Pro" unlock gating heavy features like raising `MAX_IMPORT_LIMIT` — never multi-plan subscriptions.)*
- **Refresh-token + Google OAuth half-designs** — UI-wired, API-absent. Delete client mutations, unused `JWT_REFRESH_*` secrets, dead Google buttons.
- **Report frequency scaffolding** — only MONTHLY exists; controls disabled.
- **Dead surfaces:** unused `GET /report/generate` (billable + abusable), no-op "Resend" button, mock `REPORT_DATA`, empty type files, the index-route test throw.

## 6. Do this first

**Fix the CSV bulk-import cents corruption — today.** Lowest-effort/highest-impact change in the codebase: a one-line swap (`bulkWrite/insertOne` → `insertMany`, or pre-apply `convertToCents`) + the `lastProcesses`→`lastProcessed` typo. Right now *every CSV-imported transaction is stored 100× too small*, silently poisoning balances, the dashboard, and the AI report — corrupting the exact "trust the numbers" the product exists to deliver. Land it with the one test that proves it (`$10.00 in → $10.00 back`), seeding the missing suite. Bundle with the IDOR delete-scope fix + cron-ungate — all three are silent feature-killers, together under an hour.
