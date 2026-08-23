import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  appendVary,
  compressPublicResponses,
  publicDeliveryHeaders,
} from "./http-delivery.ts";

function fixtureApp() {
  const app = new Hono();
  app.use("*", publicDeliveryHeaders);
  app.use("*", compressPublicResponses());
  app.get("/large", (c) => {
    c.header("Content-Type", "application/vnd.cashloom.fixture.v1+json");
    c.header("ETag", 'W/"semantic-fixture"');
    c.header("Vary", "Accept");
    return c.body(JSON.stringify({ schema: "fixture/1", payload: "x".repeat(8_000) }));
  });
  app.get("/small", (c) => c.json({ schema: "fixture/1" }));
  return app;
}

describe("public HTTP delivery", () => {
  it("appends Vary fields case-insensitively without duplicates", () => {
    expect(appendVary("Accept, ACCEPT-ENCODING", "Accept-Encoding"))
      .toBe("Accept, ACCEPT-ENCODING");
    expect(appendVary(null, "Accept-Encoding")).toBe("Accept-Encoding");
  });

  it("gzip-compresses vendor +json while preserving the weak semantic ETag", async () => {
    const response = await fixtureApp().request("/large", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("etag")).toBe('W/"semantic-fixture"');
    expect(response.headers.get("vary")?.split(/,\s*/)).toEqual([
      "Accept",
      "Accept-Encoding",
    ]);
    expect(response.headers.get("timing-allow-origin")).toBe("*");

    const decoded = await new Response(
      response.body!.pipeThrough(new DecompressionStream("gzip")),
    ).json() as { schema: string; payload: string };
    expect(decoded.schema).toBe("fixture/1");
    expect(decoded.payload).toHaveLength(8_000);
  });

  it("keeps the compression variance receipt on identity responses", async () => {
    const response = await fixtureApp().request("/small", {
      headers: { "Accept-Encoding": "identity" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.json()).toEqual({ schema: "fixture/1" });
  });
});
