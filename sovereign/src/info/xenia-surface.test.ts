import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  SURFACE_MANIFEST_SCHEMA_URL,
  SURFACE_PROBLEM_SCHEMA_URL,
  SURFACE_PROFILE_DOCUMENTATION_URL,
} from "@agenttool/xenia/surface-0.1";
import {
  CASHLOOM_API_ORIGIN,
  CASHLOOM_PUBLIC_ORIGIN_HEADER,
  CASHLOOM_WEBSITE_ORIGIN,
  CASHLOOM_WORLD_RUN_LOCALLY_URL,
  CASHLOOM_WORLD_SOURCE_URL,
  defineCashLoomSurfaceManifest,
  mountXeniaSurface,
  resolveCashLoomPublicOrigin,
  surfaceRouteNotFoundResponse,
} from "./xenia-surface.ts";
import { mountInfoDoors } from "./doors.ts";
import { WORLD_BASE_CURRENCIES, WORLD_MEDIA_TYPE } from "./world-door.ts";
import { CAPITAL_FLOWS_MEDIA_TYPE, CAPITAL_FLOWS_SCHEMA, HISTORY_LIMIT } from "./capital-flows/model.ts";

const LOCAL_ORIGIN = "http://127.0.0.1:4899";

function testApp(): Hono {
  const app = new Hono();
  mountXeniaSurface(app);
  app.notFound((c) => surfaceRouteNotFoundResponse(c.req.raw));
  return app;
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

describe("CashLoom World source links", () => {
  // release/moneyworld-wallet-kernel-v2-20260823 was deleted (gh api: 404 Branch not found, 2026-10-26).
  it("name the live release branch and a heading the root README has", () => {
    expect(CASHLOOM_WORLD_SOURCE_URL).toBe("https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929");
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf-8");
    expect(readme).toContain("\n## Run the existing information tools locally\n");
    expect(CASHLOOM_WORLD_RUN_LOCALLY_URL).toBe(`${CASHLOOM_WORLD_SOURCE_URL}#run-the-existing-information-tools-locally`);
  });
});

function expectVaryAccept(response: Response): void {
  const vary = response.headers.get("Vary")?.split(",").map((token) => token.trim().toLowerCase());
  expect(vary).toContain("accept");
  expect(vary).toContain(CASHLOOM_PUBLIC_ORIGIN_HEADER.toLowerCase());
}

describe("CashLoom XENIA Surface manifest", () => {
  it("emits the exact rc.1-pinned Surface 0.1 discovery contract", async () => {
    const response = await testApp().request(`${LOCAL_ORIGIN}/.well-known/agent.json`, {
      headers: { Accept: "application/json" },
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json(?:;|$)/);
    expectVaryAccept(response);
    expect(body).toMatchObject({
      $schema: SURFACE_MANIFEST_SCHEMA_URL,
      schema_version: "xenia.surface.manifest/0.1",
      profile: "xenia-surface/0.1",
      problem_schema: SURFACE_PROBLEM_SCHEMA_URL,
      documentation: `${LOCAL_ORIGIN}/v1/orientation`,
      service: { name: "CashLoom World", canonical_url: `${LOCAL_ORIGIN}/` },
      claims: [],
    });
    expect(body.resources.map((resource: any) => resource.id)).toEqual([
      "orientation",
      "rights",
      "data-practices",
    ]);
    for (const resource of body.resources) {
      const href = new URL(resource.href);
      expect(href.origin).toBe(LOCAL_ORIGIN);
      expect(href.search).toBe("");
      expect(href.hash).toBe("");
      expect(resource).toMatchObject({
        representations: ["application/json"],
        default_media_type: "application/json",
        auth: "none",
      });
    }
    expect(body.not_covered).toEqual(expect.arrayContaining([
      "privacy and retention",
      expect.stringContaining("Covenant conformance"),
      expect.stringContaining("market-data routes outside"),
    ]));
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(65_536);
  });

  it("uses only configured, allowlisted alias, or loopback origins", () => {
    expect(resolveCashLoomPublicOrigin(new Request("https://untrusted.example/a"), undefined))
      .toBe(CASHLOOM_API_ORIGIN);
    expect(resolveCashLoomPublicOrigin(new Request("http://127.23.4.5:7777/a"), undefined))
      .toBe("http://127.23.4.5:7777");
    expect(resolveCashLoomPublicOrigin(new Request("http://localhost:7777/a"), undefined))
      .toBe("http://localhost:7777");
    expect(resolveCashLoomPublicOrigin(new Request("https://untrusted.example/a"), "https://configured.example"))
      .toBe("https://configured.example");
    expect(resolveCashLoomPublicOrigin(new Request("https://untrusted.example/a"), "https://configured.example/path"))
      .toBe(CASHLOOM_API_ORIGIN);
    expect(resolveCashLoomPublicOrigin(new Request("https://untrusted.example/a", {
      headers: { [CASHLOOM_PUBLIC_ORIGIN_HEADER]: CASHLOOM_WEBSITE_ORIGIN },
    }), undefined)).toBe(CASHLOOM_WEBSITE_ORIGIN);
    expect(resolveCashLoomPublicOrigin(new Request("https://untrusted.example/a", {
      headers: { [CASHLOOM_PUBLIC_ORIGIN_HEADER]: "https://evil.example" },
    }), undefined)).toBe(CASHLOOM_API_ORIGIN);
  });

  it("does not trust a public request Host when defining the manifest", () => {
    const manifest = defineCashLoomSurfaceManifest(new Request("https://attacker.example/.well-known/agent.json"));
    expect(manifest.service.canonical_url).toBe(`${CASHLOOM_API_ORIGIN}/`);
    expect(manifest.resources.every((resource) => new URL(resource.href).origin === CASHLOOM_API_ORIGIN)).toBe(true);
  });
});

describe("CashLoom Surface representation negotiation", () => {
  const acceptedCases = [
    "application/json",
    "text/html;q=0, application/json;q=1",
    "application/*;q=1, text/html;q=0.2",
    "*/*",
  ];
  const refusedCases = [
    "text/html",
    "application/json;q=0, */*;q=1",
    "application/x-xenia-unsupported",
  ];

  for (const resource of ["orientation", "rights", "data-practices"]) {
    for (const accept of acceptedCases) {
      it(`${resource} serves versioned JSON for Accept: ${accept}`, async () => {
        const response = await testApp().request(`${LOCAL_ORIGIN}/v1/${resource}`, { headers: { Accept: accept } });
        const body = await json(response);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toMatch(/^application\/json(?:;|$)/);
        expectVaryAccept(response);
        expect(Array.isArray(body)).toBe(false);
        expect(typeof body.schema_version).toBe("string");
        expect(body.schema_version.length).toBeGreaterThan(0);
      });
    }

    for (const accept of refusedCases) {
      it(`${resource} returns a recoverable XENIA 406 for Accept: ${accept}`, async () => {
        const response = await testApp().request(`${LOCAL_ORIGIN}/v1/${resource}`, { headers: { Accept: accept } });
        const body = await json(response);
        expect(response.status).toBe(406);
        expect(response.headers.get("Content-Type")).toMatch(/^application\/problem\+json(?:;|$)/);
        expectVaryAccept(response);
        expect(body).toMatchObject({
          schema_version: "xenia.surface.problem/0.1",
          status: 406,
          code: "not_acceptable",
          retryable: false,
          terminal: false,
          next_actions: [{
            rel: "retry_with_supported_representation",
            href: `${LOCAL_ORIGIN}/v1/${resource}`,
            method: "GET",
            accept: "application/json",
          }],
          docs: [`${LOCAL_ORIGIN}/v1/orientation`],
        });
      });
    }
  }
});

describe("CashLoom agent recovery and disclosures", () => {
  it("returns the exact one-action discover problem for an unpredictable route", async () => {
    const response = await testApp().request(`${LOCAL_ORIGIN}/not-advertised-${crypto.randomUUID()}`, {
      headers: { Accept: "application/problem+json" },
    });
    const body = await json(response);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/problem\+json(?:;|$)/);
    expectVaryAccept(response);
    expect(body).toMatchObject({
      schema_version: "xenia.surface.problem/0.1",
      type: `${LOCAL_ORIGIN}/problems/route-not-found`,
      title: "No resource exists at this path",
      status: 404,
      code: "route_not_found",
      retryable: false,
      terminal: false,
      docs: [`${LOCAL_ORIGIN}/v1/orientation`],
    });
    expect(body.next_actions).toEqual([{
      rel: "discover",
      href: `${LOCAL_ORIGIN}/.well-known/agent.json`,
      method: "GET",
      accept: "application/json",
    }]);
  });

  it("publishes both plain-text compatibility pointers", async () => {
    for (const path of ["/agent.txt", "/.well-known/agent.txt"]) {
      const response = await testApp().request(`${LOCAL_ORIGIN}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toMatch(/^text\/plain(?:;|$)/);
      expect(await response.text()).toContain(`${LOCAL_ORIGIN}/.well-known/agent.json`);
    }
  });

  it.each(["hosted_info", "local_sovereign"] as const)("publishes World release links and every supported base for %s", async (runtime) => {
    const app = new Hono();
    mountXeniaSurface(app, { runtime });
    const manifest = await json(await app.request(`${LOCAL_ORIGIN}/.well-known/agent.json`));
    expect(manifest.service.name).toBe("CashLoom World");
    expect(manifest.documentation).toBe(`${LOCAL_ORIGIN}/v1/orientation`);
    expect(manifest.resources.map((resource: any) => resource.id)).toEqual([
      "orientation", "rights", "data-practices",
    ]);

    const response = await app.request(`${LOCAL_ORIGIN}/v1/orientation`, {
      headers: { Accept: "application/json" },
    });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schema_version: "cashloom.orientation/1",
      service: {
        id: "cashloom.moneyworld",
        name: "CashLoom World",
        canonical_url: `${LOCAL_ORIGIN}/`,
        manifest: `${LOCAL_ORIGIN}/.well-known/agent.json`,
        mode: runtime === "hosted_info"
          ? "public_read_only_information_process"
          : "local_sovereign_public_read_floor",
        runtime,
        source_code: "https://github.com/cambridgetcg/cashloom/tree/release/service-workspace-20260929",
        documentation: "https://github.com/cambridgetcg/cashloom/blob/release/service-workspace-20260929/MONEYWORLD.md",
        source_access: expect.stringContaining("private repository"),
      },
    });
    expect(body.surface.declared_scope).toEqual(manifest.resources.map((resource: any) => resource.href));
    const world = body.actions.find((action: any) => action.id === "world.snapshot");
    expect(world).toMatchObject({
      href: `${LOCAL_ORIGIN}/v1/world`,
      href_template: `${LOCAL_ORIGIN}/v1/world{?base}`,
      response: {
        media_type: WORLD_MEDIA_TYPE,
        schema: { id: "cashloom.world/1", version_field: "schema" },
      },
    });
    expect(world.input).toEqual({
      location: "query",
      parameters: [{ name: "base", type: "string", required: false, default: "USD", enum: WORLD_BASE_CURRENCIES }],
    });
    expect(world.input.parameters[0].enum).toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY"]);
  });

  it.each(["hosted_info", "local_sovereign"] as const)("advertises the exact capital-flow read without enlarging Surface for %s", async (runtime) => {
    const app = new Hono();
    mountXeniaSurface(app, { runtime });
    const origin = runtime === "hosted_info" ? CASHLOOM_WEBSITE_ORIGIN : LOCAL_ORIGIN;
    const headers = runtime === "hosted_info" ? { [CASHLOOM_PUBLIC_ORIGIN_HEADER]: origin } : undefined;
    const orientation = await json(await app.request(`${LOCAL_ORIGIN}/v1/orientation`, { headers }));
    const manifest = await json(await app.request(`${LOCAL_ORIGIN}/.well-known/agent.json`, { headers }));
    const capital = orientation.actions.filter((action: any) => action.id === "capital-flows.snapshot");
    expect(capital).toHaveLength(1);
    expect(capital[0]).toMatchObject({
      href: `${origin}/v1/capital-flows`,
      href_template: `${origin}/v1/capital-flows`,
      method: "GET",
      authentication: "none",
      input: { location: "none", parameters: [] },
      custody: orientation.operating_contract.custody,
      response: {
        media_type: CAPITAL_FLOWS_MEDIA_TYPE,
        schema: { id: CAPITAL_FLOWS_SCHEMA, version_field: "schema" },
        history: { policy: "latestRevisedPublisherHistoryNotVintageArchive", maximum_observations_per_series: HISTORY_LIMIT },
      },
    });
    expect(capital[0].response.freshness).toContain("generatedAt");
    expect(capital[0].response.freshness).toContain("receipt.publicationAt (nullable)");
    expect(capital[0].response.freshness).toContain("expectation_unknown");
    expect(capital[0].response.amounts).toContain("unitMultiplier");
    expect(capital[0].response.cache).toContain("at most one second");
    expect(capital[0].response.cache).toContain("No continuous collector or alerts");
    expect(capital[0].response.partial).toContain("refresh.launchReadiness is notAssessed");
    expect(capital[0].response.partial).toContain("rightsWithheld");
    expect(orientation.next_actions).toContainEqual({
      rel: "read_capital_flows", href: `${origin}/v1/capital-flows`, method: "GET", accept: CAPITAL_FLOWS_MEDIA_TYPE,
    });
    expect(manifest.resources.map((resource: any) => resource.id)).toEqual(["orientation", "rights", "data-practices"]);
    expect(orientation.surface.declared_scope).not.toContain(capital[0].href);
    expect(manifest.claims).toEqual([]);
    expect(manifest.not_covered).toContainEqual(expect.stringContaining("market-data routes outside"));

    const practices = await json(await app.request(`${LOCAL_ORIGIN}/v1/data-practices`, { headers }));
    expect(practices.application_handler_layer.persistence.application_database_imported_by_process)
      .toBe(runtime === "local_sovereign");
    const disclosure = practices.application_handler_layer.other_public_read_routes.capital_flows;
    expect(disclosure.inputs).toContain("filters operate locally");
    expect(disclosure.persistence).toContain("at most seven days");
    expect(disclosure.persistence).toContain("restart loses them");
    expect(disclosure.browser_storage).toContain("no application-level persistent snapshot or preference storage");
    expect(practices.conclusions.cross_layer_anonymity_promised).toBe(false);
  });

  it("orients agents with typed, zero-cost, non-custodial read actions", async () => {
    const response = await testApp().request(`${LOCAL_ORIGIN}/v1/orientation`, {
      headers: { Accept: "application/json" },
    });
    const body = await json(response);
    const ids = body.actions.map((action: any) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "world.snapshot",
      "capital-flows.snapshot",
      "onchain.snapshot",
      "onchain.section",
      "fx.rate",
      "cash.rates",
      "fed.announcements",
    ]);
    expect(body.operating_contract.custody).toMatchObject({
      funds: "none", signing_keys: "none", transaction_construction: "none", broadcast: "none",
    });
    for (const action of body.actions) {
      expect(new URL(action.href).origin).toBe(LOCAL_ORIGIN);
      expect(action).toMatchObject({
        method: "GET",
        authentication: "none",
        side_effects: "none_in_cashloom_application_handler",
        idempotent: true,
        cost: { amount_minor: "0", asset: "fiat:iso4217/USD" },
        custody: { funds: "none", signing_keys: "none", transaction_construction: "none", broadcast: "none" },
        response: { media_type: expect.any(String), schema: expect.any(Object), partial: expect.any(String) },
      });
      expect(action.input.parameters).toBeInstanceOf(Array);
    }
    expect(body.invariants_and_limits).toEqual(expect.arrayContaining([
      expect.stringContaining("not TVL, volume, APY, safety, or route recommendations"),
      expect.stringContaining("Legacy routes outside Surface resources"),
    ]));
  });

  it("separates pinned Rights adoption from the unactivated Covenant draft", async () => {
    const response = await testApp().request(`${LOCAL_ORIGIN}/v1/rights`, {
      headers: { Accept: "application/json" },
    });
    const body = await json(response);
    expect(body.baseline).toMatchObject({
      profile: "xenia.rights/0.1",
      adoption: "voluntary_repository_adoption",
      pinned_upstream_release: "npm-xenia-v0.1.0-beta.4",
    });
    expect(body.covenant).toMatchObject({
      status: "draft",
      activated: false,
      guest_acceptance_required: false,
      speaker_authority: "unverified",
      evidence_state: "asserted_unverified",
    });
    expect(body.surface_relationship.documentation).toBe(SURFACE_PROFILE_DOCUMENTATION_URL);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("covenant conformant");
  });

  it("scopes data practices by layer and makes no anonymity promise", async () => {
    const response = await testApp().request(`${LOCAL_ORIGIN}/v1/data-practices`, {
      headers: { Accept: "application/json" },
    });
    const body = await json(response);
    expect(body.application_handler_layer.declared_surface_resources).toMatchObject({
      account_required: false,
      cookie_required: false,
      credential_required: false,
      request_body_required: false,
      query_parameters: "none",
      upstream_calls: "none",
    });
    expect(body.application_handler_layer.persistence).toMatchObject({
      application_database_imported_by_process: false,
      vault_or_sender_modules_imported_by_process: false,
      declared_surface_resources_access_application_database: false,
      declared_surface_resources_access_vault_or_senders: false,
      intentionally_persists_caller_identity: false,
      intentionally_persists_request_or_query_values: false,
      sets_application_cookies: false,
    });
    expect(body.external_layers.map((layer: any) => layer.id)).toEqual(expect.arrayContaining([
      "fly_platform",
      "cloudflare_pages",
      "browser_local_storage",
      "network_intermediaries",
      "upstream_sources",
    ]));
    const browser = body.external_layers.find((layer: any) => layer.id === "browser_local_storage");
    expect(browser.technical_metadata_visible).toContain("no wallet data, caller identity, or user-entered input");
    expect(browser.retention).toContain("up to 24 hours");
    expect(browser.retention).toContain("If-None-Match");
    const preferences = body.external_layers.find((layer: any) => layer.id === "browser_preferences");
    expect(preferences.technical_metadata_visible).toContain("currency code");
    expect(preferences.retention).toContain("watch list");
    expect(body.conclusions).toMatchObject({
      cross_layer_anonymity_promised: false,
      no_tracking_claim_for_external_layers: false,
    });
  });

  it("does not reuse hosted no-database or no-vault claims on the local sovereign process", async () => {
    const app = new Hono();
    mountXeniaSurface(app, { runtime: "local_sovereign" });
    const practices = await json(await app.request("http://localhost/v1/data-practices", {
      headers: { Accept: "application/json" },
    }));
    expect(practices.assessed_scope).toMatchObject({
      runtime: "local_sovereign",
      application_entrypoint: "sovereign/src/index.ts",
    });
    expect(practices.application_handler_layer.persistence).toMatchObject({
      application_database_imported_by_process: true,
      vault_or_sender_modules_imported_by_process: true,
      declared_surface_resources_access_application_database: false,
      declared_surface_resources_access_vault_or_senders: false,
    });
    const orientation = await json(await app.request("http://localhost/v1/orientation", {
      headers: { Accept: "application/json" },
    }));
    expect(orientation.service.runtime).toBe("local_sovereign");
    expect(orientation.operating_contract.custody).toMatchObject({
      funds: "none_in_declared_public_read_handlers",
      signing_keys: "the local process may contain owner-controlled vault material, but declared public reads neither accept nor access it",
      transaction_construction: "none_in_declared_or_orientation_listed_get_actions",
      broadcast: "none_in_declared_or_orientation_listed_get_actions",
    });
    for (const action of orientation.actions) {
      expect(action.custody).toEqual(orientation.operating_contract.custody);
      expect(action.method).toBe("GET");
    }
    expect(orientation.operating_contract.custody.boundary).toContain("local sovereign process");
    expect(orientation.operating_contract.custody.boundary).toContain("not a process-wide no-custody claim");
  });

  it("keeps the legacy guide but replaces whole-stack privacy overclaims with scoped links", async () => {
    const app = new Hono();
    mountInfoDoors(app);
    const body = await json(await app.request("http://localhost/v1/guide"));
    expect(body.schema_version).toBe("cashloom.guide/1");
    expect(body.doors).toMatchObject({
      discovery: "/.well-known/agent.json",
      orientation: "/v1/orientation",
      data_practices: "/v1/data-practices",
    });
    expect(body.layer_boundary).toContain("not a cross-layer anonymity promise");
    expect(JSON.stringify(body)).not.toContain("no tracking, fingerprinting, or dossiers");
    expect(JSON.stringify(body)).not.toContain("nothing is collected to sell");
  });

  it("contains no copied third-party scope in the CashLoom Covenant draft", () => {
    const draft = readFileSync(new URL("../../../rights-adoption.json", import.meta.url), "utf-8");
    const copiedProductName = ["Sino", "vAI"].join("");
    expect(draft.toLowerCase()).not.toContain(copiedProductName.toLowerCase());
    const parsed = JSON.parse(draft);
    expect(parsed.declaration).toMatchObject({
      status: "draft",
      guest_acceptance_required: false,
      reviewed_at: "2026-08-21T15:53:20Z",
    });
    expect(JSON.stringify(parsed.declaration)).not.toContain("collects nothing");
    expect(draft).not.toContain("anonymous read floor");
    expect(parsed.protective_limit_results.map((result: any) => result.outcome)).toEqual([
      "partial",
      "partial",
      "unknown",
      "unknown",
      "fail",
    ]);
  });

  it("pins the Covenant draft's schema locator to its matching immutable beta.4 source", () => {
    const draft = JSON.parse(readFileSync(
      new URL("../../../rights-adoption.json", import.meta.url),
      "utf-8",
    ));

    expect(draft.declaration.status).toBe("draft");
    expect(draft.$schema).toBe(draft.adoption_schema.source);
    expect(draft.$schema).toContain("/npm-xenia-v0.1.0-beta.4/");
    expect(draft.$schema).not.toContain("/main/");
  });

  it("scopes the repository Rights notice instead of promising cross-layer anonymity", () => {
    const notice = readFileSync(new URL("../../../RIGHTS.md", import.meta.url), "utf-8");
    expect(notice).not.toContain("](vendor/xenia/");
    expect(notice).toContain(
      "https://github.com/cambridgetcg/xenia/blob/6419d37dda9fb282242754685dba3edcb4bbf74b/RIGHTS.md",
    );
    expect(notice).toContain("intentionally persist no caller identity");
    expect(notice).toContain("not a cross-layer anonymity promise");
    expect(notice).not.toContain("nothing is collected");
  });
});
