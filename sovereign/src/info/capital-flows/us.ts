import { decimalFromRaw } from "../blockchain/model.ts";
import { parseCsv } from "./csv.ts";
import {
  CAPITAL_LIMITS, HISTORY_LIMIT, nativeValue, reportingPeriod,
  type AdapterContext, type CapitalFlowAdapter, type FlowObservation, type NativeUnit, type SeriesDefinition,
  type SourceDefinition, type TextResponse,
} from "./model.ts";

const USD_MILLIONS: NativeUnit = { currency: "USD", exponent: 6, label: "million USD" };
const US = { code: "US", label: "United States" };
const DTS_METHOD = "https://fiscaldata.treasury.gov/datasets/daily-treasury-statement/";
const DTS_ENDPOINT = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/deposits_withdrawals_operating_cash";
const TIC_RESOURCE = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table4.txt";
const TIC_METHOD = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/sltinstr-2022nov.pdf";
const COMMON_LIMITATIONS = [
  "Latest-revised publisher history, not a release-vintage archive. Revisions are possible; publication/revision schedules and seasonal adjustment are unknown.",
  "Publication time is unknown; transport Last-Modified is not publication time. No inferred provisional or revision flags when the table supplies none.",
  "Native USD millions, not annualized; no rounding, FX conversion, cross-period or cross-source totals. Missing is not zero.",
];
const DTS_LIMITATIONS = [
  "Table II published Public Debt Cash Issues and Public Debt Cash Redemptions: cash into/out of the US Treasury General Account. Not debt-stock change, foreign financing, tax/fiscal receipts or auction allotments.",
  "Daily transaction_today_amt only; never month-to-date/fiscal-year-to-date totals, summed Table IIIA details or rounded Table IIIB components.",
  "Selected window: latest 60 records per cash leg, page 1 only from each of two exact-category/type/Table II resources. Other publisher history pages are not fetched; completeness means the paired selected window, not full historical pagination.",
  "Both selected pages must have identical descending reported dates. No business-day calendar is inferred. Sequential requests are not a publisher-atomic vintage; mismatched date sets fail closed.",
  "No publisher observation-status or finality flags are supplied; false booleans mean no reported flag, not final or revision-free values.",
  ...COMMON_LIMITATIONS,
];
const TIC_LIMITATIONS = [
  "Grand Total country_code 99996 only, at most the latest 24 complete published months. All country/region/memo rows are parsed and charged, never summed; this is not full historical coverage.",
  "Foreign perspective: for_lt_*_sale is US sales to foreign entities (foreign purchases); for_lt_*_pur is US purchases from foreign entities (foreign sales). Net = sale minus pur.",
  "Settlement-date transactions at original settlement cost, without end-month revaluation. US purchases include expenses; US sale proceeds are net of charges; FX uses settlement-day closing spot.",
  "Includes primary issues, redemptions and asset-backed-security principal payments; not secondary-only turnover, all-market turnover or changes in holdings.",
  "Treasury bonds and notes exclude bills; corporate and other bonds and corporate equities are separate. TIC Table 3 bill holdings-change estimates are excluded.",
  "Foreign transacting entities/counterparty geography is not necessarily ultimate-owner residence. No country allocation or foreign-financing claim for the US government is inferred.",
  "February 2023 SLT methodology break; no pre-break splicing. Treasury Table 1 agreement would be same-source consistency, not independent corroboration.",
  ...COMMON_LIMITATIONS,
];

function observation(series: SeriesDefinition, label: string, lexeme: string | null, response: TextResponse, recipe: string): FlowObservation {
  return {
    id: `${series.id}:${label}`, seriesId: series.id, period: reportingPeriod(series.frequency, label),
    value: lexeme === null ? null : nativeValue(lexeme, series.unit), status: lexeme === null ? "missing" : "observed",
    provisional: false, revised: false, estimated: false, publisherStatus: lexeme === null ? "n.a." : null,
    publisherConfidentiality: null, break: series.frequency === "monthly" && label === "2023-02",
    // Complete reporting period and both selected fields, not a promise of final/revision-free values.
    completeness: "complete",
    receipt: {
      sourceId: series.sourceId, sourceSeriesId: series.sourceSeriesId, datasetId: series.datasetId,
      resourceUrl: response.url, retrievedAt: response.receipt.retrievedAt, publicationAt: null,
      method: "publisherReported", recipe, inputObservationIds: [], limitations: [...series.limitations],
    },
  };
}

