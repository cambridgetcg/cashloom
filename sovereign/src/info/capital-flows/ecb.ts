import { parseCsv } from "./csv.ts";
import {
  HISTORY_LIMIT, nativeValue, reportingPeriod,
  type CapitalFlowAdapter, type FlowObservation, type NativeUnit,
  type SeriesDefinition, type SourceDefinition,
} from "./model.ts";

const CSEC_RESOURCE = "https://data-api.ecb.europa.eu/service/data/CSEC/M.N.ES+DE.W0.S1311.S1.N.L+LD+LI.F.F3.T._Z.EUR._T.F.V.N._T?format=csvdata&lastNObservations=24";
const IVF_RESOURCE = "https://data-api.ecb.europa.eu/service/data/IVF/Q.U2.N.10+20+40+TP.L30.A.4.Z5.0000.Z01.E?format=csvdata&lastNObservations=20";
const CSEC_METHOD = "https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/securities/html/index.en.html";
const IVF_METHOD = "https://www.ecb.europa.eu/stats/financial_corporations/investment_funds/html/index.en.html";
const EUR_MILLIONS: NativeUnit = { currency: "EUR", exponent: 6, label: "million EUR" };
const COMMON_LIMITATIONS = [
  "Selected bounded latest-revised publisher history, not an archive of release vintages. Source-provided revision policy and publication schedule are unknown.",
  "Publication time is unknown; transport Last-Modified is not a release timestamp. Normal status A does not establish finality or completeness.",
  "All original currency denominations expressed in EUR; no CashLoom FX conversion. Unadjusted and not annualized.",
  "Publisher decimal lexemes are retained exactly, including serialization residuals; DECIMALS is display guidance, not a rounding instruction for stored values.",
  "Source: European Central Bank (ECB). Data available free from ECB. Presentation by CashLoom; no cross-series totals.",
];
const CSEC_LIMITATIONS = [
  "Spain and Germany only. Issuer sector S1311 is central government excluding social security, not general government.",
  "Debt securities, all original maturities (T), non-consolidated. W0 covers domestic and other world counterparties; no investor-country breakdown.",
  "Face-value issuance and redemption transactions, not cash proceeds or secondary-market turnover. Net issues are reported by ECB, not recomputed from gross issues and redemptions.",
  "At most 24 monthly observations per series; missing months are not filled with zero.",
  ...COMMON_LIMITATIONS,
];
const IVF_LIMITATIONS = [
  "Euro area changing composition is FUND DOMICILE, not investor residence or investment geography; no country-by-country fund basket is implied.",
  "Non-money-market investment funds; excludes money-market funds and pension funds. Non-consolidated inter-fund holdings; private-equity classification overlap is unverified. Do not add fund classes or wrappers and underlying assets.",
  "Liability-side fund-share net issuance, financial transactions (L30, DATA_TYPE 4), not stocks or total-asset portfolio transactions. Detailed cash-only, reinvestment and FX-timing treatment is unverified; no cash-only subscription claim.",
  "Real-estate fund shares are not direct property investment; private-equity fund shares are not worldwide deals, commitments or capital calls/distributions.",
  "At most 20 quarterly observations per series; no overlapping monthly series or cross-class/global total. Missing quarters are not filled with zero.",
  ...COMMON_LIMITATIONS,
];

function sourceDefinition(dataset: "CSEC" | "IVF"): SourceDefinition {
  const sovereign = dataset === "CSEC";
  return {
    id: sovereign ? "ecb-csec" : "ecb-ivf",
    name: sovereign ? "European Central Bank — central-government debt securities" : "European Central Bank — euro-area investment-fund shares",
    sourceUrl: `https://data.ecb.europa.eu/data/datasets/${dataset}`,
    methodologyUrl: sovereign ? CSEC_METHOD : IVF_METHOD,
    resources: [sovereign ? CSEC_RESOURCE : IVF_RESOURCE],
    cadence: sovereign ? "monthly" : "quarterly",
    rights: {
      status: "allowed",
      attribution: "Source: European Central Bank (ECB). Data available free from ECB. Presentation by CashLoom; no cross-series totals.",
      evidenceUrl: "https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html",
      checkedAt: null,
      note: "ECB statistical-data reuse terms checked 2026-09-09; exact check time unavailable. Free reuse with ECB attribution and explicit disclosure of modifications. CashLoom is free; if paid access is introduced, inform buyers before payment and at each access that data are available free from ECB. Presentation selects bounded histories, normalizes periods and withholds non-free/missing values; reported values are not recomputed. No ECB endorsement implied.",
    },
    limitations: [...(sovereign ? CSEC_LIMITATIONS : IVF_LIMITATIONS)],
  };
}

