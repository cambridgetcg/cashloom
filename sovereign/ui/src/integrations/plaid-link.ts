export const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export interface PlaidLinkHandler {
  open(): void;
  destroy(): void;
}

export interface PlaidLinkSdk {
  create(options: {
    token: string;
    onSuccess(publicToken: string | null): void;
    onExit(error: unknown): void;
  }): PlaidLinkHandler;
}

declare global {
  interface Window { Plaid?: PlaidLinkSdk }
}

let loading: Promise<PlaidLinkSdk> | null = null;

/** Called only by the owner's explicit Connect button, never while rendering. */
export function loadPlaidLink(): Promise<PlaidLinkSdk> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (loading) return loading;
  loading = new Promise<PlaidLinkSdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    const timeout = window.setTimeout(() => fail(), 20_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
    };
    const fail = () => {
      cleanup();
      script.remove();
      loading = null;
      reject(new Error("The bank connection window could not load. Try again."));
    };
    script.onload = () => {
      if (!window.Plaid) return fail();
      cleanup();
      resolve(window.Plaid);
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}