function netObservation(series: SeriesDefinition, a: FlowObservation, b: FlowObservation, response: TextResponse): FlowObservation {
  let lexeme: string | null = null;
  if (a.value && b.value) {
    const scale = Math.max(a.value.decimals, b.value.decimals);
    const scaled = (v: NonNullable<FlowObservation["value"]>) => BigInt(v.raw) * 10n ** BigInt(scale - v.decimals);
    lexeme = decimalFromRaw((scaled(a.value) - scaled(b.value)).toString(), scale);
  }
  const net = observation(series, a.period.label, lexeme, response, "Exact same-period, same-unit and same-basis first published leg minus second published leg. Any missing leg makes net missing; no older-value substitution.");
  net.publisherStatus = null; // A derived null is not a publisher-supplied n.a. code.
  net.receipt.method = "derivedCompatibleComponents";
  net.receipt.inputObservationIds = [a.id, b.id];
  return net;
}

const DTS_FIELDS = [
  ["record_date", "Record Date", "DATE", "YYYY-MM-DD"],
  ["transaction_type", "Transaction Type", "STRING", "String"],
  ["transaction_catg", "Transaction Category", "STRING", "String"],
  ["transaction_today_amt", "Transactions Today", "CURRENCY0", "$1,000,000"],
  ["transaction_mtd_amt", "Transactions Month to Date", "CURRENCY0", "$1,000,000"],
  ["transaction_fytd_amt", "Transactions Fiscal Year to Date", "CURRENCY0", "$1,000,000"],
  ["src_line_nbr", "Source Line Number", "INTEGER", "10"],
  ["table_nbr", "Table Number", "STRING", "String"],
] as const;
const DTS_LEGS = [
  { type: "Deposits", category: "Public Debt Cash Issues (Table IIIB)" },
  { type: "Withdrawals", category: "Public Debt Cash Redemp. (Table IIIB)" },
] as const;
// Preserve the verified %20 / encoded-parentheses URLs. URLSearchParams' + and
// the old in:(parenthesized categories) query are not this source contract.
const dtsEncode = (value: string) => encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
const DTS_RESOURCES = DTS_LEGS.map(leg => `${DTS_ENDPOINT}?filter=${dtsEncode(`transaction_catg:eq:${leg.category},transaction_type:eq:${leg.type},table_nbr:eq:II`)}&fields=${dtsEncode(DTS_FIELDS.map(([field]) => field).join(","))}&sort=-record_date&page%5Bsize%5D=${HISTORY_LIMIT.daily}`);

function dtsRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("dts_shape");
  return value as Record<string, unknown>;
}
function dtsAmount(value: unknown): string | null {
  // FiscalData documents string-valued fields, including the literal "null".
  // Missing fields, JSON null, blanks and unrecognized flags are schema failures.
  if (value === "null") return null;
  if (typeof value !== "string" || value.length > CAPITAL_LIMITS.decimalChars || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("dts_amount");
  return value;
}
function dtsPage(response: TextResponse, leg: typeof DTS_LEGS[number], ctx: AdapterContext) {
  if (response.text.length > CAPITAL_LIMITS.responseBytes) throw new Error("dts_size_limit");
  const root = dtsRecord(JSON.parse(response.text), ["data", "meta", "links"]);
  if (!Array.isArray(root.data)) throw new Error("dts_rows");
  ctx.consumeRows(root.data.length); // Charge every parsed row, even a rejected extra category/date.
  const meta = dtsRecord(root.meta, ["count", "labels", "dataTypes", "dataFormats", "total-count", "total-pages"]);
  const fields = DTS_FIELDS.map(([field]) => field);
  for (const [name, index] of [["labels", 1], ["dataTypes", 2], ["dataFormats", 3]] as const) {
    const values = dtsRecord(meta[name], fields);
    if (DTS_FIELDS.some(field => values[field[0]] !== field[index])) throw new Error("dts_metadata");
  }
  const total = meta["total-count"], pages = meta["total-pages"], count = meta.count;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 ||
      typeof pages !== "number" || !Number.isSafeInteger(pages) || pages !== Math.ceil(total / HISTORY_LIMIT.daily) ||
      count !== root.data.length || count !== Math.min(total, HISTORY_LIMIT.daily)) throw new Error("dts_incomplete_window");
  const links = dtsRecord(root.links, ["self", "first", "prev", "next", "last"]);
  const pageLink = (page: number) => `&page%5Bnumber%5D=${page}&page%5Bsize%5D=${HISTORY_LIMIT.daily}`;
  if (links.self !== pageLink(1) || links.first !== pageLink(1) || links.prev !== null ||
      links.next !== (pages > 1 ? pageLink(2) : null) || links.last !== pageLink(pages)) throw new Error("dts_pagination");
  let previous = "";
  const rows = root.data.map(value => {
    ctx.signal.throwIfAborted();
    const row = dtsRecord(value, fields);
    if (row.transaction_catg !== leg.category || row.transaction_type !== leg.type || row.table_nbr !== "II") throw new Error("dts_cash_scope");
    if (typeof row.src_line_nbr !== "string" || !/^\d{1,10}$/.test(row.src_line_nbr)) throw new Error("dts_line_type");
    const date = row.record_date;
    if (typeof date !== "string") throw new Error("dts_date");
    reportingPeriod("daily", date);
    if (date >= response.receipt.retrievedAt.slice(0, 10) || (previous && date >= previous)) throw new Error("dts_date_order_or_incomplete");
    previous = date;
    const lexeme = dtsAmount(row.transaction_today_amt);
    dtsAmount(row.transaction_mtd_amt); dtsAmount(row.transaction_fytd_amt); // Validate but never publish cumulative values.
    return { date, lexeme };
  });
  return { rows, expected: Math.min(total, HISTORY_LIMIT.daily),
    selection: `${leg.type} / ${leg.category}: selected ${count} of ${total} matching publisher records, page 1 of ${pages}; ${rows.at(-1)!.date} through ${rows[0]!.date}. Remaining history pages are deliberately not fetched.` };
}