const CSEC_DIMENSIONS = [
  "FREQ", "ADJUSTMENT", "REF_AREA", "COUNTERPART_AREA", "REF_SECTOR", "COUNTERPART_SECTOR",
  "CONSOLIDATION", "ACCOUNTING_ENTRY", "STO", "INSTR_ASSET", "MATURITY", "EXPENDITURE",
  "UNIT_MEASURE", "CURRENCY_DENOM", "VALUATION", "PRICES", "TRANSFORMATION", "CUST_BREAKDOWN",
];
const IVF_DIMENSIONS = [
  "FREQ", "REF_AREA", "ADJUSTMENT", "IVF_REP_SECTOR", "IVF_ITEM", "MATURITY_ORIG", "DATA_TYPE",
  "COUNT_AREA", "BS_COUNT_SECTOR", "CURRENCY_TRANS", "BS_SUFFIX",
];
const KNOWN_STATUSES = new Set(["A", "P", "R", "B", "E", "H", "L", "M", "O", "Q"]);
const MISSING_STATUSES = new Set(["H", "L", "M", "O", "Q"]);

/** One fixed basket is one atomic replacement. No permissive key filtering or inferred rows. */
function adapter(definition: SourceDefinition, series: SeriesDefinition[], dataset: "CSEC" | "IVF"): CapitalFlowAdapter {
  const dimensions = dataset === "CSEC" ? CSEC_DIMENSIONS : IVF_DIMENSIONS;
  const confColumn = dataset === "CSEC" ? "CONF_STATUS" : "OBS_CONF";
  const extra = dataset === "CSEC"
    ? { UNIT_MULT: "6", TIME_FORMAT: "P1M" }
    : { UNIT_MULT: "6", TIME_FORMAT: "P3M", UNIT: "EUR" };
  const expected = new Map(series.map(s => [s.sourceSeriesId, s]));
  return {
    definition, series,
    async load(ctx) {
      ctx.signal.throwIfAborted();
      const response = await ctx.fetchText(definition.resources[0]!);
      ctx.signal.throwIfAborted();
      const [header, ...rows] = parseCsv(response.text);
      ctx.consumeRows(rows.length);
      if (!header || !rows.length) throw new Error("ecb_unavailable");
      if (new Set(header).size !== header.length) throw new Error("ecb_duplicate_header");
      const indexes = new Map(header.map((column, index) => [column, index]));
      const required = ["KEY", ...dimensions, ...Object.keys(extra), "TIME_PERIOD", "OBS_VALUE", "OBS_STATUS", confColumn, "DECIMALS"];
      if (required.some(column => !indexes.has(column))) throw new Error("ecb_missing_column");
      const observations: FlowObservation[] = [];
      const counts = new Map<string, number>(), seen = new Set<string>();
      for (const row of rows) {
        ctx.signal.throwIfAborted();
        if (row.length !== header.length) throw new Error("ecb_invalid_row");
        const get = (column: string) => row[indexes.get(column)!]!;
        const s = expected.get(get("KEY"));
        if (!s) throw new Error("ecb_unexpected_key");
        const keyParts = s.sourceSeriesId.split(".");
        if (keyParts[0] !== dataset || keyParts.length !== dimensions.length + 1 ||
          dimensions.some((column, i) => get(column) !== keyParts[i + 1]) ||
          Object.entries(extra).some(([column, value]) => get(column) !== value)) throw new Error("ecb_dimension_mismatch");
        if (!/^(?:[0-9]|1[0-8])$/.test(get("DECIMALS"))) throw new Error("ecb_unknown_decimals");
        const periodLabel = get("TIME_PERIOD");
        // These modern statistical datasets do not use early/zero years; Date.UTC treats
        // years 0–99 specially. Reject them rather than produce a centuries-long period.
        if (!/^[1-9]\d{3}-/.test(periodLabel)) throw new Error("invalid_period");
        const period = reportingPeriod(s.frequency, periodLabel);
        const id = `${s.id}:${period.label}`;
        if (seen.has(id)) throw new Error("ecb_duplicate_period");
        seen.add(id);
        counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
        if (counts.get(s.id)! > HISTORY_LIMIT[s.frequency]) throw new Error("ecb_history_limit");
        const publisherStatus = get("OBS_STATUS"), publisherConfidentiality = get(confColumn);
        if (!KNOWN_STATUSES.has(publisherStatus)) throw new Error("ecb_unknown_status");
        const lexeme = get("OBS_VALUE");
        // Q denotes a missing suppressed observation. Any non-F confidentiality, including
        // unknown/blank codes, is conservatively withheld without retaining the numeric lexeme.
        const suppressed = publisherConfidentiality !== "F" || publisherStatus === "Q";
        const missing = MISSING_STATUSES.has(publisherStatus) || lexeme.trim() === "" || /^null$/i.test(lexeme.trim());
        const status = suppressed ? "suppressed" : missing ? "missing" : "observed";
        const value = status === "observed" ? nativeValue(lexeme, s.unit) : null;
        if (value && (s.metricKind === "issuance" || s.metricKind === "redemptions") && BigInt(value.raw) < 0n) throw new Error("ecb_unexpected_gross_sign");
        observations.push({
          id, seriesId: s.id, period, value, status,
          provisional: publisherStatus === "P", revised: publisherStatus === "R", estimated: publisherStatus === "E",
          publisherStatus, publisherConfidentiality, break: publisherStatus === "B", completeness: "unknown",
          receipt: {
            sourceId: definition.id, sourceSeriesId: s.sourceSeriesId, datasetId: dataset,
            resourceUrl: response.url, retrievedAt: response.receipt.retrievedAt, publicationAt: null,
            method: "publisherReported", recipe: "ECB reported observation; exact native decimal and multiplier retained. No net recomputation, sign reversal, rounding, FX conversion or cross-series aggregation.",
            inputObservationIds: [],
            limitations: [...s.limitations, ...(suppressed ? ["Publisher confidentiality is not F (free), or status Q marks suppression; any numeric value is withheld."] : [])],
          },
        });
      }
      if (series.some(s => !counts.has(s.id))) throw new Error("ecb_incomplete_series");
      observations.sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.period.start.localeCompare(b.period.start));
      // The unpaginated CSV's selected lastN response has been fully processed.
      // This accounts for this response, not global history or a publisher total.
      ctx.assertComplete(rows.length, rows.length);
      return { complete: true, observations, receipts: [response.receipt] };
    },
  };
}

