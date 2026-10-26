import { readFileSync } from "node:fs";
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

  it.each(["GET", "HEAD"])("preserves capital-flow conditional %s responses without forwarding credentials", async (method) => {
    const etag = 'W/"capital-flows-fixture"';
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://cashloom-api.fly.dev/v1/capital-flows");
      expect(init?.method).toBe(method);
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toBe("application/vnd.cashloom.capital-flows.v1+json");
      expect(headers.get("If-None-Match")).toBe(etag);
      expect(headers.get("If-Modified-Since")).toBe("Tue, 08 Sep 2026 12:00:00 GMT");
      expect(headers.get("X-CashLoom-Public-Origin")).toBe("https://cashloom.io");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      return new Response(null, { status: 304, headers: {
        ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate",
        Vary: "Accept", "X-CashLoom-Cache": "current", "Set-Cookie": "not-for-client=1",
      } });
    });
    const next = vi.fn(async () => new Response("unexpected spa"));
    const response = await onRequest(context(new Request("https://cashloom.io/v1/capital-flows", {
      method, headers: {
        Accept: "application/vnd.cashloom.capital-flows.v1+json", "If-None-Match": etag,
        "If-Modified-Since": "Tue, 08 Sep 2026 12:00:00 GMT",
        Authorization: "Bearer test-only", Cookie: "test-only=1", "X-CashLoom-Public-Origin": "https://untrusted.example",
      },
    }), next));
    expect(upstream).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("X-CashLoom-Cache")).toBe("current");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("returns a bodyless capital-flow HEAD while retaining delivery headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream body must not reach a HEAD caller", {
      status: 200, headers: {
        "Content-Type": "application/vnd.cashloom.capital-flows.v1+json", ETag: 'W/"capital-head"',
        "Cache-Control": "public, max-age=0, must-revalidate", Age: "4", "X-CashLoom-Cache": "fallback",
        "Content-Length": "999", "Set-Cookie": "not-for-client=1",
      },
    }));
    const response = await onRequest(context(new Request("https://cashloom.io/v1/capital-flows", { method: "HEAD" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.cashloom.capital-flows.v1+json");
    expect(response.headers.get("ETag")).toBe('W/"capital-head"');
    expect(response.headers.get("Age")).toBe("4");
    expect(response.headers.get("X-CashLoom-Cache")).toBe("fallback");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("forwards capital-flow OPTIONS preflight without a body or credentials", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://cashloom-api.fly.dev/v1/capital-flows");
      expect(init?.method).toBe("OPTIONS");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("Origin")).toBe("https://cashloom.io");
      expect(headers.get("Access-Control-Request-Method")).toBe("HEAD");
      expect(headers.get("Access-Control-Request-Headers")).toBe("if-none-match");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
    });
    const response = await onRequest(context(new Request("https://cashloom.io/v1/capital-flows", {
      method: "OPTIONS", headers: {
        Origin: "https://cashloom.io", "Access-Control-Request-Method": "HEAD",
        "Access-Control-Request-Headers": "if-none-match", Authorization: "Bearer test-only", Cookie: "test-only=1",
      },
    })));
    expect(upstream).toHaveBeenCalledOnce();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses capital-flow %s before proxy or human fallback", async (method) => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const next = vi.fn(async () => new Response("unexpected spa"));
    const response = await onRequest(context(new Request("https://cashloom.io/v1/capital-flows", {
      method, body: "{}",
    }), next));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(await response.json()).toMatchObject({ code: "method_not_allowed", retryable: false });
    expect(upstream).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["/capital-flows", "/capital-flows/"])("leaves human capital route %s to Pages without starting an API read", async (path) => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const next = vi.fn(async () => new Response("capital route spa", { headers: { "Content-Type": "text/html" } }));
    const response = await onRequest(context(new Request(`https://cashloom.io${path}`, {
      headers: { Accept: "text/html" },
    }), next));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("capital route spa");
    expect(next).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();
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

  it("serves a plain allow-all robots.txt with no new limit or training signal", () => {
    const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
    expect(robots).toBe("User-agent: *\nAllow: /\n");
  });

  it.each(["/robots.txt", "/llms.txt", "/llms-full.txt", "/humans.txt", "/sitemap.xml", "/ai.txt", "/zz-quiet-doors-probe.json"])(
    "answers 404 instead of the human-route shell at %s when no file is published",
    async (path) => {
      const response = await onRequest(context(new Request(`https://cashloom.io${path}`)));

      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toMatch(/^application\/problem\+json/);
      expect(await response.json()).toMatchObject({
        code: "route_not_found",
        next_actions: [{ rel: "discover", href: "https://cashloom.io/.well-known/agent.json" }],
      });
    },
  );

  it("answers HEAD for a missing discovery file with a bodyless 404", async () => {
    const response = await onRequest(context(new Request("https://cashloom.io/sitemap.xml", { method: "HEAD" })));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("passes a published text file through untouched", async () => {
    const file = new Response("User-agent: *\nAllow: /\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const response = await onRequest(context(new Request("https://cashloom.io/robots.txt"), async () => file));

    expect(response).toBe(file);
  });
});