/** Published daily Table II cash totals, with two complete paired latest-page selections. */
export function createUsCashFinancingAdapter(): CapitalFlowAdapter {
  const definition: SourceDefinition = {
    id: "us-dts-cash-financing", name: "US Treasury — daily public-debt cash financing",
    sourceUrl: DTS_METHOD, methodologyUrl: DTS_METHOD, resources: [...DTS_RESOURCES], cadence: "daily",
    rights: {
      status: "allowed", attribution: "Source: U.S. Department of the Treasury, FiscalData, Daily Treasury Statement, Table II.",
      evidenceUrl: "https://fiscaldata.treasury.gov/api-documentation/", checkedAt: null,
      note: "FiscalData API documentation offers data free without restriction and permits copying, adapting and redistribution for commercial and noncommercial purposes. Checked 2026-09-09; exact check time unknown. CashLoom selects daily published cash totals and derives their exact difference; no Treasury endorsement.",
    }, limitations: [...DTS_LIMITATIONS],
  };
  const series: SeriesDefinition[] = ([
    ["issuance", "Cash issues", "Deposits / Public Debt Cash Issues (Table IIIB)"],
    ["redemptions", "Cash redemptions", "Withdrawals / Public Debt Cash Redemp. (Table IIIB)"],
    ["netIssuance", "Net cash financing", "derived:cash-issues-minus-cash-redemptions"],
  ] as const).map(([metricKind, label, sourceSeriesId]) => ({
    id: `us-dts-${metricKind}`, sourceId: definition.id, sourceSeriesId, datasetId: "DTS/deposits_withdrawals_operating_cash/TableII",
    label: `US Treasury — ${label}`, category: "sovereignDebt", metricKind, frequency: "daily", unit: { ...USD_MILLIONS },
    perspective: "US Treasury General Account cash financing; all counterparties, not a foreign-investor subset.",
    signConvention: metricKind === "netIssuance" ? "Positive = net cash into the Treasury General Account; negative = net cash paid out."
      : metricKind === "issuance" ? "Published cash-issue inflow magnitude; not debt-stock issuance." : "Published cash-redemption outflow magnitude; not negated.",
    geography: { issuer: { ...US }, investor: null, reporting: { ...US }, custodial: null, fundDomicile: null },
    instrument: "Public debt cash issues/redemptions (published Table II cash totals)", sector: "US federal government / Treasury General Account",
    fundMandate: null, valuation: "Daily cash transactions in the Treasury General Account, not face value or debt outstanding",
    seasonalAdjustment: "unknown", annualization: "notAnnualized", methodologyUrl: DTS_METHOD, sourceUrl: DTS_ENDPOINT,
    limitations: [...definition.limitations],
  }));
  return {
    definition, series,
    async load(ctx) {
      ctx.signal.throwIfAborted();
      // Sequential GETs preserve actual transport completion/receipt order and
      // share the existing eight-second adapter budget. Never follow history links.
      const issuesResponse = await ctx.fetchText(DTS_RESOURCES[0]!);
      ctx.signal.throwIfAborted();
      const issues = dtsPage(issuesResponse, DTS_LEGS[0], ctx);
      const redemptionsResponse = await ctx.fetchText(DTS_RESOURCES[1]!);
      ctx.signal.throwIfAborted();
      const redemptions = dtsPage(redemptionsResponse, DTS_LEGS[1], ctx);
      if (issues.rows.length !== redemptions.rows.length ||
          issues.rows.some((row, i) => row.date !== redemptions.rows[i]!.date)) throw new Error("dts_unpaired_dates");
      ctx.assertComplete(issues.rows.length + redemptions.rows.length, issues.expected + redemptions.expected);
      const observations: FlowObservation[] = [];
      for (let i = 0; i < issues.rows.length; i++) {
        ctx.signal.throwIfAborted();
        const makeLeg = (index: number, page: typeof issues, response: TextResponse) => {
          const row = page.rows[i]!;
          const result = observation(series[index]!, row.date, row.lexeme, response,
            "Published Table II transaction_today_amt only, selected by exact cash category and transaction type; no source-line selection, cumulative totals or noncash adjustments.");
          result.publisherStatus = row.lexeme === null ? "null" : null;
          result.receipt.limitations.push(page.selection);
          return result;
        };
        const a = makeLeg(0, issues, issuesResponse), b = makeLeg(1, redemptions, redemptionsResponse);
        // The net references both input IDs and the actual second receipt, not a
        // fabricated combined retrieval/publication time.
        const net = netObservation(series[2]!, a, b, redemptionsResponse);
        net.receipt.limitations.push(issues.selection, redemptions.selection);
        observations.push(a, b, net);
      }
      return { complete: true, observations, receipts: [issuesResponse.receipt, redemptionsResponse.receipt] };
    },
  };
}

const TIC_HEADER = [
  "country", "country_code", "date", "for_lt_total_sale", "for_lt_treas_sale", "for_lt_agcy_sale", "for_lt_corp_sale", "for_lt_eqty_sale",
  "us_lt_total_sale", "us_lt_govt_bond_sale", "us_lt_corp_bond_sale", "us_lt_eqty_sale", "for_lt_total_pur", "for_lt_treas_pur",
  "for_lt_agcy_pur", "for_lt_corp_pur", "for_lt_eqty_pur", "us_lt_total_pur", "us_lt_govt_bond_pur", "us_lt_corp_bond_pur", "us_lt_eqty_pur",
];
const TIC_ASSETS = [
  { stem: "treas", category: "sovereignDebt", label: "US Treasury bonds and notes (excluding bills)", sector: "US federal government" },
  { stem: "corp", category: "bonds", label: "US corporate and other bonds", sector: "US corporate and other bond issuers" },
  { stem: "eqty", category: "equities", label: "US corporate equities", sector: "US corporate equity issuers" },
] as const;

