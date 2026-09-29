import type {
  AgreementTerms,
  EvidenceInput,
  TradeRecord,
  TradeEventPage,
  TradeMutation,
  SimulationRun,
  SimulationCommand,
  Account,
  BasePositionRefreshResult,
  ConfirmResult,
  CreateAccountInput,
  ConnectionsResponse,
  ImportPreview,
  DistinctImportRow,
  PlaidLinkStart,
  TransferCandidate,
  TransferLink,
  Meta,
  PaymentListItem,
  PaymentTruth,
  PaymentReconcileResult,
  Quote,
  SummaryRow,
  SyncResult,
  Tx,
  VaultKey,
  WalletIntentAudit,
  WalletIntegrationCatalog,
  WalletPositionsResponse,
  ZeroneGuide,
  ZeroneStatus,
} from "./types";
import type { SessionInspection } from "./session-lifecycle";

/**
 * Session token lives in module memory + sessionStorage: a refresh survives,
 * a closed tab forgets. Any 401 drops the session and returns you to the gate.
 */
const STORAGE_KEY = "cashloom.session";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let token: string | null = readStored();
let sessionLostHandler: (() => void) | null = null;

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) sessionStorage.setItem(STORAGE_KEY, t);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — memory alone still works for this tab */
  }
}

export function hasToken(): boolean {
  return token !== null;
}

/** A callback may outlive its screen or a lock/unlock cycle. No token leaves this module. */
export function currentSessionGuard(): () => boolean {
  const startedWith = token;
  return () => startedWith !== null && token === startedWith;
}

export function onSessionLost(fn: () => void): void {
  sessionLostHandler = fn;
}

export class ApiError extends Error {
  code: string | undefined;
  status: number | undefined;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) {
    return e.message === "Failed to fetch"
      ? "Can't reach your node. Is it running?"
      : e.message;
  }
  return "Something went wrong.";
}

/** Inspect only this caller's session, without reading wallet data or renewing
 * it. The lifecycle owner bounds/aborts the request and decides when to unmount. */
