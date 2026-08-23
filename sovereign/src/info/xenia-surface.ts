/**
 * CashLoom's bounded XENIA Surface 0.1 door.
 *
 * Surface conformance applies only to the three deterministic resources named
 * in the manifest and to the router fall-through problem. The market-data
 * doors remain discoverable from orientation, but are deliberately not
 * declared as Surface resources: their upstream fan-out and older error
 * shapes are outside this small, externally testable profile.
 */

import type { Hono } from "hono";
import {
  createSurfaceManifestResponse,
  createSurfaceNotAcceptableProblem,
  createSurfaceProblem,
  createSurfaceProblemResponse,
  createSurfaceResourceResponse,
  createSurfaceRouteNotFoundProblem,
  defineSurfaceManifest,
  negotiateSurfaceResource,
  SURFACE_MANIFEST_PATH,
  SURFACE_MANIFEST_SCHEMA_URL,
  SURFACE_PROBLEM_SCHEMA_URL,
  SURFACE_PROFILE,
  SURFACE_PROFILE_DOCUMENTATION_URL,
  type SurfaceManifest,
  type SurfaceResource,
} from "@agenttool/xenia/surface-0.1";
import { MONEYFACT_MEDIA_TYPE } from "./money-fact.ts";
import { WORLD_MEDIA_TYPE } from "./world-door.ts";
import { ONCHAIN_MEDIA_TYPE, ONCHAIN_SECTION_MEDIA_TYPE } from "./blockchain/model.ts";

export const CASHLOOM_API_ORIGIN = "https://cashloom-api.fly.dev";
export const CASHLOOM_WEBSITE_ORIGIN = "https://cashloom.io";
export const CASHLOOM_PUBLIC_ORIGIN_HEADER = "X-CashLoom-Public-Origin";

export type CashLoomSurfaceRuntime = "hosted_info" | "local_sovereign";

export interface CashLoomSurfaceOptions {
  runtime?: CashLoomSurfaceRuntime;
}

const DEFAULT_SURFACE_RUNTIME: CashLoomSurfaceRuntime = "hosted_info";

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
}

function parseConfiguredOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const loopback = isLoopbackHostname(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve absolute URLs without trusting an arbitrary Host header. Loopback is
 * honored for local checks. The website proxy may request its one pre-approved
 * public alias; no caller-supplied origin other than that alias is accepted.
 */
export function resolveCashLoomPublicOrigin(
  request: Request,
  configuredOrigin: string | undefined = process.env.CASHLOOM_PUBLIC_ORIGIN,
): string {
  if (request.headers.get(CASHLOOM_PUBLIC_ORIGIN_HEADER) === CASHLOOM_WEBSITE_ORIGIN) {
    return CASHLOOM_WEBSITE_ORIGIN;
  }

  const configured = parseConfiguredOrigin(configuredOrigin);
  if (configured) return configured;

  try {
    const requestUrl = new URL(request.url);
    if (
      isLoopbackHostname(requestUrl.hostname)
      && (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
    ) return requestUrl.origin;
  } catch {
    // The production origin below is the closed, deterministic fallback.
  }
  return CASHLOOM_API_ORIGIN;
}

const absolute = (origin: string, path: string): string => new URL(path, `${origin}/`).href;

export function defineCashLoomSurfaceManifest(
  request: Request,
  runtime: CashLoomSurfaceRuntime = DEFAULT_SURFACE_RUNTIME,
): SurfaceManifest {
  const origin = resolveCashLoomPublicOrigin(request);
  return defineSurfaceManifest({
    service: {
      name: "CashLoom Moneyworld",
      canonicalUrl: `${origin}/`,
      description:
        "A public, read-only, cited view of monetary policy, rates, sovereign yields, FX, crypto, fees, and selected onchain state.",
    },
    resources: [
      {
        id: "orientation",
        href: absolute(origin, "/v1/orientation"),
        representations: ["application/json"],
        defaultMediaType: "application/json",
        description: "Agent operating contract, public read actions, freshness rules, and limits.",
      },
      {
        id: "rights",
        href: absolute(origin, "/v1/rights"),
        representations: ["application/json"],
        defaultMediaType: "application/json",
        description: "Pinned Rights adoption and the distinct, unactivated Covenant draft status.",
      },
      {
        id: "data-practices",
        href: absolute(origin, "/v1/data-practices"),
        representations: ["application/json"],
        defaultMediaType: "application/json",
        description: "Layer-scoped request-data and retention disclosures without an anonymity claim.",
      },
    ],
    // An empty claim set is intentional. The official checker records its own
    // expiring observations; this host does not promote assertions to tests.
    claims: [],
    notCovered: [
      "Surface observations do not establish XENIA Covenant conformance or activate the hosted Covenant draft",
      "market-data routes outside the three declared resources, including their latency, availability, negotiation, and error shapes",
      "accuracy, completeness, licensing, or future availability of upstream market and chain sources",
      "privacy, logging, retention, or request handling by Fly.io, Cloudflare, network intermediaries, operators, or upstream sources",
      "caller identity, consent, authority, delegated authority, or legal capacity",
      "frontend behavior, browser storage, accessibility, or same-origin proxy behavior",
      runtime === "hosted_info"
        ? "custodial, trading, transaction-building, signing, broadcasting, or investment-advice capabilities"
        : "the local sovereign node's vault, payment, write, signing, and broadcasting routes, which are outside the declared Surface resources",
      "historical TVL, volume, bridge completion, protocol-wide safety scores, and causal geopolitical impact claims",
    ],
    documentation: absolute(origin, "/v1/orientation"),
  });
}

const zeroCost = Object.freeze({
  amount_minor: "0",
  asset: "fiat:iso4217/USD",
  condition: "No CashLoom application fee is charged for these public GET handlers.",
});

function custodyBoundary(runtime: CashLoomSurfaceRuntime) {
  if (runtime === "local_sovereign") {
    return {
      funds: "none_in_declared_public_read_handlers",
      signing_keys:
        "the local process may contain owner-controlled vault material, but declared public reads neither accept nor access it",
      transaction_construction: "none_in_declared_or_orientation_listed_get_actions",
      broadcast: "none_in_declared_or_orientation_listed_get_actions",
      boundary:
        "The local sovereign process also contains private vault and write routes outside this Surface. This is a route-scoped read contract, not a process-wide no-custody claim.",
    } as const;
  }
  return {
    funds: "none",
    signing_keys: "none",
    transaction_construction: "none",
    broadcast: "none",
    boundary:
      "The hosted info entrypoint does not import CashLoom vault, ledger database, payment, or sender modules; infrastructure and upstream services remain separate external layers.",
  } as const;
}

function commonAction(runtime: CashLoomSurfaceRuntime) {
  return {
    rel: "read",
    method: "GET",
    authentication: "none",
    side_effects: "none_in_cashloom_application_handler",
    idempotent: true,
    cost: zeroCost,
    custody: custodyBoundary(runtime),
  } as const;
}

export function cashLoomOrientation(
  request: Request,
  runtime: CashLoomSurfaceRuntime = DEFAULT_SURFACE_RUNTIME,
) {
  const origin = resolveCashLoomPublicOrigin(request);
  const url = (path: string) => absolute(origin, path);
  const readAction = commonAction(runtime);
  return {
    schema_version: "cashloom.orientation/1",
    service: {
      id: "cashloom.moneyworld",
      name: "CashLoom Moneyworld",
      canonical_url: `${origin}/`,
      manifest: url(SURFACE_MANIFEST_PATH),
      mode: runtime === "hosted_info"
        ? "public_read_only_information_process"
        : "local_sovereign_public_read_floor",
      runtime,
      source_code: "https://github.com/cambridgetcg/cashloom",
    },
    surface: {
      profile: SURFACE_PROFILE,
      manifest_schema: SURFACE_MANIFEST_SCHEMA_URL,
      problem_schema: SURFACE_PROBLEM_SCHEMA_URL,
      profile_documentation: SURFACE_PROFILE_DOCUMENTATION_URL,
      declared_scope: [url("/v1/orientation"), url("/v1/rights"), url("/v1/data-practices")],
      boundary:
        "Only the manifest-declared resources and one unpredictable router fall-through are covered by a Surface checker observation.",
    },
    operating_contract: {
      registration: "not_required_for_public_reads",
      credentials: "not_required_for_public_reads",
      request_bodies: "none_for_the_get_actions_described_here",
      application_side_effects: "none_for_declared_and_orientation_listed_get_actions",
      application_price: zeroCost,
      authority:
        "Public read access grants no authority to trade, transfer, sign, broadcast, bind a person, or act for a wallet.",
      custody: custodyBoundary(runtime),
    },
    actions: [
      {
        id: "world.snapshot",
        ...readAction,
        href: url("/v1/world"),
        href_template: `${url("/v1/world")}{?base}`,
        input: {
          location: "query",
          parameters: [{ name: "base", type: "string", required: false, default: "USD", enum: ["USD", "EUR", "GBP", "JPY"] }],
        },
        response: {
          media_type: WORLD_MEDIA_TYPE,
          schema: { id: "cashloom.world/1", version_field: "schema" },
          freshness: "Read generated_at, each observation's timestamps, stale flag, cadence, and source metadata.",
          cache: "The response Cache-Control header is authoritative; clients may retain the last verified snapshot and refresh in background.",
          partial: "Allowed and explicit in status.state, status.complete, status.unavailable, stale_count, and per-source status.",
        },
      },
      {
        id: "onchain.snapshot",
        ...readAction,
        href: url("/v1/onchain"),
        href_template: url("/v1/onchain"),
        input: { location: "none", parameters: [] },
        response: {
          media_type: ONCHAIN_MEDIA_TYPE,
          schema: { id: "cashloom.onchain/1", version_field: "schema" },
          freshness: "Use generated_at plus receipt observed_at/fetched_at, reference blocks, and stale fields; latest-state is not history.",
          cache: "Cache-Control, ETag, Age, and CashLoom delivery headers are authoritative when present.",
          partial: "Allowed and explicit by section, source, observation status, unavailable entries, and limitations.",
        },
      },
      {
        id: "onchain.section",
        ...readAction,
        href: url("/v1/onchain/chains"),
        href_template: `${url("/v1/onchain")}/{section}`,
        input: {
          location: "path",
          parameters: [{
            name: "section",
            type: "string",
            required: true,
            enum: ["chains", "stablecoins", "lending-markets", "pools", "bridges"],
          }],
        },
        response: {
          media_type: ONCHAIN_SECTION_MEDIA_TYPE,
          schema: { id: "cashloom.onchain-section/1", version_field: "schema" },
          freshness: "Uses the same generated_at, source, receipt, reference-block, and stale semantics as the composite snapshot.",
          cache: "Read response caching headers; section delivery may reuse the same bounded composite snapshot.",
          partial: "Allowed and named; a section never implies protocol-wide or chain-wide completeness.",
        },
      },
      {
        id: "fx.rate",
        ...readAction,
        href: url("/v1/fx/EUR/USD"),
        href_template: `${url("/v1/fx")}/{base}/{quote}`,
        input: {
          location: "path",
          parameters: [
            { name: "base", type: "string", required: true, format: "ISO-4217 code" },
            { name: "quote", type: "string", required: true, format: "ISO-4217 code" },
          ],
        },
        response: {
          media_type: MONEYFACT_MEDIA_TYPE,
          schema: { id: "cashloom.moneyfact/1", version_field: "@type", published_json_schema: false },
          freshness: "The ECB reference date, observed_at, fetched_at, and stale_after_s are not a tradeable live quote.",
          cache: "No cross-route freshness inference; retain only according to response and fact timestamps.",
          partial: "A pair is returned as one fact or refused; source and recomputation metadata remain attached.",
        },
      },
      {
        id: "cash.rates",
        ...readAction,
        href: url("/v1/rates/cash"),
        href_template: url("/v1/rates/cash"),
        input: { location: "none", parameters: [] },
        response: {
          media_type: "application/json",
          schema: { id: "cashloom.cash-rates/legacy", version_field: null, published_json_schema: false },
          freshness: "SOFR and EFFR carry observation, publication, fetch, cadence, and revision fields; publication is delayed.",
          cache: "Read Cache-Control and the source timestamps.",
          partial: "The current route returns both official observations or a route-specific upstream refusal.",
        },
      },
      {
        id: "fed.announcements",
        ...readAction,
        href: url("/v1/announcements/fed"),
        href_template: url("/v1/announcements/fed"),
        input: { location: "none", parameters: [] },
        response: {
          media_type: "application/vnd.cashloom.monetary-policy-announcements.v1+json",
          schema: { id: "cashloom.monetary-policy-announcements/1", version_field: null, published_json_schema: false },
          freshness: "Official item timestamps and feed fetch/publication timestamps are supplied; linked releases remain authoritative.",
          cache: "Read Cache-Control and source timestamps.",
          partial: "This is a bounded latest official-feed listing, not an exhaustive historical archive or interpretation.",
        },
      },
    ],
    related_reads: [
      { id: "chains.registry", href: url("/v1/chains") },
      { id: "fiat.matrix", href_template: `${url("/v1/rates/fiat")}{?base}` },
      { id: "fees.latest", href_template: `${url("/v1/fees")}{?chain}` },
      { id: "assets.registry", href_template: `${url("/v1/assets")}{?q}` },
      { id: "prices.latest", href: url("/v1/prices") },
      { id: "guide.legacy", href: url("/v1/guide") },
    ],
    invariants_and_limits: [
      runtime === "hosted_info"
        ? "The hosted info process does not custody funds, hold signing keys, construct transactions, or broadcast transactions."
        : "The local sovereign process has separate owner-controlled vault/write capabilities, but the declared and orientation-listed public GET handlers do not access keys, construct transactions, or broadcast transactions.",
      "Amounts intended for arithmetic use integer strings and explicit decimal scales; display strings are not execution inputs.",
      "Source failure, staleness, and partial coverage are disclosed rather than filled with estimates.",
      "Onchain pool rows are selected contract-state observations, not TVL, volume, APY, safety, or route recommendations.",
      "Cross-source threads describe possible channels and limits; they do not prove causation or provide investment advice.",
      "Legacy routes outside Surface resources do not yet share one universal content-negotiation or problem contract.",
    ],
    next_actions: [
      { rel: "read_world", href: url("/v1/world"), method: "GET", accept: WORLD_MEDIA_TYPE },
      { rel: "read_onchain", href: url("/v1/onchain"), method: "GET", accept: ONCHAIN_MEDIA_TYPE },
      { rel: "read_rights", href: url("/v1/rights"), method: "GET", accept: "application/json" },
      { rel: "read_data_practices", href: url("/v1/data-practices"), method: "GET", accept: "application/json" },
    ],
  } as const;
}

export function cashLoomRights(request: Request) {
  const origin = resolveCashLoomPublicOrigin(request);
  const url = (path: string) => absolute(origin, path);
  return {
    schema_version: "cashloom.rights-disclosure/1",
    rights_origin: "intrinsic_not_host_granted",
    baseline: {
      profile: "xenia.rights/0.1",
      adoption: "voluntary_repository_adoption",
      href: url("/RIGHTS.md"),
      vendored_mirror_sha256: "b72a6da110c582e5683bf0fabde5017db93d2199398014c8421a82f5318da313",
      pinned_upstream_release: "npm-xenia-v0.1.0-beta.4",
      pinned_upstream_commit: "6419d37dda9fb282242754685dba3edcb4bbf74b",
      qualification:
        "Adopting and serving the baseline is a declaration; it does not by itself prove implementation at every route or infrastructure layer.",
    },
    covenant: {
      profile: "xenia-covenant/0.1",
      record: url("/.well-known/xenia-rights.json"),
      status: "draft",
      activated: false,
      guest_acceptance_required: false,
      speaker_authority: "unverified",
      evidence_state: "asserted_unverified",
      outcomes: "The draft retains partial, failed, and unknown duty outcomes; read the record for exact scope and limitations.",
      qualification:
        "The record proposes a unilateral host undertaking. It is not guest assent, a conformance badge, a Surface claim, or proof of practice.",
    },
    surface_relationship: {
      profile: SURFACE_PROFILE,
      statement:
        "Surface 0.1 tests bounded public discovery, declared GET representations, and one route-not-found response. A Surface result neither activates nor proves the Covenant.",
      documentation: SURFACE_PROFILE_DOCUMENTATION_URL,
    },
    next_actions: [
      { rel: "read_baseline", href: url("/RIGHTS.md"), method: "GET", accept: "text/markdown" },
      { rel: "inspect_covenant_draft", href: url("/.well-known/xenia-rights.json"), method: "GET", accept: "application/json" },
      { rel: "read_data_practices", href: url("/v1/data-practices"), method: "GET", accept: "application/json" },
    ],
  } as const;
}

export function cashLoomDataPractices(
  request: Request,
  runtime: CashLoomSurfaceRuntime = DEFAULT_SURFACE_RUNTIME,
) {
  const origin = resolveCashLoomPublicOrigin(request);
  const url = (path: string) => absolute(origin, path);
  const hosted = runtime === "hosted_info";
  return {
    schema_version: "cashloom.data-practices/1",
    assessed_scope: {
      evidence_state: "source_asserted_not_independently_attested",
      declared_surface_resources: [url("/v1/orientation"), url("/v1/rights"), url("/v1/data-practices")],
      application_entrypoint: hosted ? "sovereign/src/info-server.ts" : "sovereign/src/index.ts",
      runtime,
      excludes: [
        "platform retention",
        "edge retention",
        "network intermediary behavior",
        "operator behavior",
        "browser vendor or sync behavior beyond the described CashLoom snapshot cache",
        "upstream retention",
        "legal conclusions",
        "backup systems",
      ],
    },
    application_handler_layer: {
      declared_surface_resources: {
        account_required: false,
        cookie_required: false,
        credential_required: false,
        request_body_required: false,
        query_parameters: "none",
        upstream_calls: "none",
        fields_used: ["request URL", "Accept", `allowlisted ${CASHLOOM_PUBLIC_ORIGIN_HEADER} alias when present`],
      },
      persistence: {
        application_database_imported_by_process: !hosted,
        vault_or_sender_modules_imported_by_process: !hosted,
        declared_surface_resources_access_application_database: false,
        declared_surface_resources_access_vault_or_senders: false,
        intentionally_persists_caller_identity: false,
        intentionally_persists_request_or_query_values: false,
        sets_application_cookies: false,
        qualification:
          hosted
            ? "These statements describe the hosted CashLoom application handlers and their module graph, not logs or retention outside that layer."
            : "The local process contains separate owner-controlled database, vault, payment, and sender routes. They are outside the declared Surface; this disclosure makes no process-wide no-custody or no-persistence claim.",
      },
      other_public_read_routes: {
        path_and_query_inputs: "Some routes accept currencies, asset names, public chain addresses, holdings, or chain selectors.",
        upstream_disclosure:
          "A route may send a public identifier or selected query to the source named in its response; source and method fields should be inspected before supplying an input.",
      },
    },
    external_layers: [
      ...(hosted ? [{
        id: "fly_platform",
        role: "API hosting and transport termination",
        technical_metadata_visible: "possible, including IP address, timing, headers, user-agent, and route",
        retention: "not established by this application disclosure; consult the operator and Fly.io policies/configuration",
      }, {
        id: "cloudflare_pages",
        role: "cashloom.io frontend and same-origin API proxy when that origin is used",
        technical_metadata_visible: "possible, including IP address, timing, headers, user-agent, route, and cache metadata",
        retention: "not established by this application disclosure; consult Cloudflare and site configuration",
      }, {
        id: "browser_local_storage",
        role: "cache-first dashboard experience for World and Onchain",
        technical_metadata_visible:
          "validated public market snapshot bodies, their ETag when supplied, and the browser receipt timestamp; no wallet data, caller identity, or user-entered input is stored in this cache",
        retention:
          "up to 24 hours, controlled and clearable by the browser; the cached body is not sent back to CashLoom, while its ETag may be sent in If-None-Match for a conditional refresh",
      }, {
        id: "browser_preferences",
        role: "World currency lens and watch-list interface preferences",
        technical_metadata_visible:
          "the selected ISO currency code, stable public observation IDs in the watch list, and the watch-only toggle; no account or wallet identifier is attached",
        retention:
          "stored locally until changed or cleared by the browser; the currency code is sent as the World base query, while the watch list and toggle remain local to the interface",
      }] : [{
        id: "local_machine_and_operator",
        role: "owner-operated sovereign process, local storage, logs, and network configuration",
        technical_metadata_visible:
          "depends on the owner's bind address, operating system, reverse proxy, logging, and local configuration",
        retention:
          "owner-controlled and not established by this Surface disclosure; private vault/database behavior is outside the declared resources",
      }]),
      {
        id: "network_intermediaries",
        role: "DNS, routing, TLS-adjacent and client network layers",
        technical_metadata_visible: "layer-dependent",
        retention: "unknown to CashLoom application handlers",
      },
      {
        id: "upstream_sources",
        role: "official feeds, public RPC providers, and public chain-data APIs used by market-data routes",
        technical_metadata_visible: "CashLoom server request metadata and route-specific public inputs may be visible",
        retention: "source-specific and not controlled or established by CashLoom application handlers",
      },
    ],
    conclusions: {
      cross_layer_anonymity_promised: false,
      no_tracking_claim_for_external_layers: false,
      statement:
        "No account or credential is required by the declared public handlers, but that is not a promise that a caller is anonymous to every infrastructure, network, operator, browser, or upstream layer.",
    },
    limitations: [
      "No current, independently verified layered retention inventory is attached.",
      "No claim is made that infrastructure logs are absent, that IP addresses are personal-data-free, or that third parties share CashLoom's application practices.",
      hosted
        ? "The browser storage disclosures cover CashLoom's current World and Onchain website implementation, not extensions, browser sync, browser-vendor behavior, or other clients."
        : "The local sovereign process contains private and write capabilities outside this declared read Surface; inspect local configuration and source before exposing it beyond loopback.",
    ],
    next_actions: [
      { rel: "read_orientation", href: url("/v1/orientation"), method: "GET", accept: "application/json" },
      { rel: "read_rights", href: url("/v1/rights"), method: "GET", accept: "application/json" },
      { rel: "inspect_covenant_draft", href: url("/.well-known/xenia-rights.json"), method: "GET", accept: "application/json" },
    ],
  } as const;
}

type ResourceBodyFactory = (
  request: Request,
  runtime: CashLoomSurfaceRuntime,
) => Record<string, unknown>;

const RESOURCE_BODIES: Readonly<Record<string, ResourceBodyFactory>> = Object.freeze({
  orientation: cashLoomOrientation,
  rights: (request) => cashLoomRights(request),
  "data-practices": cashLoomDataPractices,
});

function findResource(manifest: SurfaceManifest, id: string): SurfaceResource {
  const resource = manifest.resources.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`Surface resource '${id}' is absent from the manifest`);
  return resource;
}

function serveSurfaceResource(
  request: Request,
  resourceId: string,
  runtime: CashLoomSurfaceRuntime,
): Response {
  const manifest = defineCashLoomSurfaceManifest(request, runtime);
  const resource = findResource(manifest, resourceId);
  const mediaType = negotiateSurfaceResource(resource, request.headers.get("Accept"));
  if (mediaType === "not-acceptable") {
    return createSurfaceProblemResponse(createSurfaceNotAcceptableProblem({
      resource,
      docs: [absolute(resolveCashLoomPublicOrigin(request), "/v1/orientation")],
    }), {
      headers: { "Cache-Control": "no-store", Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER },
    });
  }
  const factory = RESOURCE_BODIES[resourceId];
  if (!factory) throw new Error(`Surface resource '${resourceId}' has no body factory`);
  return createSurfaceResourceResponse(mediaType, factory(request, runtime), {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER,
    },
  });
}

