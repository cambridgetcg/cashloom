/** Fixed sandbox transport. Error bodies are never exposed or logged. */
export const PLAID_SANDBOX_ORIGIN = "https://sandbox.plaid.com";
export type PlaidPath = "/link/token/create" | "/item/public_token/exchange" | "/accounts/get" | "/transactions/sync" | "/item/remove";

const errors = {
  PLAID_NOT_CONFIGURED: [503, "Configure Plaid sandbox credentials before connecting a test bank."],
  PLAID_OWNER_REQUIRED: [403, "An active owner session with account-management access is required."],
  PLAID_INVALID_REQUEST: [400, "The sandbox connection request is invalid."],
  PLAID_LINK_EXPIRED: [409, "This Link attempt expired. Start a new sandbox connection."],
  PLAID_LINK_CONFLICT: [409, "This Link attempt has already been used or belongs to another session."],
  PLAID_EXCHANGE_UNCERTAIN: [409, "The token exchange outcome is uncertain. Start a new sandbox connection; this attempt will not be exchanged again."],
  PLAID_ITEM_NOT_FOUND: [404, "This sandbox connection was not found."],
  PLAID_ITEM_DISABLED: [409, "This connection is disabled. Start a new sandbox connection to reconnect."],
  PLAID_RECONNECT_REQUIRED: [409, "The provider requires a new connection. Disconnect this test item, then link again."],
  PLAID_PROVIDER_UNAVAILABLE: [502, "Plaid sandbox did not provide a usable response. Try again later."],
  PLAID_RATE_LIMITED: [429, "Plaid sandbox is limiting requests. Try again later."],
  PLAID_INVALID_DATA: [502, "Plaid sandbox returned unsupported or inconsistent data. Nothing was imported."],
  PLAID_SYNC_CHANGED: [409, "Transactions changed during pagination. No changes were saved; retry the sync."],
  PLAID_SYNC_TOO_LARGE: [422, "This transaction update exceeds the sandbox import limit. Nothing was imported."],
  PLAID_NO_SUPPORTED_ACCOUNTS: [422, "This sandbox connection has no supported USD checking, savings, or credit-card accounts."],
  PLAID_TOKEN_UNAVAILABLE: [409, "The encrypted provider token is unavailable. Unlock the original vault or disconnect this item."],
} as const;
export type PlaidErrorCode = keyof typeof errors;
export class PlaidError extends Error {
  readonly status: number;
  constructor(readonly code: PlaidErrorCode) {
    super(errors[code][1]); this.name = "PlaidError"; this.status = errors[code][0];
  }
}

const paths = new Set<PlaidPath>(["/link/token/create", "/item/public_token/exchange", "/accounts/get", "/transactions/sync", "/item/remove"]);
export function createPlaidHttp(deps: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
} = {}) {
  const env = deps.env ?? process.env;
  const fetcher = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 12_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Invalid sandbox request timeout.");
  const configured = () => Boolean(env.PLAID_CLIENT_ID?.trim() && env.PLAID_SANDBOX_SECRET?.trim());
  return {
    configured,
    async post(path: PlaidPath, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!paths.has(path)) throw new PlaidError("PLAID_INVALID_REQUEST");
      if (!configured()) throw new PlaidError("PLAID_NOT_CONFIGURED");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PlaidError("PLAID_PROVIDER_UNAVAILABLE")); }, timeoutMs);
      });
      const request = async () => {
        const response = await fetcher(`${PLAID_SANDBOX_ORIGIN}${path}`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
          body: JSON.stringify({ ...body, client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SANDBOX_SECRET }),
        });
        if (response.redirected || (response.url && new URL(response.url).origin !== PLAID_SANDBOX_ORIGIN)) throw new PlaidError("PLAID_PROVIDER_UNAVAILABLE");
        const reader = response.body?.getReader();
        if (!reader) throw new PlaidError("PLAID_PROVIDER_UNAVAILABLE");
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.length;
            if (length > 4_194_304) { await reader.cancel(); throw new PlaidError("PLAID_INVALID_DATA"); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let data: unknown;
        try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PlaidError("PLAID_PROVIDER_UNAVAILABLE"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new PlaidError("PLAID_INVALID_DATA");
        const value = data as Record<string, unknown>;
        if (!response.ok || typeof value.error_code === "string") {
          if (value.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") throw new PlaidError("PLAID_SYNC_CHANGED");
          if (value.error_code === "ITEM_LOGIN_REQUIRED" || value.error_code === "USER_PERMISSION_REVOKED") throw new PlaidError("PLAID_RECONNECT_REQUIRED");
          if (response.status === 429) throw new PlaidError("PLAID_RATE_LIMITED");
          throw new PlaidError("PLAID_PROVIDER_UNAVAILABLE");
        }
        return value;
      };
      try { return await Promise.race([request(), deadline]); }
      catch (error) { if (error instanceof PlaidError) throw error; throw new PlaidError("PLAID_PROVIDER_UNAVAILABLE"); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
