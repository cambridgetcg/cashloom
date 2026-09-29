import { CAPITAL_LIMITS } from "./model.ts";

/** Quoted delimited records, including the header; no value coercion or whitespace trimming.
 * Transport enforces decoded bytes; these additional bounds protect direct parser callers.
 * Blank records are retained so an adapter can reject them rather than hide missing rows.
 */
export function parseCsv(text: string, delimiter: "," | "\t" = ","): string[][] {
  if (typeof text !== "string" || text.length > CAPITAL_LIMITS.responseBytes) throw new Error("csv_size_limit");
  if (delimiter !== "," && delimiter !== "\t") throw new Error("csv_delimiter");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false, started = false;
  const pushField = () => {
    row.push(field);
    if (row.length > 128) throw new Error("csv_column_limit");
    field = ""; closed = false; started = false;
  };
  const pushRow = () => {
    pushField(); rows.push(row); row = [];
    // One header plus the shared adapter data-row ceiling.
    if (rows.length > CAPITAL_LIMITS.rows + 1) throw new Error("csv_row_limit");
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else if (char === '"') {
      if (started || closed) throw new Error("csv_invalid_quote");
      quoted = true; started = true;
    } else {
      if (closed) throw new Error("csv_after_quote");
      field += char; started = true;
    }
    if (field.length > 128 * 1024) throw new Error("csv_field_limit");
  }
  if (quoted) throw new Error("csv_unclosed_quote");
  if (started || closed || row.length) pushRow();
  return rows;
}
