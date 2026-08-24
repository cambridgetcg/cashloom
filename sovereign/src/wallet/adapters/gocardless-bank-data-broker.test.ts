import { describe, expect, test } from "bun:test";
import { createGoCardlessBankDataBroker } from "./gocardless-bank-data-broker.ts";

const json = (value: unknown, status = 200): Response => new Response(
  JSON.stringify(value),
  { status, headers: { "content-type": "application/json" } },
);

const credentials = (references: string[]) => (reference: string): string => {
  references.push(reference);
  if (reference === "GOCARDLESS_SECRET_ID") return "secret-id-value";
  if (reference === "GOCARDLESS_SECRET_KEY") return "secret-key-value";
  throw new Error("wrong credential ref");
};

describe("GoCardless Bank Data broker", () => {
  test("creates a bounded GBP AIS agreement and requisition with a fixed redirect", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      json({ access: "access-token-value", access_expires: 3600, refresh: "ignored" }),
      json({ id: "agreement-1", access_scope: ["balances", "transactions"] }),
      json({
        id: "requisition-1",
        reference: "connection-1",
        status: "CR",
        accounts: [],
        link: "https://ob.gocardless.com/psd2/start/requisition-1/BANK_GB",
      }),
    ];
    const refs: string[] = [];
    const broker = createGoCardlessBankDataBroker({
      resolve_credential: credentials(refs),
      redirect_uri: "http://127.0.0.1:4747/api/wallet/v3/open-banking/return",
      date_now: () => new Date("2026-08-24T12:00:00.000Z"),
      fetch: (async (input, init) => {
        requests.push({ url: String(input), init });
        return responses.shift()!;
      }) as typeof fetch,
    });
    const action = await broker.begin({
      connection_id: "connection-1",
      institution_id: "BANK_GB",
      country: "GB",
      currency: "GBP",
      scopes: ["transactions", "balances"],
      access_valid_for_days: 30,
      max_historical_days: 90,
      // Runtime callers may add junk, but it cannot override the fixed URI.
      redirect_url: "https://evil.invalid/callback",
    } as never);
    expect(action).toEqual({
      schema_version: "cashloom.open-banking-connection-action/1",
      provider: "gocardless-bank-data",
      connection_id: "connection-1",
      provider_connection_id: "requisition-1",
      provider_agreement_id: "agreement-1",
      country: "GB",
      currency: "GBP",
      state: "awaiting_user",
      authorization_url: "https://ob.gocardless.com/psd2/start/requisition-1/BANK_GB",
      scopes: ["balances", "transactions"],
      expires_at: "2026-09-23T12:00:00.000Z",
    });
    expect(refs).toEqual(["GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY"]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://bankaccountdata.gocardless.com/api/v2/token/new/",
      "https://bankaccountdata.gocardless.com/api/v2/agreements/enduser/",
      "https://bankaccountdata.gocardless.com/api/v2/requisitions/",
    ]);
    const agreementBody = JSON.parse(String(requests[1]?.init?.body));
    expect(agreementBody).toEqual({
      institution_id: "BANK_GB",
      max_historical_days: 90,
      access_valid_for_days: 30,
      access_scope: ["balances", "transactions"],
    });
    const requisitionBody = JSON.parse(String(requests[2]?.init?.body));
    expect(requisitionBody.redirect).toBe(
      "http://127.0.0.1:4747/api/wallet/v3/open-banking/return",
    );
    expect(JSON.stringify(requests)).not.toContain("evil.invalid");
  });

  test("accepts the bounded EUR contract and rejects unsupported denominations before network", async () => {
    const responses = [
      json({ access: "access-token-value", access_expires: 3600 }),
      json({ id: "agreement-eur" }),
      json({
        id: "requisition-eur",
        reference: "connection-eur",
        status: "CR",
        link: "https://ob.gocardless.com/psd2/start/requisition-eur/BANK_DE",
      }),
    ];
    let calls = 0;
    const broker = createGoCardlessBankDataBroker({
      resolve_credential: () => "configured-secret-value",
      redirect_uri: "https://cashloom.example/open-banking/return",
      fetch: (async () => {
        calls += 1;
        return responses.shift()!;
      }) as unknown as typeof fetch,
    });
    await expect(broker.begin({
      connection_id: "connection-eur",
      institution_id: "BANK_DE",
      country: "DE",
      currency: "EUR",
      scopes: ["balances"],
      access_valid_for_days: 30,
      max_historical_days: 30,
    })).resolves.toMatchObject({ country: "DE", currency: "EUR" });
    expect(calls).toBe(3);

    await expect(broker.begin({
      connection_id: "connection-jpy",
      institution_id: "BANK_JP",
      country: "JP",
      currency: "JPY",
      scopes: ["balances"],
      access_valid_for_days: 30,
      max_historical_days: 30,
    } as never)).rejects.toMatchObject({ code: "OPEN_BANKING_INVALID_REQUEST" });
    expect(calls).toBe(3);
  });

  test("polls exact connection identity, maps linked accounts, and revokes", async () => {
    const responses = [
      json({ access: "access-token-value", access_expires: 3600 }),
      json({ id: "requisition-1", reference: "connection-1", status: "LN", accounts: ["account-b", "account-a"] }),
      json({ id: "requisition-1", reference: "connection-1", status: "LN", accounts: ["account-b", "account-a"] }),
      new Response(null, { status: 204 }),
    ];
    const broker = createGoCardlessBankDataBroker({
      resolve_credential: () => "configured-secret-value",
      redirect_uri: "https://cashloom.example/open-banking/return",
      date_now: () => new Date("2026-08-24T12:00:00.000Z"),
      fetch: (async () => responses.shift()!) as unknown as typeof fetch,
    });
    const linked = await broker.status({
      connection_id: "connection-1",
      provider_connection_id: "requisition-1",
    });
    expect(linked).toMatchObject({
      state: "linked",
      provider_status: "LN",
      account_refs: ["account-a", "account-b"],
    });
    const revoked = await broker.revoke({
      connection_id: "connection-1",
      provider_connection_id: "requisition-1",
    });
    expect(revoked).toMatchObject({ state: "revoked", provider_status: "REVOKED" });
  });

  test("rejects provider identity substitution and non-provider authorization links", async () => {
    const mismatchResponses = [
      json({ access: "access-token-value", access_expires: 3600 }),
      json({ id: "another-requisition", reference: "connection-1", status: "LN", accounts: [] }),
    ];
    const mismatch = createGoCardlessBankDataBroker({
      resolve_credential: () => "configured-secret-value",
      redirect_uri: "https://cashloom.example/open-banking/return",
      fetch: (async () => mismatchResponses.shift()!) as unknown as typeof fetch,
    });
    await expect(mismatch.status({
      connection_id: "connection-1",
      provider_connection_id: "requisition-1",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });

    const wrongReferenceResponses = [
      json({ access: "access-token-value", access_expires: 3600 }),
      json({ id: "requisition-1", reference: "connection-attacker", status: "LN", accounts: [] }),
    ];
    const wrongReference = createGoCardlessBankDataBroker({
      resolve_credential: () => "configured-secret-value",
      redirect_uri: "https://cashloom.example/open-banking/return",
      fetch: (async () => wrongReferenceResponses.shift()!) as unknown as typeof fetch,
    });
    await expect(wrongReference.status({
      connection_id: "connection-1",
      provider_connection_id: "requisition-1",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });

    const linkResponses = [
      json({ access: "access-token-value", access_expires: 3600 }),
      json({ id: "agreement-1" }),
      json({ id: "requisition-1", reference: "connection-1", status: "CR", link: "https://evil.invalid/steal" }),
    ];
    const badLink = createGoCardlessBankDataBroker({
      resolve_credential: () => "configured-secret-value",
      redirect_uri: "https://cashloom.example/open-banking/return",
      fetch: (async () => linkResponses.shift()!) as unknown as typeof fetch,
    });
    await expect(badLink.begin({
      connection_id: "connection-1",
      institution_id: "BANK_GB",
      country: "GB",
      currency: "GBP",
      scopes: ["balances"],
      access_valid_for_days: 30,
      max_historical_days: 30,
    })).rejects.toMatchObject({ code: "OPEN_BANKING_PROVIDER_MALFORMED" });
  });

  test("redacts credential-bearing transport failures", async () => {
    const canary = "SECRET_CANARY_https://credential.invalid";
    const broker = createGoCardlessBankDataBroker({
      resolve_credential: () => canary,
      redirect_uri: "https://cashloom.example/open-banking/return",
      fetch: (async () => {
        throw new Error(canary);
      }) as unknown as typeof fetch,
    });
    try {
      await broker.begin({
        connection_id: "connection-1",
        institution_id: "BANK_GB",
        country: "GB",
        currency: "GBP",
        scopes: ["transactions"],
        access_valid_for_days: 30,
        max_historical_days: 30,
      });
      throw new Error("expected transport failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "OPEN_BANKING_NETWORK_UNAVAILABLE" });
      expect(String(error)).not.toContain(canary);
    }
  });
});