export function createEcbSovereignAdapter(): CapitalFlowAdapter {
  const definition = sourceDefinition("CSEC");
  const series: SeriesDefinition[] = [];
  for (const [country, label] of [["ES", "Spain"], ["DE", "Germany"]] as const) {
    for (const [entry, metricKind, name] of [["LI", "issuance", "Gross issues"], ["LD", "redemptions", "Redemptions"], ["L", "netIssuance", "Net issues"]] as const) {
      const sourceSeriesId = `CSEC.M.N.${country}.W0.S1311.S1.N.${entry}.F.F3.T._Z.EUR._T.F.V.N._T`;
      series.push({
        id: `ecb-csec-${country.toLowerCase()}-${metricKind}`, sourceId: definition.id, sourceSeriesId, datasetId: "CSEC",
        label: `${label} central-government debt securities — ${name} (face value)`, category: "sovereignDebt", metricKind,
        frequency: "monthly", unit: { ...EUR_MILLIONS },
        perspective: "Issuer-side financing transactions of central government excluding social security; all world counterparties including domestic.",
        signConvention: entry === "L" ? "Positive = net issuance; negative = net redemption. ECB reported net retained, not recomputed."
          : entry === "LD" ? "Nonnegative publisher redemption magnitudes; a financing reduction, not negated."
            : "Nonnegative publisher gross issuance magnitudes; a financing increase.",
        geography: { issuer: { code: country, label }, investor: null, reporting: { code: country, label }, custodial: null, fundDomicile: null },
        instrument: "Debt securities (F3), all original maturities (T), all original currency denominations",
        sector: "Central government excluding social security (S1311); non-consolidated",
        fundMandate: null, valuation: "Face value (F), not cash proceeds",
        seasonalAdjustment: "unadjusted", annualization: "notAnnualized", methodologyUrl: CSEC_METHOD,
        sourceUrl: `https://data.ecb.europa.eu/data/datasets/CSEC/${sourceSeriesId}`, limitations: [...definition.limitations],
      });
    }
  }
  return adapter(definition, series, "CSEC");
}

export function createEcbFundAdapter(): CapitalFlowAdapter {
  const definition = sourceDefinition("IVF");
  const series: SeriesDefinition[] = [];
  for (const [policy, category, mandate] of [["10", "equities", "Equity funds"], ["20", "bonds", "Bond funds"], ["40", "realEstate", "Real-estate funds"], ["TP", "privateEquity", "Private-equity funds"]] as const) {
    const sourceSeriesId = `IVF.Q.U2.N.${policy}.L30.A.4.Z5.0000.Z01.E`;
    series.push({
      id: `ecb-ivf-${category}`, sourceId: definition.id, sourceSeriesId, datasetId: "IVF",
      label: `${mandate} — Net fund-share issuance — financial transactions`, category, metricKind: "netIssuance",
      frequency: "quarterly", unit: { ...EUR_MILLIONS },
      perspective: "Liability-side net fund-share issuance by euro-area-domiciled funds; fund domicile is not investor or investment geography.",
      signConvention: "Positive = net fund-share issuance; negative = net fund-share redemption, on ECB financial-transaction basis. Not verified cash-only subscriptions.",
      geography: { issuer: null, investor: null, reporting: { code: "U2", label: "Euro area (changing composition)" }, custodial: null, fundDomicile: { code: "U2", label: "Euro area (changing composition)" } },
      instrument: "Investment-fund shares/units issued (L30); financial transactions (DATA_TYPE 4); total maturity (A)",
      sector: "Non-MMF investment funds, excluding money-market and pension funds; non-consolidated inter-fund holdings",
      fundMandate: mandate, valuation: "Publisher financial-transaction values in EUR; detailed cash-only, reinvestment and FX-timing treatment unverified",
      seasonalAdjustment: "unadjusted", annualization: "notAnnualized", methodologyUrl: IVF_METHOD,
      sourceUrl: `https://data.ecb.europa.eu/data/datasets/IVF/${sourceSeriesId}`, limitations: [...definition.limitations],
    });
  }
  return adapter(definition, series, "IVF");
}
