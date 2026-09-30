/** Address sharing only; deliberately unrelated to WalletConnect signing evidence. */
export const PHONE_PAIRING_MS = 5 * 60_000;
export const PHONE_RELAY = "wss://relay.walletconnect.org";
const messages = {
  phone_invalid_configuration: "Phone pairing is not configured for this workspace.",
  phone_unavailable: "Phone pairing could not connect. Try again or paste a public address.",
  phone_declined: "The wallet declined this connection. You can try again or paste an address.",
  phone_scope_refused: "This wallet did not approve the address-only Base connection. No address was selected. Use another wallet or paste an address.",
  phone_changed: "The wallet connection changed. Start a new pairing before selecting an address.",
  phone_expired: "This pairing has expired. Start a new pairing to continue.",
  phone_timeout: "Phone pairing did not respond in time. Start a new pairing or paste an address.",
  phone_session_ended: "This selection has ended. Open phone pairing again in your unlocked workspace.",
} as const;
export type PhoneWalletErrorCode = keyof typeof messages;
export class PhoneWalletError extends Error {
  constructor(readonly code: PhoneWalletErrorCode) { super(messages[code]); this.name = "PhoneWalletError"; }
}
export function isPhoneErrorCode(value: unknown): value is PhoneWalletErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
export const publicAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
export function validOrigin(value: unknown): value is string {
  try {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
export const validProjectId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
export function validPairingUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || !/^wc:[0-9a-f]{64}@2\?/i.test(value)) return false;
  try {
    const url = new URL(value), keys = [...url.searchParams.keys()];
    return !url.hash && new Set(keys).size === keys.length && keys.every(key => ["relay-protocol", "symKey", "expiryTimestamp"].includes(key)) &&
      url.searchParams.get("relay-protocol") === "irn" && /^[0-9a-f]{64}$/i.test(url.searchParams.get("symKey") ?? "") &&
      (!url.searchParams.has("expiryTimestamp") || /^[0-9]{1,12}$/.test(url.searchParams.get("expiryTimestamp")!));
  } catch { return false; }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** SDK approval can contain more permissions than requested. Refuse them,
 * including extra chains, methods and events; never silently broaden access. */
export function phoneSessionAddresses(input: unknown, now = Date.now()): { accounts: readonly string[]; expiry: number } {
  const fail = (): never => { throw new PhoneWalletError("phone_scope_refused"); };
  try {
    if (!object(input) || !Number.isSafeInteger(input.expiry) || typeof input.expiry !== "number") return fail();
    const expiry = input.expiry * 1000;
    if (!Number.isSafeInteger(expiry) || expiry <= now) throw new PhoneWalletError("phone_expired");
    if (!object(input.namespaces)) return fail();
    const keys = Object.keys(input.namespaces);
    if (keys.length !== 1 || !["eip155", "eip155:8453"].includes(keys[0]!)) return fail();
    const namespace = input.namespaces[keys[0]!];
    if (!object(namespace) || Object.keys(namespace).some(key => !["accounts", "chains", "methods", "events"].includes(key)) ||
      !Array.isArray(namespace.methods) || namespace.methods.length !== 0 || !Array.isArray(namespace.events) ||
      namespace.events.length !== 2 || new Set(namespace.events).size !== 2 ||
      !namespace.events.includes("accountsChanged") || !namespace.events.includes("chainChanged") ||
      (namespace.chains !== undefined && (!Array.isArray(namespace.chains) || namespace.chains.length !== 1 || namespace.chains[0] !== "eip155:8453")) ||
      !Array.isArray(namespace.accounts) || namespace.accounts.length < 1 || namespace.accounts.length > 20) return fail();
    const addresses: string[] = [], seen = new Set<string>();
    for (const account of namespace.accounts) {
      if (typeof account !== "string" || !account.startsWith("eip155:8453:")) return fail();
      const address = account.slice("eip155:8453:".length);
      if (!publicAddress(address)) return fail();
      if (!seen.has(address.toLowerCase())) { seen.add(address.toLowerCase()); addresses.push(address); }
    }
    return { accounts: Object.freeze(addresses), expiry };
  } catch (error) { if (error instanceof PhoneWalletError) throw error; return fail(); }
}

/** Fresh per worker. Never delegates to IndexedDB, localStorage or SDK defaults. */
export class PhoneMemoryStorage {
  private values = new Map<string, unknown>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  async getKeys(): Promise<string[]> { return [...this.values.keys()]; }
  async getEntries<T = unknown>(): Promise<[string, T][]> { return structuredClone([...this.values.entries()]) as [string, T][]; }
  async getItem<T = unknown>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const size = key.length + (JSON.stringify(value)?.length ?? 0);
    const total = this.bytes - (this.sizes.get(key) ?? 0) + size;
    if (key.length > 1024 || (!this.values.has(key) && this.values.size >= 512) || size > 2_000_000 || total > 4_000_000) throw new PhoneWalletError("phone_unavailable");
    this.values.set(key, structuredClone(value));
    this.sizes.set(key, size); this.bytes = total;
  }
  async removeItem(key: string): Promise<void> { this.bytes -= this.sizes.get(key) ?? 0; this.sizes.delete(key); this.values.delete(key); }
  clear(): void { this.values.clear(); this.sizes.clear(); this.bytes = 0; }
}
export type PhoneWorkerCommand =
  | { type: "start"; project_id: string; origin: string }
  | { type: "confirm"; request_id: number; address: string }
  | { type: "close" };
export type PhoneWorkerEvent =
  | { type: "pairing"; uri: string; expires_at: string }
  | { type: "ready"; accounts: readonly string[]; expires_at: string }
  | { type: "confirmed"; request_id: number; address: string }
  | { type: "error"; code: PhoneWalletErrorCode }
  | { type: "closed" };
