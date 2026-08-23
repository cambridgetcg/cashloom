/**
 * CashLoom's canonical public threshold.
 *
 * Cloudflare Pages serves the human routes and hashed assets. This small
 * middleware forwards only the public, read-only information surface to the
 * separately built Fly info process. No credential, cookie, request body, or
 * write method crosses this boundary.
 */

interface PagesContext {
  request: Request;
  next(): Promise<Response>;
}

const INFO_ORIGIN = "https://cashloom-api.fly.dev";
const CANONICAL_WEB_ORIGIN = "https://cashloom.io";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "origin",
  "prefer",
] as const;

function isInfoPath(pathname: string): boolean {
  return pathname === "/RIGHTS.md"
    || pathname === "/agent.txt"
    || pathname.startsWith("/v1/")
    || pathname === "/v1"
    || pathname.startsWith("/api/")
    || pathname === "/api"
    || pathname.startsWith("/.well-known/");
}

function xeniaProblem(origin: string, status: 404 | 405 | 502, detail: string): Response {
  const routeMissing = status === 404;
  const body = {
    schema_version: "xenia.surface.problem/0.1",
    type: `${origin}/problems/${routeMissing ? "route-not-found" : status === 405 ? "method-not-allowed" : "upstream-unavailable"}`,
    title: routeMissing
      ? "No resource exists at this path"
      : status === 405
        ? "This public threshold is read-only"
        : "The public information origin did not answer",
    status,
    code: routeMissing ? "route_not_found" : status === 405 ? "method_not_allowed" : "upstream_unavailable",
    detail,
    retryable: status === 502,
    terminal: false,
    next_actions: [
      {
        rel: "discover",
        href: `${origin}/.well-known/agent.json`,
        method: "GET",
        accept: "application/json",
      },
    ],
    docs: [`${origin}/v1/orientation`],
  };
  const headers = new Headers({
    "Cache-Control": status === 404 ? "public, max-age=60" : "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    "Vary": "Accept",
    "X-Content-Type-Options": "nosniff",
  });
  if (status === 405) headers.set("Allow", "GET, HEAD, OPTIONS");
  return new Response(JSON.stringify(body), { status, headers });
}

async function proxyRead(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, INFO_ORIGIN);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The API accepts this capability only for the one allowlisted public host.
  // It never trusts Host/X-Forwarded-Host supplied by an arbitrary caller.
  if (incoming.origin === CANONICAL_WEB_ORIGIN) {
    headers.set("X-CashLoom-Public-Origin", CANONICAL_WEB_ORIGIN);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: "manual",
    });
  } catch {
    return xeniaProblem(
      incoming.origin,
      502,
      "The read-only information process could not be reached. A saved snapshot may still be available in the interface.",
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("set-cookie");
  responseHeaders.set("X-CashLoom-Edge", "cashloom.io-read-proxy");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request } = context;
  const url = new URL(request.url);

  if (url.hostname === "www.cashloom.io") {
    // Assign path/query after constructing the trusted origin. Resolving a
    // pathname such as `//attacker.example/` as a relative URL would turn this
    // canonicalization into an open redirect.
    const canonical = new URL(CANONICAL_WEB_ORIGIN);
    canonical.pathname = url.pathname;
    canonical.search = url.search;
    return new Response(null, {
      status: 308,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Location": canonical.href,
      },
    });
  }

  if (isInfoPath(url.pathname)) {
    if (!READ_METHODS.has(request.method)) {
      return xeniaProblem(
        url.origin,
        405,
        "CashLoom's hosted information surface accepts GET, HEAD, and OPTIONS only; it cannot sign or broadcast a transaction.",
      );
    }
    return proxyRead(request);
  }

  // Pages' human-route fallback is intentional for browsers. An agent asking
  // for the Surface problem representation must never receive the SPA shell.
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  if (accept.includes("application/problem+json")) {
    return xeniaProblem(
      url.origin,
      404,
      "Use the discovery manifest to find CashLoom's public read resources.",
    );
  }

  return context.next();
}
