import { createHash } from "node:crypto";

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 2_000;

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = "ImportError"; }
}

export interface ImportAccount {
  id: string;
  currency: string;
  decimals: number;
}

export interface ImportRow {
  row_id: string;
  external_id: string;
  distinct_reference: string | null;
  date: string;
  title: string;
  amount_minor: string;
  currency: string;
  category: string | null;
}

export interface DistinctImportRow {
  row_id: string;
  reference: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** A bounded RFC-4180-style reader. An unfinished quote or malformed field
 * fails the whole preview, never silently shifts money into the next column. */
function csvRows(csv: string): string[][] {
  if (new TextEncoder().encode(csv).byteLength > MAX_IMPORT_BYTES) {
    throw new ImportError("Choose a CSV file smaller than 1 MB.");
  }
  const text = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  const finishRow = () => {
    row.push(field);
    if (row.some((part) => part.trim() !== "")) rows.push(row);
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new ImportError("Import at most 2,000 entries at a time.");
    row = []; field = ""; closedQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ",") { row.push(field); field = ""; closedQuote = false; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else if (char === '"' && field === "" && !closedQuote) quoted = true;
    else if (char === '"' || closedQuote) throw new ImportError("The CSV contains a malformed quoted field.");
    else field += char;
    if (row.length > 5) throw new ImportError("Use the columns date, title, amount, currency, and optional category.");
  }
  if (quoted) throw new ImportError("The CSV ends inside a quoted field.");
  finishRow();
  return rows;
}

function minorAmount(value: string, decimals: number, rowNumber: number): string {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || value.length > 100) {
    throw new ImportError(`Row ${rowNumber}: use a signed decimal amount without currency symbols or separators.`);
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  if (fraction.length > decimals) throw new ImportError(`Row ${rowNumber}: amount has too many decimal places for this account.`);
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  return (negative ? -atomic : atomic).toString();
}

/** Review is bound to both normalized rows and the destination's money scale.
 * Reordering a file doesn't duplicate the same entries on repeated imports.
 * Repeated identical rows within a file keep their multiplicity. */
export function prepareActivityImport(account: ImportAccount, csv: string, distinctRows: readonly DistinctImportRow[] = []) {
  if (!Number.isInteger(account.decimals) || account.decimals < 0 || account.decimals > 18) {
    throw new ImportError("This account has an unsupported currency precision.");
  }
  const parsed = csvRows(csv);
  if (parsed.length < 2) throw new ImportError("Include a header and at least one entry.");
  const columns = parsed[0].map((field) => field.trim().toLowerCase());
  const allowed = new Set(["date", "title", "amount", "currency", "category"]);
  if (new Set(columns).size !== columns.length || columns.some((column) => !allowed.has(column)) ||
      ["date", "title", "amount", "currency"].some((column) => !columns.includes(column))) {
    throw new ImportError("Use the columns date, title, amount, currency, and optional category.");
  }
  const occurrences = new Map<string, number>();
  const rows: ImportRow[] = parsed.slice(1).map((fields, index) => {
    const number = index + 2;
    if (fields.length !== columns.length) throw new ImportError(`Row ${number}: the number of fields does not match the header.`);
    const get = (name: string) => (fields[columns.indexOf(name)] ?? "").trim();
    const title = get("title");
    const category = get("category");
    const day = get("date");
    if (!title || title.length > 200 || category.length > 60) {
      throw new ImportError(`Row ${number}: use a title of 1–200 characters and a category of at most 60 characters.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(title + category)) {
      throw new ImportError(`Row ${number}: titles and categories must fit on one line without control characters.`);
    }
    const date = new Date(`${day}T12:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
      throw new ImportError(`Row ${number}: use a real calendar date in YYYY-MM-DD format.`);
    }
    const currency = get("currency").toUpperCase();
    if (currency !== account.currency.toUpperCase()) throw new ImportError(`Row ${number}: currency must match the selected account.`);
    const amount = minorAmount(get("amount"), account.decimals, number);
    const identity = hash(JSON.stringify([day, title, amount, currency]));
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const rowId = `csv:${identity}:${occurrence}`;
    return { row_id: rowId, external_id: rowId, distinct_reference: null, date: date.toISOString(), title,
      amount_minor: amount, currency, category: category || null };
  });
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const selected = new Set<string>();
  const references = new Set<string>();
  if (distinctRows.length > MAX_IMPORT_ROWS) throw new ImportError("Review at most 2,000 separate entries at a time.");
  for (const choice of distinctRows) {
    const row = byId.get(choice.row_id);
    if (!row || selected.has(choice.row_id)) throw new ImportError("Choose each separate entry once from this preview.");
    const reference = choice.reference.trim().normalize("NFC");
    if (!reference || reference.length > 120 || /[\u0000-\u001f\u007f]/.test(reference)) {
      throw new ImportError("Give each separate entry a reference of 1–120 characters on one line.");
    }
    if (references.has(reference)) throw new ImportError("Use a different reference for each separate entry.");
    selected.add(choice.row_id); references.add(reference);
    row.distinct_reference = reference;
    // The reference, not the transaction's mutable details, owns this identity.
    // Reuse with conflicting money/date/title is refused by the route's review.
    row.external_id = `csv-ref:${hash(JSON.stringify([account.id, reference]))}`;
  }
  return {
    preview_hash: hash(JSON.stringify([account.id, account.currency, account.decimals, rows])),
    account_id: account.id,
    currency: account.currency,
    decimals: account.decimals,
    rows,
    distinct_rows: rows.filter((row) => row.distinct_reference !== null).map((row) => ({ row_id: row.row_id, reference: row.distinct_reference! })),
    row_count: rows.length,
  };
}
