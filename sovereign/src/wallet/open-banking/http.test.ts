import { describe, expect, test } from "bun:test";
import { OpenBankingAdapterError } from "./errors.ts";
import { createFixedJsonHttp } from "./http.ts";

const json = (value: unknown, init: ResponseInit = {}): Response => new Response(
  JSON.stringify(value),
  {
    ...init,
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  },
);

describe("fixed open-banking HTTP", () => {
  test("uses only the fixed HTTPS origin and refuses redirect-shaped paths", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = createFixedJsonHttp({
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init });
        return json({ ok: true });
      }) as typeof fetch,
    });
    await expect(http.request({
      origin: "https://api.example.test",
      path: "/v1/resource?id=one",
      method: "GET",
    })).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.example.test/v1/resource?id=one");
    expect(calls[0]?.init?.redirect).toBe("error");
    await expect(http.request({
      origin: "https://api.example.test",
      path: "//evil.invalid/steal",
      method: "GET",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_INVALID_REQUEST" });
  });

  test("bounds declared and streamed bodies before parsing", async () => {
    const declared = createFixedJsonHttp({
      max_response_bytes: 256,
      fetch: (async () => json({ ok: true }, { headers: { "content-length": "999" } })) as unknown as typeof fetch,
    });
    await expect(declared.request({
      origin: "https://api.example.test",
      path: "/large",
      method: "GET",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_RESPONSE_TOO_LARGE" });

    const streamed = createFixedJsonHttp({
      max_response_bytes: 256,
      fetch: (async () => json({ payload: "x".repeat(300) })) as unknown as typeof fetch,
    });
    await expect(streamed.request({
      origin: "https://api.example.test",
      path: "/large",
      method: "GET",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_RESPONSE_TOO_LARGE" });
  });

  test("enforces its deadline even when fetch ignores abort and returns only a fixed code", async () => {
    const canary = "SECRET_CANARY_https://credential.invalid";
    const http = createFixedJsonHttp({
      deadline_ms: 100,
      fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    });
    try {
      await http.request({
        origin: "https://api.example.test",
        path: "/slow",
        method: "GET",
      });
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenBankingAdapterError);
      expect(error).toMatchObject({ code: "OPEN_BANKING_TIMEOUT" });
      expect(String(error)).not.toContain(canary);
    }
  });
});
