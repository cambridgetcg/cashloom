import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { BASE_CHAIN_ID, BASE_ETH_ASSET_ID, resolveBaseAccount } from "../wallet/base-account-projection.ts";
import { walletConnectSetup, type WalletConnectSetup } from "./walletconnect-config.ts";

const refusals = {
  crypto_watch_invalid_request: [400, "Choose Base, a public address, and an account name of 1 to 120 characters."],
  crypto_watch_invalid_address: [400, "Enter a valid EVM public address. Mixed-case addresses must have a valid checksum."],
  crypto_watch_identity_conflict: [409, "An active account for this Base address has an incompatible identity. Review it in Accounts before adding another."],
  crypto_watch_owner_required: [403, "An owner session with account-management access is required."],
  crypto_watch_body_too_large: [413, "The watch-account request is too large."],
  crypto_watch_failed: [500, "The watch account could not be confirmed. Review Accounts or retry the same address before starting another request."],
} as const;

export class CryptoWatchError extends Error {
  readonly status: typeof refusals[keyof typeof refusals][0];
  constructor(readonly code: keyof typeof refusals) {
    const [status, message] = refusals[code];
    super(message);
    this.status = status;
  }
}

const inputSchema = z.object({
  network: z.literal("base"),
  address: z.string().trim().length(42),
  display_name: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();

/** The same saved account projection used by Accounts, with no key material. */
export interface CryptoWatchAccount {
  id: string; rail: string; connector_type: string | null; display_name: string;
  currency: string; decimals: number; balance_minor: string; balance_as_of: string | null;
  external_account_id: string | null; chain_id: string | null; asset_id: string | null;
  account_ref: string | null; credential_ref: string | null; vault_key_id: string | null;
  status: string; created_at: string; read_connection_id: string | null;
  available_minor: string | null; pending_minor: string | null; held_minor: string | null;
  balance_kind: string; read_environment: string; read_observed_at: string | null;
  account_mask: string | null; account_type: string | null; read_connection_status: string | null;
}
export interface CryptoWatchResult { account: CryptoWatchAccount; created: boolean }

const accountFields = `a.id,a.rail,a.connector_type,a.display_name,a.currency,a.decimals,a.balance_minor,a.balance_as_of,
  a.external_account_id,a.chain_id,a.asset_id,a.account_ref,a.credential_ref,a.vault_key_id,a.status,a.created_at,
  a.read_connection_id,a.available_minor,a.pending_minor,a.held_minor,a.balance_kind,a.read_environment,
  a.read_observed_at,a.account_mask,a.account_type,r.status AS read_connection_status`;

/** Save an address, not an ownership claim. The immediate transaction makes
 * parallel requests and retries reuse one active identity without a new ledger.
 * No observer, network client, key decryption, or kernel mutation is called. */
export function createCryptoWatchAccount(db: Database, input: unknown, assertOwner: () => void): CryptoWatchResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CryptoWatchError("crypto_watch_invalid_request");
  const body = parsed.data;
  if (!isAddress(body.address, { strict: false })) throw new CryptoWatchError("crypto_watch_invalid_address");
  const letters = body.address.slice(2).replace(/[0-9]/g, "");
  const mixedCase = letters !== letters.toLowerCase() && letters !== letters.toUpperCase();
  if (mixedCase && getAddress(body.address.toLowerCase()) !== body.address) throw new CryptoWatchError("crypto_watch_invalid_address");
  const address = body.address.toLowerCase();
  const accountRef = `${BASE_CHAIN_ID}:${address}`;

  return db.transaction(() => {
    assertOwner();
    // A malformed Base identity with this public address is a conflict, not
    // permission to hide it behind another account. Other networks remain distinct.
    const candidates = db.query(`SELECT a.id FROM accounts a LEFT JOIN vault_keys k ON k.id=a.vault_key_id
      WHERE a.status='ACTIVE' AND a.chain_id=? AND
        (lower(a.account_ref)=? OR lower(a.account_ref)=? OR lower(a.external_account_id)=? OR lower(k.address)=?)
      ORDER BY a.created_at,a.id`).all(BASE_CHAIN_ID, accountRef, address, address, address) as { id: string }[];
    for (const candidate of candidates) {
      try {
        if (resolveBaseAccount(db, candidate.id).accountRef !== accountRef) throw new Error();
      } catch { throw new CryptoWatchError("crypto_watch_identity_conflict"); }
    }
    assertOwner();
    const existing = candidates[0];
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      db.query(`INSERT INTO accounts(id,rail,display_name,currency,decimals,chain_id,asset_id,account_ref,read_environment)
        VALUES(?,'CRYPTO',?,'ETH',18,?,?,?,'live')`).run(id, body.display_name, BASE_CHAIN_ID, BASE_ETH_ASSET_ID, accountRef);
    }
    const account = db.query(`SELECT ${accountFields} FROM accounts a
      LEFT JOIN read_connections r ON r.id=a.read_connection_id WHERE a.id=?`).get(id) as CryptoWatchAccount;
    return { account, created: !existing };
  }).immediate();
}

const BODY_LIMIT = 4096;
async function jsonBody(c: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) throw new CryptoWatchError("crypto_watch_invalid_request");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new CryptoWatchError("crypto_watch_invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new CryptoWatchError("crypto_watch_body_too_large");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CryptoWatchError("crypto_watch_invalid_request"); }
}

export function createCryptoWatchRoutes(options: { db: Database; canManage(context: Context): boolean; walletConnectSetup?: () => WalletConnectSetup }): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const refusal = error instanceof CryptoWatchError ? error : new CryptoWatchError("crypto_watch_failed");
    c.header("Cache-Control", "private, no-store");
    return c.json({ error: refusal.code, message: refusal.message }, refusal.status);
  });
  app.get("/walletconnect", (c) => {
    c.header("Cache-Control", "private, no-store");
    if (!options.canManage(c)) throw new CryptoWatchError("crypto_watch_owner_required");
    return c.json((options.walletConnectSetup ?? walletConnectSetup)());
  });
  app.post("/watch", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const owner = () => { if (!options.canManage(c)) throw new CryptoWatchError("crypto_watch_owner_required"); };
    owner();
    const body = await jsonBody(c);
    owner();
    const result = createCryptoWatchAccount(options.db, body, owner);
    return c.json(result, result.created ? 201 : 200);
  });
  return app;
}
