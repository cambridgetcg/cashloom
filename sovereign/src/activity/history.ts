import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

/** Saved history only: this module has no provider, vault, or payment dependency. */
export interface ActivityTransaction {
  id: string;
  account_id: string;
  external_id: string | null;
  title: string;
  amount_minor: string;
  category: string | null;
  date: string;
  source: string;
  created_at: string;
  status: string;
  gross_minor: string | null;
  fee_minor: string | null;
  net_minor: string | null;
  transfer_link_id: string | null;
  provider_category: string | null;
}

export interface ActivityPage {
  transactions: ActivityTransaction[];
  has_more: boolean;
  next_cursor: string | null;
}

export class ActivityQueryError extends Error {
  constructor(public readonly code: "activity_query_invalid" | "activity_cursor_invalid") {
    super(code === "activity_cursor_invalid"
      ? "This history cursor is invalid or belongs to another account or search. Reload history to start again."
      : "Choose a valid account, a limit from 1 to 500, and a search of up to 120 characters.");
  }
}

const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const querySchema = z.object({
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  q: z.string().trim().max(120).refine(noControls).default(""),
});
const cursorSchema = z.object({
  v: z.literal(1),
  // Keep the stored sort keys byte-for-byte; legacy records need not use the
  // same timestamp precision. A cursor is a position, never account authority.
  date: z.string().min(1).max(128).refine(noControls),
  id: z.string().min(1).max(240).refine(noControls),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type HistoryCursor = z.infer<typeof cursorSchema>;
const fields = "id,account_id,external_id,title,amount_minor,category,date,source,created_at,status,gross_minor,fee_minor,net_minor,transfer_link_id,provider_category";

function decodeCursor(value: string, filter: string): HistoryCursor {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ActivityQueryError("activity_cursor_invalid");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(decoded));
    if (cursor.filter !== filter) throw new Error();
    return cursor;
  } catch {
    throw new ActivityQueryError("activity_cursor_invalid");
  }
}

export function readActivityPage(db: Database, input: { accountId?: string; limit?: string; q?: string; cursor?: string }): ActivityPage {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new ActivityQueryError("activity_query_invalid");
  const { accountId, limit, q } = parsed.data;
  const filter = createHash("sha256").update(JSON.stringify([accountId ?? null, q])).digest("hex");
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor, filter);
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (accountId) { conditions.push("account_id = ?"); parameters.push(accountId); }
  if (q) {
    // instr treats %, _ and quotes literally. SQLite lower folds ASCII only;
    // no wildcard, regex, provider category, or raw-payload search is implied.
    conditions.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(COALESCE(category, '')), lower(?)) > 0)");
    parameters.push(q, q);
  }
  if (cursor) { conditions.push("(date, id) < (?, ?)"); parameters.push(cursor.date, cursor.id); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.query(`SELECT ${fields} FROM transactions ${where} ORDER BY date DESC,id DESC LIMIT ?`)
    .all(...parameters, limit + 1) as ActivityTransaction[];
  const has_more = rows.length > limit;
  const transactions = has_more ? rows.slice(0, limit) : rows;
  const last = transactions.at(-1);
  const next_cursor = has_more && last
    ? Buffer.from(JSON.stringify({ v: 1, date: last.date, id: last.id, filter } satisfies HistoryCursor)).toString("base64url")
    : null;
  return { transactions, has_more, next_cursor };
}