export async function inspectVaultSession(signal: AbortSignal): Promise<SessionInspection> {
  const requestToken = token;
  const isCurrent = () => token === requestToken;
  if (!requestToken) return { status: "invalid", isCurrent };
  try {
    const response = await fetch("/api/vault/session", {
      headers: { Authorization: `Bearer ${requestToken}` },
      cache: "no-store",
      signal,
    });
    if (!isCurrent()) return { status: "stale" };
    if (response.status === 401) return { status: "invalid", isCurrent };
    if (!response.ok) throw new ApiError("Your node could not confirm this session.", undefined, response.status);
    const data = await response.json();
    if (!isCurrent()) return { status: "stale" };
    const expiresAt = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
    const serverTime = typeof data?.serverTime === "string" ? Date.parse(data.serverTime) : NaN;
    if (!Number.isFinite(expiresAt) || !Number.isFinite(serverTime)) {
      throw new ApiError("Your node returned an unreadable session status.");
    }
    return { status: "valid", expiresAt, serverTime, isCurrent };
  } catch (error) {
    if (!isCurrent()) return { status: "stale" };
    throw error;
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const requestToken = token;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestToken) headers["Authorization"] = `Bearer ${requestToken}`;

  const res = await fetch(path, {
    method: body !== undefined ? "POST" : "GET",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  type ErrorBody = { error?: string | { code?: string; message?: string }; message?: string };
  let data: ErrorBody | null = null;
  try {
    data = (await res.json()) as ErrorBody;
  } catch {
    /* non-JSON response */
  }
  const publicResponse = path === "/api/meta" || path === "/api/vault/init" || path === "/api/vault/unlock";
  if (token !== requestToken && !publicResponse) {
    // A component may have unmounted while this request was in flight. Never
    // return old private records or server error details to its callbacks/toasts.
    // Explicit lock clears the local token immediately; keep only its fixed ack.
    if (path === "/api/vault/lock" && body !== undefined && res.ok &&
        data !== null && typeof data === "object" && "ok" in data && data.ok === true) {
      return { ok: true } as T;
    }
    throw new ApiError("Your session changed. Reopen the view to check the result.", "session_changed");
  }
  const nested = data?.error && typeof data.error === "object" ? data.error : null;
  const code = nested?.code ?? (typeof data?.error === "string" ? data.error : undefined);
  const message = nested?.message ?? data?.message;

  if (res.status === 401) {
    // An old request must not discard a session unlocked while it was in flight.
    if (token === requestToken) {
      setToken(null);
      sessionLostHandler?.();
    }
    throw new ApiError(message ?? "The vault is locked.", code, res.status);
  }
  if (!res.ok) {
    throw new ApiError(message ?? code ?? `Request failed (${res.status})`, code, res.status);
  }
  // A successful non-JSON mutation response is still an unknown outcome. Never
  // discard its retry key by treating an absent response as a completed command.
  if (data === null) throw new ApiError("Your node returned no readable result. Retry the exact request.", undefined, res.status);
  return data as T;
}

export const api = {
  meta: () => request<Meta>("/api/meta"),

  vaultInit: (passphrase: string) =>
    request<{ ok: boolean; token: string }>("/api/vault/init", { passphrase }),
  vaultUnlock: (passphrase: string) =>
    request<{ ok: boolean; token: string }>("/api/vault/unlock", { passphrase }),
  vaultLock: () => request<{ ok: boolean }>("/api/vault/lock", {}),

  keys: () => request<{ keys: VaultKey[] }>("/api/vault/keys"),
  createKey: (body: {
    label: string;
    action: "generate" | "import";
    kind?: "evm" | "btc";
    privHex?: string; // evm import
    secret?: string; // btc import: WIF or 64-hex
  }) => request<{ key: VaultKey }>("/api/vault/keys", body),

  accounts: (opts: { includeArchived?: boolean } = {}) =>
    request<{ accounts: Account[] }>(`/api/accounts${opts.includeArchived === undefined ? "" : `?includeArchived=${opts.includeArchived}`}`),
  createAccount: (body: CreateAccountInput) =>
    request<{ account: Account }>("/api/accounts", body),
  archiveAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/archive`, {}),
  recordAccountBalance: (id: string, body: { balance_minor: string; expected_balance_minor: string; expected_balance_as_of: string | null }) =>
    request<{ account: Account }>(`/api/accounts/${encodeURIComponent(id)}/balance`, body),
  syncAccount: (id: string) =>
    request<SyncResult>(`/api/accounts/${encodeURIComponent(id)}/sync`, {}),

  transactions: (opts: { accountId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.accountId) q.set("accountId", opts.accountId);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return request<{ transactions: Tx[] }>(`/api/transactions${qs ? `?${qs}` : ""}`);
  },
  createTransaction: (body: {
    account_id: string;
    title: string;
    amount_minor: string;
    date?: string;
    category?: string;
  }) => request<{ transaction: Tx }>("/api/transactions", body),

  summary: () => request<{ accounts: SummaryRow[] }>("/api/analytics/summary"),

  payQuote: (body: { accountId: string; to: string; amountMinor: string; asset: string }) =>
    request<Quote>("/api/pay/quote", body),
  payConfirm: (paymentId: string) =>
    request<ConfirmResult>("/api/pay/confirm", { paymentId }),
  payRecover: async (paymentId: string): Promise<ConfirmResult> => {
    let result: ConfirmResult;
    try {
      result = await request<ConfirmResult>("/api/pay/recover", { paymentId });
    } catch (error) {
      if (error instanceof ApiError && error.status !== undefined && error.status >= 200 && error.status < 300) {
        throw new ApiError("Recovery outcome could not be read. Reload payment activity before another action.", "recovery_outcome_unknown", error.status);
      }
      throw error;
    }
    if (!result || result.paymentId !== paymentId || !["broadcast", "confirmed", "failed"].includes(result.status)
      || (result.txHash !== null && typeof result.txHash !== "string")
      || (result.error !== null && typeof result.error !== "string")) {
      throw new ApiError("Recovery outcome could not be read. Reload payment activity before another action.", "recovery_outcome_unknown");
    }
    return result;
  },

  payments: () => request<{ payments: PaymentListItem[] }>("/api/payments"),
  walletIntegrations: () =>
    request<WalletIntegrationCatalog>("/api/wallet/v3/integrations"),
  connections: () => request<ConnectionsResponse>("/api/connections"),
  plaidLink: () => request<PlaidLinkStart>("/api/connections/plaid/link", {}),
  plaidExchange: (attemptId: string, publicToken: string) =>
    request<{ item_id: string; account_count: number; state: string; replayed: boolean }>("/api/connections/plaid/exchange", { attempt_id: attemptId, public_token: publicToken }),
  plaidSync: (id: string) => request<{ imported: number; updated?: number; removed?: number }>(`/api/connections/plaid/${encodeURIComponent(id)}/sync`, {}),
  plaidDisconnect: (id: string) => request<{ local_disabled: boolean; provider_revoked: boolean; state: string }>(`/api/connections/plaid/${encodeURIComponent(id)}/disconnect`, {}),
  transferReview: () => request<{ can_manage?: boolean; candidates: TransferCandidate[]; links: TransferLink[] }>("/api/transfers"),
  linkTransfer: (outgoingId: string, incomingId: string) => request<{ link: TransferLink }>("/api/transfers/link", { outgoing_id: outgoingId, incoming_id: incomingId }),
  unlinkTransfer: (id: string) => request<{ ok: boolean }>(`/api/transfers/${encodeURIComponent(id)}/unlink`, {}),
  previewImport: (accountId: string, csv: string, distinctRows?: DistinctImportRow[]) => request<ImportPreview>("/api/transactions/import/preview", { account_id: accountId, csv, distinct_rows: distinctRows }),
  importTransactions: (accountId: string, csv: string, previewHash: string, distinctRows?: DistinctImportRow[]) =>
    request<{ imported: number; skipped: number; account_id: string }>("/api/transactions/import", { account_id: accountId, csv, preview_hash: previewHash, distinct_rows: distinctRows }),
  exportTransactions: (accountId?: string) => request<Record<string, unknown>>(`/api/transactions/export${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`),
  walletPositions: () =>
    request<WalletPositionsResponse>("/api/wallet/v3/positions"),
  refreshBasePositions: (accountId: string) =>
    request<BasePositionRefreshResult>(
      `/api/wallet/v2/accounts/${encodeURIComponent(accountId)}/base-positions/refresh`,
      {},
    ),
  walletIntentAudit: (intentId: string) =>
    request<WalletIntentAudit>(
      `/api/wallet/v2/intents/${encodeURIComponent(intentId)}`,
    ),
  reconcileBasePayment: (intentId: string) =>
    request<PaymentReconcileResult | PaymentTruth>(
      `/api/wallet/v2/intents/${encodeURIComponent(intentId)}/reconcile`,
      {},
    ),

  trades: (after = 0) => request<{ trades: TradeRecord[]; nextCursor: number | null }>(`/api/tcg/trades?after=${after}&limit=50`),
  trade: (id: string) => request<{ trade: TradeRecord }>(`/api/tcg/trades/${encodeURIComponent(id)}`),
  createTrade: (body: TradeMutation & { expectedVersion: 0; terms: AgreementTerms }) =>
    request<{ trade: TradeRecord }>("/api/tcg/trades", body),
  reviseTrade: (id: string, body: TradeMutation & { terms: AgreementTerms }) =>
    request<{ trade: TradeRecord }>(`/api/tcg/trades/${encodeURIComponent(id)}/revisions`, body),
  tradeEvidence: (id: string, body: TradeMutation & { revision: number; evidence: EvidenceInput }) =>
    request<{ trade: TradeRecord }>(`/api/tcg/trades/${encodeURIComponent(id)}/evidence`, body),
  tradeHistory: (id: string, after = 0) =>
    request<TradeEventPage>(`/api/tcg/trades/${encodeURIComponent(id)}/history?after=${after}&limit=50`),
  tradeSimulations: (after = 0) => request<{ simulations: SimulationRun[]; nextCursor: number | null }>(`/api/tcg/simulations?after=${after}&limit=50`),
  tradeSimulation: (id: string) =>
    request<{ simulation: SimulationRun }>(`/api/tcg/simulations/${encodeURIComponent(id)}`),
  tradeSimulationHistory: (id: string, after = 0) =>
    request<TradeEventPage>(`/api/tcg/simulations/${encodeURIComponent(id)}/history?after=${after}&limit=50`),
  createTradeSimulation: (body: TradeMutation & { expectedVersion: 0; tradeId: string; revision: number }) =>
    request<{ simulation: SimulationRun }>("/api/tcg/simulations", body),
  tradeSimulationCommand: (id: string, body: TradeMutation & { command: SimulationCommand }) =>
    request<{ simulation: SimulationRun }>(`/api/tcg/simulations/${encodeURIComponent(id)}/commands`, body),

  // zerone front — public, read-only (works with or without a vault session).
  zeroneGuide: () => request<ZeroneGuide>("/api/zerone/guide"),
  zeroneStatus: () => request<ZeroneStatus>("/api/zerone/status"),
};
