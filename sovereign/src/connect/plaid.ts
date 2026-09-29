import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ProviderTokenBinding } from "../vault.ts";
import type { ReadAccountInput, ReadTransactionInput, ReadRemoval } from "./contracts.ts";
import { applyReadSync, createReadConnection, getReadSyncState, ReadSyncConflict, setReadConnectionStatus } from "./read-model.ts";
import { createPlaidHttp, PlaidError } from "./plaid-http.ts";
export { PlaidError } from "./plaid-http.ts";
export { installPlaidSchema } from "./plaid-schema.ts";

export type PlaidItemState = "setup_pending" | "connected" | "reconnect_required" | "disconnect_pending" | "disconnected";
export interface PlaidItemView {
  id: string;
  label: string;
  state: PlaidItemState;
  account_count: number;
  last_synced_at: string | null;
  error_code: string | null;
}
interface ItemRow { id: string; provider_item_id: string; state: PlaidItemState; account_count: number }
interface AttemptRow { id: string; session_hash: string; state: string; public_token_hash: string | null; item_id: string | null; expires_at: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new PlaidError("PLAID_INVALID_REQUEST");
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlaidError("PLAID_INVALID_DATA");
  return value as Record<string, unknown>;
};
const externalId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new PlaidError("PLAID_INVALID_DATA");
  return value;
};
const label = (value: unknown, fallback: string): string => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 140) || fallback : fallback;
const day = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PlaidError("PLAID_INVALID_DATA");
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new PlaidError("PLAID_INVALID_DATA");
  return result.toISOString();
};

/** Plaid USD amounts arrive as JSON numbers. Reject non-cent values and values
 * above a conservative cent-exact input bound instead of multiplying floats. */
export function plaidUsdMinor(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw new PlaidError("PLAID_INVALID_DATA");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new PlaidError("PLAID_INVALID_DATA");
  const amount = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return (match[1] ? -amount : amount).toString();
}

export function plaidAccounts(value: unknown): { accounts: ReadAccountInput[]; allIds: Set<string> } {
  if (!Array.isArray(value) || value.length > 200) throw new PlaidError("PLAID_INVALID_DATA");
  const accounts: ReadAccountInput[] = []; const allIds = new Set<string>();
  for (const input of value) {
    const account = object(input); const id = externalId(account.account_id);
    if (allIds.has(id)) throw new PlaidError("PLAID_INVALID_DATA"); allIds.add(id);
    const balances = object(account.balances);
    const supported = (account.type === "depository" && ["checking", "savings"].includes(String(account.subtype))) || (account.type === "credit" && account.subtype === "credit card");
    if (!supported || balances.iso_currency_code !== "USD" || balances.unofficial_currency_code != null) continue;
    accounts.push({ externalAccountId: id, displayName: label(account.name, "Sandbox bank account"), rail: "BANK", currency: "USD", decimals: 2,
      balanceMinor: balances.current === null ? null : plaidUsdMinor(balances.current),
      availableMinor: balances.available == null ? null : plaidUsdMinor(balances.available), balanceKind: "current",
      mask: typeof account.mask === "string" && /^\d{1,4}$/.test(account.mask) ? account.mask : null,
      accountType: account.type === "credit" ? "credit" : String(account.subtype),
    });
  }
  return { accounts, allIds };
}

function plaidTransaction(value: unknown, allIds: Set<string>, supported: Set<string>): ReadTransactionInput | null {
  const tx = object(value); const accountId = externalId(tx.account_id);
  if (!allIds.has(accountId)) throw new PlaidError("PLAID_INVALID_DATA");
  if (!supported.has(accountId)) return null;
  if (tx.iso_currency_code !== "USD" || tx.unofficial_currency_code != null || typeof tx.pending !== "boolean") throw new PlaidError("PLAID_INVALID_DATA");
  const category = tx.personal_finance_category == null ? null : object(tx.personal_finance_category);
  return { externalAccountId: accountId, externalId: externalId(tx.transaction_id), title: label(tx.merchant_name ?? tx.name, "Bank transaction"),
    // Plaid positive means money out; CashLoom positive means money in.
    amountMinor: (-BigInt(plaidUsdMinor(tx.amount))).toString(), currency: "USD", date: day(tx.date),
    status: tx.pending ? "pending" : "posted", pendingExternalId: tx.pending_transaction_id == null ? null : externalId(tx.pending_transaction_id),
    providerCategory: category ? label(category.primary, "") || null : null,
  };
}