export function surfaceRouteNotFoundResponse(request: Request): Response {
  const origin = resolveCashLoomPublicOrigin(request);
  return createSurfaceProblemResponse(createSurfaceRouteNotFoundProblem({
    manifestUrl: absolute(origin, SURFACE_MANIFEST_PATH),
    docs: [absolute(origin, "/v1/orientation")],
  }), {
    headers: { "Cache-Control": "no-store", Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER },
  });
}

export function surfaceInternalErrorResponse(request: Request): Response {
  const origin = resolveCashLoomPublicOrigin(request);
  return createSurfaceProblemResponse(createSurfaceProblem({
    type: absolute(origin, "/problems/internal-error"),
    title: "Request failed inside the service",
    status: 500,
    code: "internal_error",
    detail: "The service could not complete this request. No error details are exposed at the public boundary.",
    retryable: false,
    terminal: true,
    docs: [absolute(origin, "/v1/orientation")],
  }), {
    headers: { "Cache-Control": "no-store", Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER },
  });
}

function agentPointer(request: Request): Response {
  const origin = resolveCashLoomPublicOrigin(request);
  const body = [
    "CashLoom machine discovery",
    `Manifest: ${absolute(origin, SURFACE_MANIFEST_PATH)}`,
    `Profile: ${SURFACE_PROFILE}`,
    "The JSON manifest is authoritative; this text file is a compatibility pointer.",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER,
    },
  });
}

export function mountXeniaSurface(app: Hono, options: CashLoomSurfaceOptions = {}): void {
  const runtime = options.runtime ?? DEFAULT_SURFACE_RUNTIME;
  app.get(SURFACE_MANIFEST_PATH, (c) => createSurfaceManifestResponse(
    defineCashLoomSurfaceManifest(c.req.raw, runtime),
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        Vary: CASHLOOM_PUBLIC_ORIGIN_HEADER,
      },
    },
  ));
  app.get("/v1/orientation", (c) => serveSurfaceResource(c.req.raw, "orientation", runtime));
  app.get("/v1/rights", (c) => serveSurfaceResource(c.req.raw, "rights", runtime));
  app.get("/v1/data-practices", (c) => serveSurfaceResource(c.req.raw, "data-practices", runtime));
  app.get("/agent.txt", (c) => agentPointer(c.req.raw));
  app.get("/.well-known/agent.txt", (c) => agentPointer(c.req.raw));
}
