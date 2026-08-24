import { describe, expect, test } from "bun:test";
import { integrationPresentation } from "../src/views/Connections";
import type { WalletIntegrationCatalogItem } from "../src/types";

const item = (overrides: Partial<WalletIntegrationCatalogItem> = {}): WalletIntegrationCatalogItem => ({
  id: "walletconnect-v2",
  family: "walletconnect",
  label: "WalletConnect",
  adapter_status: "verified_foundation",
  configuration_state: "policy_blocked",
  configured: false,
  execution_enabled: false,
  interaction: "owner_browser",
  persisted_connections: "0",
  capabilities: [],
  limitations: [],
  ...overrides,
});

describe("connection readiness language", () => {
  test("never calls a verified foundation live while execution is gated", () => {
    expect(integrationPresentation(item())).toEqual({
      stateLabel: "Safety gate",
      stateClass: "is-blocked",
      actionLabel: "Held until the named policy/deployment prerequisite is pinned",
    });
  });

  test("separates missing credentials, read-only readiness and enabled execution", () => {
    expect(integrationPresentation(item({ configuration_state: "credentials_required" })).stateLabel)
      .toBe("Configuration needed");
    expect(integrationPresentation(item({ configuration_state: "ready" })).stateLabel)
      .toBe("Read-only ready");
    expect(integrationPresentation(item({ execution_enabled: true })).stateLabel)
      .toBe("Enabled");
  });
});
