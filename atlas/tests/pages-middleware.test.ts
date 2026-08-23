import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/_middleware.ts";

function context(request: Request, next?: () => Promise<Response>) {
  return {
    request,
    next: next ?? vi.fn(async () => new Response("spa", {
      headers: { "Content-Type": "text/html" },
    })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("CashLoom Pages public threshold", () => {
  it("proxies an apex read with only safe headers and the allowlisted public origin", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://cashloom-api.fly.dev/v1/onchain?scope=latest");
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(headers.get("X-CashLoom-Public-Origin")).toBe("https://cashloom.io");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      expect(headers.get("If-None-Match")).toBe('W/"snapshot"');
      return new Response('{"schema":"cashloom.onchain/1"}', {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.cashloom.onchain.v1+json",
          "Set-Cookie": "must-not-cross=1",
        },
      });
    });

    const response = await onRequest(context(new Request(
      "https://cashloom.io/v1/onchain?scope=latest",
      {
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=secret",
          "If-None-Match": 'W/"snapshot"',
        },
      },
    )));

    expect(upstream).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-CashLoom-Edge")).toBe("cashloom.io-read-proxy");
  });

  it("redirects www to the canonical apex without proxying", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const response = await onRequest(context(new Request(
      "https://www.cashloom.io/onchain/?base=EUR",
    )));

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://cashloom.io/onchain/?base=EUR");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.cashloom.io//evil.example/phish?x=1",
    "https://www.cashloom.io/%2F%2Fevil.example/phish?x=1",
    "https://www.cashloom.io/%5C%5Cevil.example/phish?x=1",
  ])("keeps hostile-looking redirect paths on the CashLoom apex: %s", async (input) => {
    const response = await onRequest(context(new Request(input)));
    const location = new URL(response.headers.get("Location")!);

    expect(response.status).toBe(308);
    expect(location.origin).toBe("https://cashloom.io");
    expect(location.search).toBe("?x=1");
  });

  it("returns the typed XENIA discovery problem instead of the SPA to agents", async () => {
    const next = vi.fn(async () => new Response("spa"));
    const response = await onRequest(context(new Request(
      "https://cashloom.io/not-a-route",
      { headers: { Accept: "application/problem+json" } },
    ), next));

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/problem\+json/);
    expect(await response.json()).toMatchObject({
      schema_version: "xenia.surface.problem/0.1",
      code: "route_not_found",
      next_actions: [{
        rel: "discover",
        href: "https://cashloom.io/.well-known/agent.json",
      }],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses write methods with an explicit Allow header", async () => {
    const response = await onRequest(context(new Request(
      "https://cashloom.io/v1/onchain",
      { method: "POST", body: "{}" },
    )));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(await response.json()).toMatchObject({
      code: "method_not_allowed",
      retryable: false,
    });
  });

  it("leaves ordinary human routes to Pages", async () => {
    const next = vi.fn(async () => new Response("spa", { status: 200 }));
    const response = await onRequest(context(
      new Request("https://cashloom.io/world/"),
      next,
    ));

    expect(await response.text()).toBe("spa");
    expect(next).toHaveBeenCalledOnce();
  });

  it("turns an upstream network failure into a typed, retryable 502", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const response = await onRequest(context(new Request(
      "https://cashloom.io/v1/world?base=USD",
    )));

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      schema_version: "xenia.surface.problem/0.1",
      code: "upstream_unavailable",
      retryable: true,
    });
  });
});
