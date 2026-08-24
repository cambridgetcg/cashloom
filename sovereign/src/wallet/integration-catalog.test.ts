import { describe, expect, test } from "bun:test";
import { buildWalletIntegrationCatalog } from "./integration-catalog.ts";

describe("wallet integration catalogue", () => {
  test("is networkless, exact-counted and never exposes credential material", () => {
    const secret = "SECRET_CANARY_https://provider.invalid";
    const catalog = buildWalletIntegrationCatalog({
      now: new Date("2030-01-01T00:00:00.000Z"),
      env: {
        GOCARDLESS_SECRET_ID: secret,
        GOCARDLESS_SECRET_KEY: secret,
        YAPILY_APPLICATION_ID: secret,
        YAPILY_APPLICATION_SECRET: secret,
      },
      connection_counts: [
        { kind: "WEBAUTHN", count: 2n },
        { kind: "FIAT", count: "3" },
      ],
    });
    expect(catalog.network_on_get).toBe(false);
    expect(catalog.integrations.find(({ id }) => id === "webauthn-passkey")?.persisted_connections).toBe("2");
    expect(catalog.integrations.find(({ id }) => id === "gocardless-bank-data")).toMatchObject({ configured: true, execution_enabled: false });
    expect(catalog.integrations.find(({ id }) => id === "yapily-pay-by-bank")).toMatchObject({ configured: true, configuration_state: "policy_blocked", execution_enabled: false });
    expect(JSON.stringify(catalog)).not.toContain(secret);
    expect(JSON.stringify(catalog)).not.toContain("provider.invalid");
  });

  test("keeps every signing or payment integration fail-closed by default", () => {
    const catalog = buildWalletIntegrationCatalog({ env: {} });
    expect(catalog.integrations).toHaveLength(7);
    expect(catalog.integrations.every(({ execution_enabled }) => execution_enabled === false)).toBe(true);
    expect(catalog.integrations.find(({ id }) => id === "gocardless-bank-data")?.configuration_state).toBe("credentials_required");
    expect(catalog.safety.agent_interactive_completion_allowed).toBe(false);
    expect(catalog.safety.atomic_verified_persistence_enabled).toBe(false);
  });
});
