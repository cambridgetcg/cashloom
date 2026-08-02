import { afterEach, describe, expect, it } from "bun:test";
import { api, hasToken, setToken } from "../src/api";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;

function installInsecureLanOrigin(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        hostname: "192.168.1.40",
        origin: "http://192.168.1.40:4747",
        protocol: "http:",
      },
    },
  });
}

afterEach(() => {
  setToken(null);
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("API transport guard", () => {
  it("sends no passphrase request over non-loopback plain HTTP", async () => {
    installInsecureLanOrigin();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;

    await expect(api.vaultUnlock("never-send-me")).rejects.toMatchObject({
      code: "insecure_transport",
    });
    expect(fetchCalls).toBe(0);
  });

  it("clears a stale token before an authenticated request can leave", async () => {
    installInsecureLanOrigin();
    setToken("stale-session-token");
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;

    await expect(api.keys()).rejects.toMatchObject({
      code: "insecure_transport",
    });
    expect(fetchCalls).toBe(0);
    expect(hasToken()).toBe(false);
  });
});