/** Isolate the machine block before invoking the shared quoted TSV parser. */
function ticRows(text: string): string[][] {
  if (text.length > CAPITAL_LIMITS.responseBytes) throw new Error("tic_size_limit");
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const headers = lines.flatMap((line, i) => line.startsWith("country\tcountry_code\tdate") ? [i] : []);
  if (headers.length !== 1) throw new Error("tic_header");
  const start = headers[0]!;
  const preamble = lines.slice(0, start).map(line => line.replace(/\t+$/, ""));
  if (!preamble.includes("Table 4: U.S. Purchases and Sales of Long-Term Domestic and Foreign Securities by Type") ||
      !preamble.includes("Millions of dollars")) throw new Error("tic_title_or_unit");
  const footer = lines.findIndex((line, i) => i > start && /^(?:Definitions:|Notes:)[\t ]*$/.test(line));
  if (footer < 0) throw new Error("tic_missing_footer");
  const notes = lines.slice(footer).map(line => line.replace(/\t+$/, ""));
  if (notes.some(line => {
    const cells = line.split("\t");
    return /^"?\d{5}"?$/.test(cells[1] ?? "") && /^"?\d{4}-\d{2}"?$/.test(cells[2] ?? "");
  })) throw new Error("tic_data_after_footer");
  if (!notes.includes("Sales are sales by the U.S. of securities to a foreign entity.") ||
      !notes.includes("Purchases are purchases by the U.S. of securities from a foreign entity.")) throw new Error("tic_perspective_notes");
  // The publisher separates data from Definitions with blank tab-only lines.
  let end = footer;
  while (end > start + 1 && /^[\t ]*$/.test(lines[end - 1]!)) end--;
  const [header, ...rows] = parseCsv(lines.slice(start, end).join("\n"), "\t");
  if (!header || JSON.stringify(header) !== JSON.stringify(TIC_HEADER)) throw new Error("tic_columns");
  if (!rows.length) throw new Error("tic_no_rows");
  return rows;
}

