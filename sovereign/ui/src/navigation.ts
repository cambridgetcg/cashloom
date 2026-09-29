/** URLs name a view only. Account/key context stays in memory and clears on lock. */
export const WALLET_VIEWS = [
  { id: "dashboard", label: "Overview", path: "overview", group: "Your money" },
  { id: "accounts", label: "Accounts", path: "accounts", group: "Your money" },
  { id: "ledger", label: "Activity", path: "ledger", group: "Your money" },
  { id: "pay", label: "Send money", path: "pay", group: "Your money" },
  { id: "receive", label: "Receive money", path: "receive", group: "Your money" },
  { id: "trades", label: "Agreements", path: "trades", group: "Your money" },
  { id: "connections", label: "Connections", path: "connections", group: "Setup" },
  { id: "assist", label: "Agent access", path: "assist", group: "Setup" },
  { id: "keys", label: "Signing keys", path: "keys", group: "Setup" },
  { id: "zerone", label: "Zerone network", path: "zerone", group: "Advanced" },
] as const;

export const WALLET_NAV_GROUPS = ["Your money", "Setup", "Advanced"] as const;

export type WalletView = (typeof WALLET_VIEWS)[number]["id"];
export interface WalletContext { accountId?: string; keyId?: string }
export type WalletNavigate = (view: WalletView, context?: WalletContext) => void;
export interface WalletRoute { view: WalletView; context?: WalletContext }

export function walletViewFromHash(hash: string): WalletView {
  return WALLET_VIEWS.find((view) => `#/${view.path}` === hash)?.id ?? "dashboard";
}

export function walletViewHash(view: WalletView): string {
  return `#/${WALLET_VIEWS.find((item) => item.id === view)?.path ?? "overview"}`;
}

export function readWalletRoute(): WalletRoute {
  return { view: walletViewFromHash(typeof window === "undefined" ? "" : window.location.hash) };
}

export const PUBLIC_WORLD_URL = "https://cashloom.io/world";

/** A build-time destination only; never probe a service or attach private context. */
export function publicPlanUrlForOrigin(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\/[^/?#@\\\s]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return `${url.origin}/plan`;
  } catch {
    return null;
  }
}

export const PUBLIC_PLAN_URL = publicPlanUrlForOrigin(import.meta.env?.VITE_CASHLOOM_SERVICE_ORIGIN);