export interface PlaidDependencies {
  readonly db: Database;
  readonly assertOwner: (sessionToken: string) => void;
  readonly sealToken: (binding: ProviderTokenBinding, token: string) => Promise<Uint8Array>;
  readonly unsealToken: (binding: ProviderTokenBinding, blob: Uint8Array) => Promise<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export function createPlaidSandboxService(deps: PlaidDependencies) {
  const { db } = deps; const http = createPlaidHttp(deps); const now = deps.now ?? (() => new Date());
  const at = () => now().toISOString();
  const owner = (session: string) => { try { deps.assertOwner(session); } catch { throw new PlaidError("PLAID_OWNER_REQUIRED"); } };
  const item = (id: string): ItemRow => {
    const result = db.query("SELECT id,provider_item_id,state,account_count FROM connect_plaid_items WHERE id=?").get(uuid(id)) as ItemRow | null;
    if (!result) throw new PlaidError("PLAID_ITEM_NOT_FOUND"); return result;
  };
  const active = (id: string) => { const value = item(id); if (["disconnect_pending", "disconnected"].includes(value.state)) throw new PlaidError("PLAID_ITEM_DISABLED"); if (value.state === "reconnect_required") throw new PlaidError("PLAID_RECONNECT_REQUIRED"); return value; };
  const binding = (id: string): ProviderTokenBinding => ({ provider: "plaid-sandbox", itemId: id });
  const token = async (id: string, session: string) => {
    owner(session);
    const row = db.query("SELECT enc_blob FROM connect_provider_tokens WHERE item_id=? AND provider='plaid-sandbox'").get(id) as { enc_blob: Uint8Array } | null;
    if (!row) throw new PlaidError("PLAID_TOKEN_UNAVAILABLE");
    let value: string;
    try { value = await deps.unsealToken(binding(id), row.enc_blob); } catch { throw new PlaidError("PLAID_TOKEN_UNAVAILABLE"); }
    owner(session);
    if (!/^access-sandbox-[A-Za-z0-9-]{1,256}$/.test(value)) throw new PlaidError("PLAID_TOKEN_UNAVAILABLE");
    return value;
  };
  const accountsFor = async (record: ItemRow, accessToken: string, session: string) => {
    owner(session); active(record.id);
    const result = await http.post("/accounts/get", { access_token: accessToken }); owner(session); active(record.id);
    if (externalId(object(result.item).item_id) !== record.provider_item_id) throw new PlaidError("PLAID_INVALID_DATA");
    const snapshot = plaidAccounts(result.accounts);
    const supported = new Set(snapshot.accounts.map(account => account.externalAccountId));
    const saved = db.query("SELECT external_account_id FROM accounts WHERE read_connection_id=?").all(record.id) as Array<{ external_account_id: string }>;
    // Reduced consent or changed denomination must not silently leave a stale
    // account looking connected while the cursor advances past its changes.
    if (saved.some(account => !supported.has(account.external_account_id))) throw new PlaidError("PLAID_RECONNECT_REQUIRED");
    return snapshot;
  };
  const recordError = (id: string, error: unknown) => {
    if (!(error instanceof PlaidError) || error.code === "PLAID_OWNER_REQUIRED") return;
    const state = item(id).state;
    if (["disconnect_pending", "disconnected"].includes(state)) return;
    db.transaction(() => {
      db.query("UPDATE connect_plaid_items SET error_code=?,state=?,updated_at=? WHERE id=?").run(error.code, error.code === "PLAID_RECONNECT_REQUIRED" ? "reconnect_required" : state, at(), id);
      if (error.code === "PLAID_RECONNECT_REQUIRED") setReadConnectionStatus(db, id, "reconnect_required", error.code);
    })();
  };
  const completeImport = async (id: string, session: string) => {
    const record = active(id); const current = getReadSyncState(db, id); const accessToken = await token(id, session);
    const snapshot = await accountsFor(record, accessToken, session);
    if (!snapshot.accounts.length) throw new PlaidError("PLAID_NO_SUPPORTED_ACCOUNTS");
    owner(session);
    db.transaction(() => {
      active(id);
      applyReadSync(db, { connectionId: id, expectedRevision: current.revision, expectedCursor: current.cursor, nextCursor: current.cursor, observedAt: at(), accounts: snapshot.accounts, transactions: [] });
      db.query("UPDATE connect_plaid_items SET state='connected',account_count=?,error_code=NULL,updated_at=? WHERE id=?").run(snapshot.accounts.length, at(), id);
      db.query("UPDATE connect_plaid_link_attempts SET state='completed' WHERE item_id=? AND state='import_pending'").run(id);
    })();
    return { item_id: id, account_count: snapshot.accounts.length, state: "connected" as const };
  };
  return {
    status(): { environment: "sandbox"; configured: boolean; items: PlaidItemView[] } {
      const items = db.query("SELECT id,state,account_count,last_synced_at,error_code FROM connect_plaid_items ORDER BY created_at DESC,id").all() as Omit<PlaidItemView, "label">[];
      return { environment: "sandbox", configured: http.configured(), items: items.map(value => ({ ...value, label: "Plaid sandbox bank" })) };
    },
    async createLink(session: string) {
      owner(session); const attemptId = crypto.randomUUID();
      const result = await http.post("/link/token/create", { client_name: "CashLoom sandbox", language: "en", country_codes: ["US"], products: ["transactions"],
        user: { client_user_id: `cashloom-${attemptId}` },
        account_filters: { depository: { account_subtypes: ["checking", "savings"] }, credit: { account_subtypes: ["credit card"] } },
      });
      owner(session);
      if (typeof result.link_token !== "string" || !/^link-sandbox-[A-Za-z0-9-]{1,256}$/.test(result.link_token) || typeof result.expiration !== "string") throw new PlaidError("PLAID_INVALID_DATA");
      const expiration = Date.parse(result.expiration); const current = now().getTime();
      if (!Number.isFinite(expiration) || expiration <= current) throw new PlaidError("PLAID_INVALID_DATA");
      const expiresAt = new Date(Math.min(expiration, current + 15 * 60_000)).toISOString();
      db.query("INSERT INTO connect_plaid_link_attempts(id,session_hash,state,expires_at,created_at) VALUES(?,?,'pending',?,?)").run(attemptId, hash(session), expiresAt, at());
      return { attempt_id: attemptId, link_token: result.link_token, expires_at: expiresAt, environment: "sandbox" as const };
    },
    async exchange(session: string, input: { attempt_id: string; public_token: string }) {
      owner(session); uuid(input.attempt_id);
      if (typeof input.public_token !== "string" || !/^public-sandbox-[A-Za-z0-9-]{1,256}$/.test(input.public_token)) throw new PlaidError("PLAID_INVALID_REQUEST");
      const digest = hash(input.public_token);
      const attempt = db.query("SELECT id,session_hash,state,public_token_hash,item_id,expires_at FROM connect_plaid_link_attempts WHERE id=?").get(input.attempt_id) as AttemptRow | null;
      if (!attempt || attempt.session_hash !== hash(session) || (attempt.public_token_hash && attempt.public_token_hash !== digest)) throw new PlaidError("PLAID_LINK_CONFLICT");
      if (attempt.state === "completed" && attempt.item_id) { const current = item(attempt.item_id); return { item_id: current.id, account_count: current.account_count, state: current.state, replayed: true }; }
      if (attempt.state === "import_pending" && attempt.item_id) {
        try { return { ...await completeImport(attempt.item_id, session), replayed: true }; }
        catch (error) {
          recordError(attempt.item_id, error);
          if (error instanceof ReadSyncConflict) throw new PlaidError("PLAID_SYNC_CHANGED");
          if (error instanceof PlaidError) throw error;
          throw new PlaidError("PLAID_INVALID_DATA");
        }
      }
      if (attempt.state !== "pending") throw new PlaidError("PLAID_EXCHANGE_UNCERTAIN");
      if (attempt.expires_at <= at()) throw new PlaidError("PLAID_LINK_EXPIRED");
      try {
        const changed = db.query("UPDATE connect_plaid_link_attempts SET state='exchanging',public_token_hash=? WHERE id=? AND state='pending'").run(digest, attempt.id);
        if (changed.changes !== 1) throw new PlaidError("PLAID_LINK_CONFLICT");
      } catch { throw new PlaidError("PLAID_LINK_CONFLICT"); }
      let id: string | undefined;
      try {
        const result = await http.post("/item/public_token/exchange", { public_token: input.public_token }); owner(session);
        const providerId = externalId(result.item_id);
        if (typeof result.access_token !== "string" || !/^access-sandbox-[A-Za-z0-9-]{1,256}$/.test(result.access_token)) throw new PlaidError("PLAID_INVALID_DATA");
        id = crypto.randomUUID();
        const sealed = await deps.sealToken(binding(id), result.access_token); owner(session);
        db.transaction(() => {
          createReadConnection(db, { id, provider: "plaid", environment: "sandbox", displayName: "Plaid sandbox bank" });
          db.query("INSERT INTO connect_plaid_items(id,provider_item_id,state,created_at,updated_at) VALUES(?,?,'setup_pending',?,?)").run(id!, providerId, at(), at());
          db.query("INSERT INTO connect_provider_tokens(item_id,provider,enc_blob,created_at) VALUES(?,'plaid-sandbox',?,?)").run(id!, sealed, at());
          db.query("UPDATE connect_plaid_link_attempts SET state='import_pending',item_id=? WHERE id=? AND state='exchanging'").run(id!, attempt.id);
        })();
        return { ...await completeImport(id, session), replayed: false };
      } catch (error) {
        const saved = db.query("SELECT item_id FROM connect_plaid_link_attempts WHERE id=?").get(attempt.id) as { item_id: string | null };
        if (saved.item_id) recordError(saved.item_id, error);
        else db.query("UPDATE connect_plaid_link_attempts SET state='uncertain' WHERE id=? AND state='exchanging'").run(attempt.id);
        if (error instanceof ReadSyncConflict) throw new PlaidError("PLAID_SYNC_CHANGED");
        if (error instanceof PlaidError) throw error;
        throw new PlaidError("PLAID_EXCHANGE_UNCERTAIN");
      }
    },
    async sync(session: string, id: string) {
      owner(session); const record = active(id); const accessToken = await token(id, session);
      try {
        const current = getReadSyncState(db, id);
        const snapshot = await accountsFor(record, accessToken, session);
        if (!snapshot.accounts.length) throw new PlaidError("PLAID_NO_SUPPORTED_ACCOUNTS");
        const supported = new Set(snapshot.accounts.map(account => account.externalAccountId));
        let final: { cursor: string | null; transactions: ReadTransactionInput[]; removed: ReadRemoval[] } | undefined;
        for (let restart = 0; restart < 2 && !final; restart++) {
          let cursor = current.cursor; const transactions = new Map<string, ReadTransactionInput>(); const removals = new Map<string, ReadRemoval>();
          try {
            for (let page = 0; page < 100; page++) {
              const response = await http.post("/transactions/sync", { access_token: accessToken, count: 500, ...(cursor === null ? {} : { cursor }) }); owner(session); active(id);
              if (typeof response.next_cursor !== "string" || response.next_cursor.length > 4096 || typeof response.has_more !== "boolean") throw new PlaidError("PLAID_INVALID_DATA");
              for (const key of ["added", "modified", "removed"] as const) if (!Array.isArray(response[key]) || (response[key] as unknown[]).length > 1000) throw new PlaidError("PLAID_INVALID_DATA");
              for (const raw of [...response.added as unknown[], ...response.modified as unknown[]]) {
                const tx = plaidTransaction(raw, snapshot.allIds, supported); if (!tx) continue;
                transactions.set(tx.externalId, tx); removals.delete(tx.externalId);
              }
              for (const raw of response.removed as unknown[]) {
                const removal = object(raw); const txId = externalId(removal.transaction_id);
                const accountId = removal.account_id == null ? undefined : externalId(removal.account_id);
                if (accountId && !snapshot.allIds.has(accountId)) throw new PlaidError("PLAID_INVALID_DATA");
                if (accountId && !supported.has(accountId)) continue;
                transactions.delete(txId); removals.set(txId, { externalId: txId, ...(accountId ? { externalAccountId: accountId } : {}) });
              }
              if (transactions.size + removals.size > 50_000) throw new PlaidError("PLAID_SYNC_TOO_LARGE");
              if (!response.has_more) {
                if (response.next_cursor === "" && (transactions.size || removals.size || current.cursor !== null)) throw new PlaidError("PLAID_INVALID_DATA");
                final = { cursor: response.next_cursor || null, transactions: [...transactions.values()], removed: [...removals.values()] }; break;
              }
              if (!response.next_cursor || response.next_cursor === cursor) throw new PlaidError("PLAID_INVALID_DATA"); cursor = response.next_cursor;
            }
            if (!final) throw new PlaidError("PLAID_SYNC_TOO_LARGE");
          } catch (error) { if (!(error instanceof PlaidError) || error.code !== "PLAID_SYNC_CHANGED" || restart === 1) throw error; }
        }
        if (!final) throw new PlaidError("PLAID_SYNC_CHANGED"); owner(session);
        const saved = db.transaction(() => {
          active(id);
          const result = applyReadSync(db, { connectionId: id, expectedRevision: current.revision, expectedCursor: current.cursor, nextCursor: final!.cursor, observedAt: at(), accounts: snapshot.accounts, transactions: final!.transactions, removed: final!.removed });
          db.query("UPDATE connect_plaid_items SET state='connected',account_count=?,last_synced_at=?,error_code=NULL,updated_at=? WHERE id=?").run(snapshot.accounts.length, at(), at(), id);
          db.query("UPDATE connect_plaid_link_attempts SET state='completed' WHERE item_id=? AND state='import_pending'").run(id);
          return result;
        })();
        return { item_id: id, imported: saved.imported, updated: saved.updated, removed: saved.removed, skipped: saved.skipped, account_count: snapshot.accounts.length };
      } catch (error) { recordError(id, error); if (error instanceof ReadSyncConflict) throw new PlaidError("PLAID_SYNC_CHANGED"); if (error instanceof PlaidError) throw error; throw new PlaidError("PLAID_INVALID_DATA"); }
    },
    async disconnect(session: string, id: string) {
      owner(session); const record = item(id);
      if (record.state === "disconnected") return { item_id: id, local_disabled: true as const, provider_revoked: true, state: "disconnected" as const };
      db.transaction(() => {
        setReadConnectionStatus(db, id, "disconnected");
        db.query("UPDATE connect_plaid_items SET state='disconnect_pending',error_code=NULL,updated_at=? WHERE id=?").run(at(), id);
      })();
      try {
        const accessToken = await token(id, session);
        await http.post("/item/remove", { access_token: accessToken }); owner(session);
        db.transaction(() => {
          db.query("DELETE FROM connect_provider_tokens WHERE item_id=?").run(id);
          db.query("UPDATE connect_plaid_items SET state='disconnected',error_code=NULL,updated_at=? WHERE id=?").run(at(), id);
        })();
        return { item_id: id, local_disabled: true as const, provider_revoked: true, state: "disconnected" as const };
      } catch (error) {
        if (error instanceof PlaidError && error.code === "PLAID_OWNER_REQUIRED") throw error;
        db.query("UPDATE connect_plaid_items SET error_code=?,updated_at=? WHERE id=? AND state='disconnect_pending'").run(error instanceof PlaidError ? error.code : "PLAID_PROVIDER_UNAVAILABLE", at(), id);
        return { item_id: id, local_disabled: true as const, provider_revoked: false, state: "disconnect_pending" as const };
      }
    },
  };
}
