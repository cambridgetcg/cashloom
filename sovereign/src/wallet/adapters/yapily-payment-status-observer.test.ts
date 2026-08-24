import { describe, expect, test } from "bun:test";
import type { FixedJsonRequest } from "../open-banking/http.ts";
import { createYapilyPaymentStatusObserver } from "./yapily-payment-status-observer.ts";

describe("Yapily payment status observer", () => {
  test("keeps authorization return nonterminal and maps actual completion separately", async () => {
    const responses = [
      { data: { id: "payment-1", statusDetails: { status: "AUTHORIZED", isoStatus: { code: "ACCP" } } } },
      { data: { id: "payment-1", statusDetails: { status: "COMPLETED", isoStatus: { code: "ACSC" } } } },
    ];
    const calls: string[] = [];
    const observer = createYapilyPaymentStatusObserver({
      resolve_credential: (ref) => ref === "YAPILY_APPLICATION_ID" ? "app" : "secret",
      date_now: () => new Date("2026-08-24T12:00:00.000Z"),
      http: {
        async request<T>(request: FixedJsonRequest) {
          calls.push(request.path);
          return responses.shift()! as T;
        },
      },
    });
    const returned = await observer.status({
      execution_id: "execution-1",
      provider_payment_id: "payment-1",
    });
    expect(returned).toMatchObject({
      state: "authorization_returned",
      provider_status: "AUTHORIZED",
      iso_status_code: "ACCP",
      terminal: false,
    });
    const settled = await observer.status({
      execution_id: "execution-1",
      provider_payment_id: "payment-1",
    });
    expect(settled).toMatchObject({
      state: "settled",
      provider_status: "COMPLETED",
      iso_status_code: "ACSC",
      terminal: true,
    });
    expect(calls).toEqual([
      "/payments/payment-1/details",
      "/payments/payment-1/details",
    ]);
  });

  test("rejects provider payment substitution and unknown statuses", async () => {
    const mismatch = createYapilyPaymentStatusObserver({
      resolve_credential: () => "credential",
      http: {
        request: async <T>() => ({ data: { id: "payment-2", status: "PENDING" } }) as T,
      },
    });
    await expect(mismatch.status({
      execution_id: "execution-1",
      provider_payment_id: "payment-1",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_BINDING_MISMATCH" });

    const unknown = createYapilyPaymentStatusObserver({
      resolve_credential: () => "credential",
      http: {
        request: async <T>() => ({ data: { id: "payment-1", status: "MAGIC" } }) as T,
      },
    });
    await expect(unknown.status({
      execution_id: "execution-1",
      provider_payment_id: "payment-1",
    })).rejects.toMatchObject({ code: "OPEN_BANKING_PROVIDER_MALFORMED" });
  });
});