export function createTicTransactionsAdapter(): CapitalFlowAdapter {
  const definition: SourceDefinition = {
    id: "us-tic-transactions", name: "US Treasury TIC — foreign transactions in US long-term securities",
    sourceUrl: TIC_RESOURCE, methodologyUrl: TIC_METHOD, resources: [TIC_RESOURCE], cadence: "monthly",
    rights: {
      status: "allowed", attribution: "Source: U.S. Department of the Treasury, Treasury International Capital (TIC), Form SLT Table 4.",
      evidenceUrl: "https://www.copyright.gov/title17/92chap1.html", checkedAt: null,
      note: "Scoped public-government-statistics basis: 17 USC 105 and official-duty definition in 101, plus Treasury/FRBNY/Federal Reserve SLT aggregate-reporting provenance (banks acting as Treasury fiscal agents). No restriction identified for these Table 4 numerical aggregates. Not an invented licence or blanket permission for government-hosted material: transferred copyrights, third-party material, marks and confidential respondent reports are excluded. Checked 2026-09-09; exact time unknown. CashLoom selects Grand Total/24 months, relabels to foreign perspective and derives exact nets; no endorsement.",
    }, limitations: [...TIC_LIMITATIONS],
  };
  const series: SeriesDefinition[] = TIC_ASSETS.flatMap(asset => ([
    ["purchases", "Foreign purchases", `for_lt_${asset.stem}_sale`],
    ["sales", "Foreign sales", `for_lt_${asset.stem}_pur`],
    ["netAcquisition", "Net foreign purchases", `derived:for_lt_${asset.stem}_sale-for_lt_${asset.stem}_pur`],
  ] as const).map(([metricKind, label, field]) => ({
    id: `us-tic-${asset.stem}-${metricKind}`, sourceId: definition.id, sourceSeriesId: `SLT.Table4.99996.${field}`,
    datasetId: "TIC/SLT/Table4", label: `${asset.label} — ${label}`, category: asset.category, metricKind,
    frequency: "monthly", unit: { ...USD_MILLIONS },
    perspective: "Foreign entities transacting with US residents in US-issued long-term securities, reported by US TIC respondents.",
    signConvention: metricKind === "netAcquisition" ? "Positive = net foreign purchases; negative = net foreign sales; US sales minus US purchases."
      : metricKind === "purchases" ? "Foreign purchases = published US sales to foreign entities; not sign-flipped." : "Foreign sales = published US purchases from foreign entities; not sign-flipped.",
    geography: { issuer: { ...US }, investor: { code: "non-US", label: "Foreign transacting entities (Grand Total; not ultimate-owner allocation)" }, reporting: { ...US }, custodial: null, fundDomicile: null },
    instrument: asset.label, sector: asset.sector, fundMandate: null,
    valuation: "Original settlement cost: US purchases include expenses, US sales net of charges; settlement-date FX closing spot, no end-month revaluation",
    seasonalAdjustment: "unknown", annualization: "notAnnualized", methodologyUrl: TIC_METHOD, sourceUrl: TIC_RESOURCE,
    limitations: [...definition.limitations],
  })));
  return {
    definition, series,
    async load(ctx) {
      ctx.signal.throwIfAborted();
      const response = await ctx.fetchText(TIC_RESOURCE);
      ctx.signal.throwIfAborted();
      const rows = ticRows(response.text);
      ctx.consumeRows(rows.length); // Includes every discarded country, region, memo and older date.
      const seen = new Set<string>(), labels = new Map<string, string>(), totals = new Map<string, string[]>();
      let newest = "";
      const fetchedDate = response.receipt.retrievedAt.slice(0, 10);
      for (const row of rows) {
        ctx.signal.throwIfAborted();
        if (row.length !== TIC_HEADER.length) throw new Error("tic_row_width");
        const [country, code, month] = row as [string, string, string, ...string[]];
        if (!country || country.length > 256 || /[\r\n]/.test(country) || country.trim() !== country || !/^\d{5}$/.test(code)) throw new Error("tic_country");
        if ((code === "99996") !== (country === "Grand Total") || (labels.has(code) && labels.get(code) !== country)) throw new Error("tic_country_label_mismatch");
        labels.set(code, country);
        const period = reportingPeriod("monthly", month);
        if (month < "2023-02" || period.end >= fetchedDate) throw new Error("tic_incomplete_or_prebreak_month");
        const key = `${code}:${month}`;
        if (seen.has(key)) throw new Error("tic_duplicate_country_period");
        seen.add(key);
        newest = month > newest ? month : newest;
        for (const token of row.slice(3)) {
          if (token !== "n.a." && (token.length > CAPITAL_LIMITS.decimalChars || !/^-?\d+(?:\.\d+)?$/.test(token))) throw new Error("tic_invalid_value");
          // SLT instructions II.D.2 (p.7): gross transactions cannot be negative.
          // Test the bounded lexeme exactly: retain signed zero, not negative nonzero.
          if (token.startsWith("-") && /[1-9]/.test(token)) throw new Error("tic_negative_gross");
        }
        if (code === "99996") totals.set(month, row);
      }
      const months = [...totals.keys()].sort().reverse().slice(0, HISTORY_LIMIT.monthly);
      if (!months.length || months[0] !== newest) throw new Error("tic_missing_grand_total");
      for (let i = 1; i < months.length; i++) {
        const prior = reportingPeriod("monthly", months[i - 1]!);
        const expected = new Date(Date.parse(`${prior.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7);
        if (months[i] !== expected) throw new Error("tic_missing_month");
      }
      // The terminal Definitions/Notes block proves machine-block completion, not a
      // claim that the deliberately selected 24 months are the entire publisher history.
      ctx.assertComplete(rows.length, rows.length);
      const observations: FlowObservation[] = [];
      for (const month of months) {
        const row = totals.get(month)!;
        for (let i = 0; i < TIC_ASSETS.length; i++) {
          const asset = TIC_ASSETS[i]!;
          const leg = (offset: number, suffix: "sale" | "pur") => {
            const token = row[TIC_HEADER.indexOf(`for_lt_${asset.stem}_${suffix}`)]!;
            return observation(series[i * 3 + offset]!, month, token === "n.a." ? null : token, response,
              `Published Grand Total country_code 99996, for_lt_${asset.stem}_${suffix}; relabeled from US to foreign perspective without changing the number. No country/region/memo sums.`);
          };
          const purchases = leg(0, "sale"), sales = leg(1, "pur");
          observations.push(purchases, sales, netObservation(series[i * 3 + 2]!, purchases, sales, response));
        }
      }
      return { complete: true, observations, receipts: [response.receipt] };
    },
  };
}
