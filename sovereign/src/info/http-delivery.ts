import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";

export function appendVary(value: string | null | undefined, token: string): string {
  const fields = (value ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (!fields.some((field) => field.toLowerCase() === token.toLowerCase())) {
    fields.push(token);
  }
  return fields.join(", ");
}

/**
 * Response delivery varies by compression even when a particular body is too
 * small to transform. The timing allowance lets direct cross-origin clients
 * inspect the deliberately published Server-Timing receipt.
 */
export const publicDeliveryHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Vary", appendVary(c.res.headers.get("Vary"), "Accept-Encoding"));
  c.res.headers.set("Timing-Allow-Origin", "*");
};

/** Vendor `+json` observations are compressible under Hono's default filter. */
export function compressPublicResponses(): MiddlewareHandler {
  return compress({ threshold: 1_024 });
}
