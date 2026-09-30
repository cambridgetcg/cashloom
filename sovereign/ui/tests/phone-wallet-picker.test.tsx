import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api, setToken, type WalletConnectSetup } from "../src/api";
import { PhoneWalletPicker, PhoneWalletPickerView, phoneCanUseAddress, phoneSetupReady, type PhoneWalletPickerState } from "../src/views/PhoneWalletPicker";
import { WatchWallet } from "../src/views/WatchWallet";

const address = `0x${"a".repeat(40)}`;
const secondAddress = `0x${"b".repeat(40)}`;
const project = "c".repeat(32);
const setup: WalletConnectSetup = { state: "ready", project_id: project };
const expiry = "2099-01-01T12:00:00.000Z";
const idle: PhoneWalletPickerState = { status: "idle", uri: null, expires_at: null, accounts: [], error: null };
const ready: PhoneWalletPickerState = { ...idle, status: "ready", expires_at: expiry, accounts: [address, secondAddress] };
const pairingSecret = `wc:${"d".repeat(64)}@2?relay-protocol=irn&symKey=${"e".repeat(64)}&expiryTimestamp=4070952000`;

function renderPicker(state: PhoneWalletPickerState = idle, config: WalletConnectSetup | null = setup, selectedAddress: string | null = null, busy = false, disabled = false) {
  return renderToStaticMarkup(<PhoneWalletPickerView setup={config} setupError={null} state={state} selectedAddress={selectedAddress} busy={busy} disabled={disabled} notice={null}
    onStart={() => undefined} onSelect={() => undefined} onConfirm={() => undefined} onCopy={() => undefined} onRetrySetup={() => undefined} onClose={() => undefined} />);
}

