import type {
  Account,
  ConfirmResult,
  CreateAccountInput,
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
  ZeroneGuide,
  ZeroneStatus,
} from "./types";

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

export function onSessionLost(fn: () => void): void {
  sessionLostHandler = fn;
}

export class ApiError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
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

async function request<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, {
    method: body !== undefined ? "POST" : "GET",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data: { error?: string; message?: string } | null = null;
  try {
    data = (await res.json()) as { error?: string; message?: string };
  } catch {
    /* non-JSON response */
  }

  if (res.status === 401) {
    setToken(null);
    sessionLostHandler?.();
    throw new ApiError(data?.message ?? "The vault is locked.", data?.error);
  }
  if (!res.ok) {
    throw new ApiError(
      data?.message ?? data?.error ?? `Request failed (${res.status})`,
      data?.error,
    );
  }
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

  accounts: () => request<{ accounts: Account[] }>("/api/accounts"),
  createAccount: (body: CreateAccountInput) =>
    request<{ account: Account }>("/api/accounts", body),
  archiveAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/archive`, {}),
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

  payments: () => request<{ payments: PaymentListItem[] }>("/api/payments"),
  walletIntentAudit: (intentId: string) =>
    request<WalletIntentAudit>(
      `/api/wallet/v2/intents/${encodeURIComponent(intentId)}`,
    ),
  reconcileBasePayment: (intentId: string) =>
    request<PaymentReconcileResult | PaymentTruth>(
      `/api/wallet/v2/intents/${encodeURIComponent(intentId)}/reconcile`,
      {},
    ),

  // zerone front — public, read-only (works with or without a vault session).
  zeroneGuide: () => request<ZeroneGuide>("/api/zerone/guide"),
  zeroneStatus: () => request<ZeroneStatus>("/api/zerone/status"),
};
