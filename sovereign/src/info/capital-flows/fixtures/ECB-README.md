# ECB statistical CSV fixture attribution

Source: European Central Bank (ECB). **Data available free from ECB. Presentation by CashLoom; no cross-series totals.**

These four statistical CSV responses were supplied from bounded live checks on 2026-09-09 and copied byte-for-byte, retaining CRLF endings, native decimal strings, quoted titles and status/confidentiality metadata. Exact retrieval clock times are not available; tests use explicitly synthetic transport receipts. The fixtures are not publication timestamps, frozen original releases or a vintage archive.

- `ecb-csec-es-de-total-2026-06_2026-07.csv`: six Spain/Germany central-government (excluding social security) debt-security gross-issue, redemption and net-issue series, June–July 2026, 12 rows. Latest observations have provisional `P`; preceding observations have normal `A`.
- `ecb-csec-es-de-total-2020-12_2021-01.csv`: same six series, December 2020–January 2021, 12 rows. December carries the native break flag `B`.
- `ecb-ivf-required-quarterly.csv`: euro-area equity, bond and real-estate fund-share financial transactions, 2024-Q3–2026-Q2, 24 rows.
- `ecb-ivf-private-equity-quarterly.csv`: Netherlands **and** euro-area private-equity fund-share transactions, 2025-Q3–2026-Q2, 8 rows. Tests explicitly exclude the four Netherlands rows before joining the U2 rows to the three-class fixture. Production selects only four euro-area series and rejects unexpected keys; the Netherlands fixture is not a fifth enabled series.

Reproducible bounded CSEC requests use the same exact six-key basket as production, with `format=csvdata&startPeriod=2026-06&endPeriod=2026-07` or `format=csvdata&startPeriod=2020-12&endPeriod=2021-01` instead of a rolling limit. The original exact request URLs were not retained in the supplied CSV files; their observed key/period coverage is documented above. Production does **not** hardcode these dates and requests the following fixed rolling resources:

- <https://data-api.ecb.europa.eu/service/data/CSEC/M.N.ES+DE.W0.S1311.S1.N.L+LD+LI.F.F3.T._Z.EUR._T.F.V.N._T?format=csvdata&lastNObservations=24>
- <https://data-api.ecb.europa.eu/service/data/IVF/Q.U2.N.10+20+40+TP.L30.A.4.Z5.0000.Z01.E?format=csvdata&lastNObservations=20>

CSEC is EUR millions, face value, all original maturities and currency denominations, non-consolidated central-government issuer financing; not cash proceeds. Redemptions retain positive publisher magnitudes, and reported net issues are not recomputed. IVF is quarterly EUR millions, liability-side **net fund-share issuance — financial transactions**. U2 is euro-area fund domicile, not investor or investment geography. Detailed cash-only/reinvestment/FX-timing treatment is unverified. Real-estate fund shares are not direct property transactions, and private-equity fund shares are not worldwide commitments or calls/distributions. No cross-class sums are justified, including private-equity classification overlap. `DECIMALS` is display guidance; it never rounds stored publisher lexemes.

## Reuse basis and modifications

[ECB reuse disclaimer](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html), checked 2026-09-09, allows free reuse of these statistical data with ECB attribution and explicit modification disclosure. CashLoom is free. If paid access is introduced, buyers must be told **before payment and at each access** that the data are available free from ECB. This notice and the free source links belong outside any iframe. No ECB endorsement is implied. These permissions are for the statistical CSVs, not author-named papers, PDFs or private workflow reports.

Repository fixture modifications: descriptive file renaming only; no CSV content changes. Test basket assembly combines the two IVF headers/rows and excludes Netherlands, without changing retained observations. Tests labeled **synthetic** mutate headers, dimensions, dates, values, missing/confidentiality/status codes and sizes to exercise failure handling. Blank/`null` missing values and most defensive status cases were **not** observed in the supplied live CSVs; these tests are not live evidence. Production normalizes period boundaries, preserves native values, flags status codes and withholds non-free or explicitly missing values.

Methodology links:
- [Debt securities](https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/securities/html/index.en.html)
- [Investment funds](https://www.ecb.europa.eu/stats/financial_corporations/investment_funds/html/index.en.html)

SHA-256 byte-preservation receipts:

```text
8773dbe070c8e0e5ab74d48a3c6a6b64ffdfd3eff0b9a4674c0a48760a051492  ecb-csec-es-de-total-2020-12_2021-01.csv
e917edf11662d28ebe22aa7b59c21f0918fa7f4f3d2ba6984f9331d457760e62  ecb-csec-es-de-total-2026-06_2026-07.csv
7d398004b3806fe5eb4caf4f1d05d95e31917568eeb0ca8cd9ebee1a1a8f6cb4  ecb-ivf-private-equity-quarterly.csv
e6616233101e877a7cf66dc76571142d22fc3df1009dea2fd2264a2249d6c6a3  ecb-ivf-required-quarterly.csv
```
