import { describe, expect, test } from "bun:test";
import type { FixedJsonHttp } from "../open-banking/http.ts";
import type { Sha256Digest } from "../open-banking/contracts.ts";
import { stableOpenBankingError } from "../open-banking/errors.ts";
import { createYapilyConnectExecutor } from "./yapily-connect-executor.ts";

const INTENT_HASH = `sha256:${"a".repeat(64)}` as Sha256Digest;
const CLOCK = new Date("2026-08-24T12:00:00.000Z");

const payment = () => ({
  execution_id: "execution-1",
  intent_hash: INTENT_HASH,
  idempotency_key: "payment-123",
  source_account_ref: "bank-account-1",
  institution_id: "bank-of-test",
  amount_minor: "12345",
  beneficiary: {
    name: "Ada Merchant",
    sort_code: "123456",
    account_number: "12345678",
  },
  reference: "CASHLOOM-123",
  expires_at: "2026-08-24T12:05:00.000Z",
});

const resolver = (refs: string[]) => (reference: string): string => {
  refs.push(reference);
  if (reference === "YAPILY_APPLICATION_ID") return "app-id";
  if (reference === "YAPILY_APPLICATION_SECRET") return "app-secret";
  throw new Error("unexpected credential ref");
};

describe("Yapily Connect GBP executor", () => {
  test("prepares and submits one exact provider-authorized domestic payment", async () => {
    const refs: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const executor = createYapilyConnectExecutor({
      resolve_credential: resolver(refs),
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      http: {
        async request(request) {
          calls.push(request as unknown as Record<string, unknown>);
          return {
            data: {
              id: "provider-payment-1",
              status: "AUTHORIZED",
              statusDetails: { status: "AUTHORIZED", isoStatus: { code: "ACCP" } },
            },
          } as never;
        },
      },
    });
    const prepared = executor.prepare(payment());
    expect(prepared).toMatchObject({
      schema_version: "cashloom.open-banking-prepared-payment/1",
      provider: "yapily-connect",
      kind: "provider-authorized",
      currency: "GBP",
      payment_type: "DOMESTIC_SINGLE_IMMEDIATE",
      authorization_state: "state-1",
    });
    expect(prepared.request_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const result = await executor.authorize({
      prepared,
      request_fingerprint: prepared.request_fingerprint,
      authorization_state: prepared.authorization_state,
      consented_source_account_ref: prepared.source_account_ref,
      consent_token: "one-time-consent-token",
      idempotency_key: "payment-123",
    });
    expect(result).toEqual({
      schema_version: "cashloom.open-banking-payment-submission/1",
      provider: "yapily-connect",
      execution_id: "execution-1",
      intent_hash: INTENT_HASH,
      outcome: "pending",
      state: "authorization_returned",
      provider_payment_id: "provider-payment-1",
      provider_status: "AUTHORIZED",
      idempotency_key: "payment-123",
      submitted_at: CLOCK.toISOString(),
      safe_to_retry: false,
    });
    expect(refs).toEqual(["YAPILY_APPLICATION_ID", "YAPILY_APPLICATION_SECRET"]);
    expect(calls[0]).toMatchObject({
      origin: "https://api.yapily.com",
      path: "/payments",
      method: "POST",
    });
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      paymentIdempotencyId: "payment-123",
      institutionId: "bank-of-test",
      type: "DOMESTIC_SINGLE_PAYMENT",
      amount: { amount: 123.45, currency: "GBP" },
      reference: "CASHLOOM-123",
    });
    expect(JSON.stringify(result)).not.toContain("consent-token");
  });

  test("refuses state, fingerprint, prepared-body, and idempotency substitution before network", async () => {
    let calls = 0;
    const executor = createYapilyConnectExecutor({
      resolve_credential: () => "credential",
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      http: { request: async <T>() => { calls += 1; return {} as T; } },
    });
    const prepared = executor.prepare(payment());
    const common = {
      prepared,
      request_fingerprint: prepared.request_fingerprint,
      authorization_state: prepared.authorization_state,
      consented_source_account_ref: prepared.source_account_ref,
      consent_token: "one-time-consent-token",
      idempotency_key: "payment-123",
    };
    await expect(executor.authorize({ ...common, authorization_state: "state-2" }))
      .rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });
    await expect(executor.authorize({
      ...common,
      request_fingerprint: `sha256:${"b".repeat(64)}` as Sha256Digest,
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });
    await expect(executor.authorize({
      ...common,
      prepared: { ...prepared, amount_minor: "1" },
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });
    await expect(executor.authorize({
      ...common,
      consented_source_account_ref: "another-bank-account",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });
    await expect(executor.authorize({
      ...common,
      idempotency_key: "another-valid-key",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });
    await expect(executor.authorize({
      ...common,
      idempotency_key: "x".repeat(41),
    })).rejects.toMatchObject({ code: "OPEN_BANKING_INVALID_REQUEST" });
    expect(calls).toBe(0);
  });

  test("returns secret-free ambiguity after a timeout that may follow acceptance", async () => {
    const canary = "SECRET_CANARY_provider_accepted_before_timeout";
    const timeoutHttp: FixedJsonHttp = {
      async request() {
        const error = stableOpenBankingError("OPEN_BANKING_TIMEOUT");
        (error as Error & { upstream?: string }).upstream = canary;
        throw error;
      },
    };
    const executor = createYapilyConnectExecutor({
      resolve_credential: () => canary,
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      http: timeoutHttp,
    });
    const prepared = executor.prepare(payment());
    const result = await executor.authorize({
      prepared,
      request_fingerprint: prepared.request_fingerprint,
      authorization_state: prepared.authorization_state,
      consented_source_account_ref: prepared.source_account_ref,
      consent_token: canary.repeat(2),
      idempotency_key: "payment-123",
    });
    expect(result).toMatchObject({
      outcome: "ambiguous",
      state: "ambiguous",
      provider_payment_id: null,
      safe_to_retry: false,
      idempotency_key: "payment-123",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  test("also fail-closes 5xx or malformed success responses as ambiguous", async () => {
    for (const code of [
      "OPEN_BANKING_PROVIDER_UNAVAILABLE",
      "OPEN_BANKING_PROVIDER_MALFORMED",
      "OPEN_BANKING_RESPONSE_TOO_LARGE",
      "OPEN_BANKING_PROVIDER_CONFLICT",
    ] as const) {
      const executor = createYapilyConnectExecutor({
        resolve_credential: () => "credential",
        date_now: () => CLOCK,
        authorization_state: () => "state-1",
        http: { request: async () => { throw stableOpenBankingError(code); } },
      });
      const prepared = executor.prepare(payment());
      await expect(executor.authorize({
        prepared,
        request_fingerprint: prepared.request_fingerprint,
        authorization_state: prepared.authorization_state,
        consented_source_account_ref: prepared.source_account_ref,
        consent_token: "one-time-consent-token",
        idempotency_key: prepared.idempotency_key,
      })).resolves.toMatchObject({
        outcome: "ambiguous",
        state: "ambiguous",
        safe_to_retry: false,
      });
    }
    const malformed = createYapilyConnectExecutor({
      resolve_credential: () => "credential",
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      http: { request: async <T>() => ({ data: { status: "PENDING" } }) as T },
    });
    const prepared = malformed.prepare(payment());
    await expect(malformed.authorize({
      prepared,
      request_fingerprint: prepared.request_fingerprint,
      authorization_state: prepared.authorization_state,
      consented_source_account_ref: prepared.source_account_ref,
      consent_token: "one-time-consent-token",
      idempotency_key: prepared.idempotency_key,
    })).resolves.toMatchObject({
      outcome: "ambiguous",
      provider_payment_id: null,
      safe_to_retry: false,
    });
  });

  test("does not expose provider bodies or credentials in fixed errors", async () => {
    const canary = "SECRET_CANARY_provider_body";
    const executor = createYapilyConnectExecutor({
      resolve_credential: () => canary,
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      fetch: (async () => new Response(JSON.stringify({ error: canary }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });
    const prepared = executor.prepare(payment());
    try {
      await executor.authorize({
        prepared,
        request_fingerprint: prepared.request_fingerprint,
        authorization_state: prepared.authorization_state,
        consented_source_account_ref: prepared.source_account_ref,
        consent_token: "one-time-consent-token",
        idempotency_key: "payment-123",
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "OPEN_BANKING_FORBIDDEN" });
      expect(String(error)).not.toContain(canary);
    }
  });

  test("never treats a terminal-looking POST response as settlement truth", async () => {
    const executor = createYapilyConnectExecutor({
      resolve_credential: () => "credential",
      date_now: () => CLOCK,
      authorization_state: () => "state-1",
      http: { request: async <T>() => ({ data: { id: "provider-payment-1", status: "COMPLETED" } }) as T },
    });
    const prepared = executor.prepare(payment());
    await expect(executor.authorize({
      prepared,
      request_fingerprint: prepared.request_fingerprint,
      authorization_state: prepared.authorization_state,
      consented_source_account_ref: prepared.source_account_ref,
      consent_token: "one-time-consent-token",
      idempotency_key: prepared.idempotency_key,
    })).resolves.toMatchObject({ outcome: "pending", state: "submitted", safe_to_retry: false });
  });
});