describe("phone pairing disclosure and explicit activation", () => {
  test("watch form keeps manual and browser paths and opens no picker by default", () => {
    const html = renderToStaticMarkup(<WatchWallet canManage onSaved={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain("Choose from a wallet"); expect(html).toContain("Connect a phone wallet");
    expect(html).toContain("Public wallet address"); expect(html).toContain("Add watched wallet");
    expect(html).not.toContain('aria-label="Phone wallet pairing"'); expect(html).not.toContain("<canvas");
  });
  test("opening starts with local setup loading, while only configured disclosure offers Start pairing", () => {
    const html = renderToStaticMarkup(<PhoneWalletPicker onBusyChange={() => undefined} onAddress={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Checking local pairing setup"); expect(html).not.toContain("Start pairing");
    const configured = renderPicker();
    expect(configured).toContain("external Reown relay"); expect(configured).toContain("IP address and protocol metadata");
    expect(configured).toContain("requests no signature or payment"); expect(configured).toContain("does not switch networks");
    expect(configured).toContain("Start pairing"); expect(configured).not.toContain(project);
    expect(configured).not.toContain("<canvas"); expect(configured).not.toContain('type="submit"');
  });
  test("missing and malformed setup exposes only operator instructions and fallback", () => {
    for (const config of [{ state: "not_configured", project_id: null }, { state: "invalid_configuration", project_id: null }] as const) {
      const html = renderPicker(idle, config);
      expect(html).toContain("CASHLOOM_WALLETCONNECT_PROJECT_ID"); expect(html).toContain("scoped environment");
      expect(html).toContain("paste a public address"); expect(html).toContain("Retry setup check");
      expect(html).not.toContain("Start pairing"); expect(html).not.toContain("<canvas");
    }
    expect(phoneSetupReady(setup)).toBe(true);
    expect(phoneSetupReady(null)).toBe(false);
    expect(phoneSetupReady({ state: "ready", project_id: "not-a-project" })).toBe(false);
    expect(phoneSetupReady({ state: "ready", project_id: "c".repeat(33) })).toBe(false);
  });
});

describe("pairing secret and pending-state presentation", () => {
  test("the secret has no rendered text, href, image URL, input or attribute", () => {
    const html = renderPicker({ ...idle, status: "pairing", uri: pairingSecret, expires_at: expiry });
    expect(html).toContain('<canvas role="img" aria-label="Wallet pairing QR code"');
    expect(html).toContain("Copy pairing link"); expect(html).toContain("clipboard may retain");
    expect(html).toContain("Scan this code in your phone wallet"); expect(html).toContain("Pairing expires");
    expect(html).not.toContain(pairingSecret); expect(html).not.toContain("symKey");
    expect(html).not.toContain("href="); expect(html).not.toContain("src="); expect(html).not.toContain("<input");
  });
  test("cancel remains available during startup and confirmation without offering another start", () => {
    for (const status of ["starting", "confirming"] as const) {
      const html = renderPicker({ ...idle, status }, setup, null, true, true);
      expect(html).toContain("Cancel pairing"); expect(html).not.toContain('disabled="">Cancel pairing');
      expect(html).not.toContain(">Start pairing<"); expect(html).not.toContain("Use this address");
      expect(html).toContain("try to notify your wallet"); expect(html).toContain("remaining connection");
    }
  });
  test("expiry errors offer a fresh explicit pairing and retain no QR or candidate", () => {
    const html = renderPicker({ ...idle, status: "error", error: { code: "phone_expired", message: "This pairing expired. Start a new pairing." } });
    expect(html).toContain("Start new pairing"); expect(html).toContain('role="alert"');
    expect(html).not.toContain("<canvas"); expect(html).not.toContain("Copy pairing link");
    expect(html).not.toContain("Use this address"); expect(html).not.toContain(address);
  });
});

describe("approved address selection", () => {
  test("full Base addresses require an explicit choice and are never form-submit controls", () => {
    const html = renderPicker(ready);
    expect(html).toContain("Choose one public address on Base");
    expect(html).toContain(address); expect(html).toContain(secondAddress);
    expect(html.match(/type="radio"/g)).toHaveLength(2); expect(html).not.toContain('checked=""');
    expect(html).toContain('disabled="">Use this address'); expect(html).not.toContain('type="submit"');
    const chosen = renderPicker(ready, setup, secondAddress);
    expect(chosen.match(/checked=""/g)).toHaveLength(1);
    expect(chosen).not.toContain('disabled="">Use this address');
    expect(renderPicker(ready, setup, secondAddress, true)).toContain('disabled="">Use this address');
  });
  test("stale, unapproved, wrong-state and expired choices cannot be used", () => {
    const now = Date.parse("2098-01-01T00:00:00.000Z");
    expect(phoneCanUseAddress(ready, address, now)).toBe(true);
    expect(phoneCanUseAddress(ready, null, now)).toBe(false);
    expect(phoneCanUseAddress(ready, `0x${"f".repeat(40)}`, now)).toBe(false);
    expect(phoneCanUseAddress({ ...ready, status: "confirming" }, address, now)).toBe(false);
    expect(phoneCanUseAddress({ ...ready, accounts: [] }, address, now)).toBe(false);
    expect(phoneCanUseAddress({ ...ready, expires_at: null }, address, now)).toBe(false);
    expect(phoneCanUseAddress({ ...ready, expires_at: "invalid" }, address, now)).toBe(false);
    expect(phoneCanUseAddress(ready, address, Date.parse(expiry))).toBe(false);
  });
});

test("setup reads only the fixed local endpoint and a late result cannot cross a replaced session", async () => {
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = ((path, init) => {
    calls.push({ path: String(path), method: init?.method ?? "GET" });
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch;
  try {
    setToken("synthetic-before-lock");
    const pending = api.walletConnectSetup();
    setToken(null); setToken("synthetic-after-lock");
    finish(Response.json(setup));
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
    expect(calls).toEqual([{ path: "/api/connections/crypto/walletconnect", method: "GET" }]);
  } finally { setToken(null); globalThis.fetch = original; }
});
