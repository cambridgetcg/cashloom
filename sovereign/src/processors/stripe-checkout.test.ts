import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(
  join(tmpdir(), "cashloom-stripe-checkout-test-"),
);
process.env.CASHLOOM_DATA_DIR = dataDir;

const { db, newId } = await import("../db.ts");
const {
  createStripeSandboxCheckout,
  getStripeCheckoutOperation,
  ingestStripeSandboxWebhook,
} = await import("./stripe-checkout.ts");
import type {
  PrepareStripeCheckout,
  StripeCheckoutTransport,
  StripeDirectCheckoutRequest,
  StripeDirectCheckoutResponse,
} from "./stripe-checkout.ts";

const NOW = new Date("2026-07-30T09:00:00.000Z");
const ENDPOINT_SECRET = "whsec_FAKE_SANDBOX_ONLY";
const RETURN_BASE_URL = "https://cashloom.invalid";
const webhookWorkerPath = join(import.meta.dir, "stripe-webhook.worker.ts");

const createAccount = (
  connectedAccountId = `acct_${crypto.randomUUID().replaceAll("-", "")}`,
  decimals = 2,
  currency = "USD",
): string => {
  const accountId = newId();
  db.query(
    `INSERT INTO accounts
       (id, rail, display_name, currency, decimals, external_account_id)
     VALUES (?, 'STRIPE', 'sandbox seller', ?, ?, ?)`,
  ).run(accountId, currency, decimals, connectedAccountId);
  return accountId;
};

const inputFor = (
  accountId: string,
  overrides: Partial<PrepareStripeCheckout> = {},
): PrepareStripeCheckout => ({
  intentId: newId(),
  accountId,
  amountMinor: "1250",
  purpose: "KINGDOM field guide",
  ...overrides,
});

const responseFor = (
  request: StripeDirectCheckoutRequest,
  overrides: Partial<StripeDirectCheckoutResponse> = {},
): StripeDirectCheckoutResponse => {
  const id = `cs_test_${request.form.client_reference_id!.replaceAll("-", "")}`;
  return {
    id,
    object: "checkout.session",
    url: `https://checkout.stripe.com/c/pay/${id}`,
    livemode: false,
    client_reference_id: request.form.client_reference_id!,
    currency: request.form["line_items[0][price_data][currency]"]!,
    amount_total: Number(request.form["line_items[0][price_data][unit_amount]"]),
    payment_intent: null,
    metadata: {
      cashloom_intent_id: request.form["metadata[cashloom_intent_id]"]!,
    },
    ...overrides,
  };
};

const signatureFor = (raw: string, timestamp = Math.floor(NOW.getTime() / 1000)) => {
  const value = createHmac("sha256", ENDPOINT_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  return { timestamp, header: `t=${timestamp},v1=${value}` };
};

const checkoutEvent = (options: {
  eventId?: string;
  type?: "checkout.session.completed" | "checkout.session.expired";
  account: string;
  intentId: string;
  sessionId: string;
  amountTotal?: number;
  currency?: string;
  paymentStatus?: string;
  paymentIntent?: string | null;
  metadataIntentId?: string | null;
}) => ({
  id: options.eventId ?? `evt_${crypto.randomUUID().replaceAll("-", "")}`,
  object: "event",
  livemode: false,
  type: options.type ?? "checkout.session.completed",
  account: options.account,
  data: {
    object: {
      id: options.sessionId,
      object: "checkout.session",
      client_reference_id: options.intentId,
      amount_total: options.amountTotal ?? 1250,
      currency: options.currency ?? "usd",
      payment_status: options.paymentStatus ?? "paid",
      payment_intent:
        options.paymentIntent === undefined
          ? "pi_FAKEPAYMENTDEFAULT00001"
          : options.paymentIntent,
      metadata:
        options.metadataIntentId === null
          ? {}
          : {
              cashloom_intent_id:
                options.metadataIntentId ?? options.intentId,
            },
    },
  },
});

describe("Stripe Connect hosted Checkout sandbox", () => {
  it("commits exact account-scoped idempotency before one injected provider call", async () => {
    const accountId = createAccount("acct_FAKESELLER00000001");
    const input = inputFor(accountId);
    const calls: StripeDirectCheckoutRequest[] = [];
    const transport: StripeCheckoutTransport = {
      async createDirectCheckout(request) {
        calls.push(request);
        const row = db
          .query(
            `SELECT status, checkout_session_id
             FROM stripe_checkout_operations WHERE intent_id = ?`,
          )
          .get(input.intentId) as {
          status: string;
          checkout_session_id: string | null;
        };
        expect(row).toEqual({ status: "submitting", checkout_session_id: null });
        return responseFor(request);
      },
    };

    const operation = await createStripeSandboxCheckout(input, {
      transport,
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
    });

    expect(operation).toMatchObject({
      intentId: input.intentId,
      status: "submitted",
      connectedAccountId: "acct_FAKESELLER00000001",
      amountMinor: "1250",
      cashloomFeeMinor: "0",
      providerFeeMinor: null,
      providerFeeStatus: "unknown_until_provider_reconciliation",
      settlement: "webhook_observed",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/checkout/sessions",
      connectedAccountId: "acct_FAKESELLER00000001",
    });
    expect(calls[0]!.idempotencyKey).toMatch(/^cashloom-checkout-v1-[0-9a-f]{64}$/);
    expect(calls[0]!.form).toEqual({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": input.purpose,
      "line_items[0][price_data][unit_amount]": "1250",
      "line_items[0][quantity]": "1",
      client_reference_id: input.intentId,
      "metadata[cashloom_intent_id]": input.intentId,
      "payment_intent_data[metadata][cashloom_intent_id]": input.intentId,
      success_url:
        "https://cashloom.invalid/pay/stripe/return?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://cashloom.invalid/pay/stripe/cancel",
    });
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("application_fee");
    expect(serialized).not.toContain("transfer_data");
    expect(serialized).not.toContain("secret");
  });

  it("returns an identical intent without resubmission and refuses changed parameters", async () => {
    const accountId = createAccount();
    const input = inputFor(accountId);
    let calls = 0;
    const transport: StripeCheckoutTransport = {
      async createDirectCheckout(request) {
        calls += 1;
        return responseFor(request);
      },
    };
    const runtime = { transport, returnBaseUrl: RETURN_BASE_URL, now: () => NOW };

    const first = await createStripeSandboxCheckout(input, runtime);
    const second = await createStripeSandboxCheckout(input, runtime);
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    await expect(
      createStripeSandboxCheckout({ ...input, amountMinor: "1251" }, runtime),
    ).rejects.toThrow(/different request/);
    expect(calls).toBe(1);
  });

  it("binds one intent to one local account and refuses a mis-scaled account", async () => {
    const connectedAccountId = "acct_FAKEALIASEDSELLER001";
    const firstAccountId = createAccount(connectedAccountId);
    const aliasedAccountId = createAccount(connectedAccountId);
    const input = inputFor(firstAccountId);
    let calls = 0;
    const runtime = {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request: StripeDirectCheckoutRequest) {
          calls += 1;
          return responseFor(request);
        },
      },
    };

    await createStripeSandboxCheckout(input, runtime);
    await expect(
      createStripeSandboxCheckout(
        { ...input, accountId: aliasedAccountId },
        runtime,
      ),
    ).rejects.toThrow(/different request/);
    expect(calls).toBe(1);

    const misScaledAccountId = createAccount(
      "acct_FAKEMISSCALEDSELLER1",
      0,
      "USD",
    );
    await expect(
      createStripeSandboxCheckout(inputFor(misScaledAccountId), runtime),
    ).rejects.toThrow(/Stripe requires 2.*mis-scale/);
    expect(calls).toBe(1);
  });

  it("lets one concurrent caller submit and returns the durable in-flight state to the other", async () => {
    const accountId = createAccount();
    const input = inputFor(accountId);
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: StripeCheckoutTransport = {
      async createDirectCheckout(request) {
        calls += 1;
        await blocked;
        return responseFor(request);
      },
    };
    const runtime = { transport, returnBaseUrl: RETURN_BASE_URL, now: () => NOW };

    const first = createStripeSandboxCheckout(input, runtime);
    while (calls === 0) await Promise.resolve();
    const second = await createStripeSandboxCheckout(input, runtime);
    expect(second.status).toBe("submitting");
    expect(second.checkoutSessionId).toBeNull();
    expect(calls).toBe(1);
    release();
    expect((await first).status).toBe("submitted");
  });

  it("keeps transport failures and live or mismatched responses sticky without leaking errors", async () => {
    const accountId = createAccount();
    const fakeSecret = "sk_test_FAKE_SHOULD_NEVER_ESCAPE";
    const input = inputFor(accountId);
    let calls = 0;
    const transport: StripeCheckoutTransport = {
      async createDirectCheckout() {
        calls += 1;
        throw new Error(`axios config Authorization: Bearer ${fakeSecret}`);
      },
    };
    const runtime = { transport, returnBaseUrl: RETURN_BASE_URL, now: () => NOW };
    const unknown = await createStripeSandboxCheckout(input, runtime);
    expect(unknown.status).toBe("submission_unknown");
    expect(unknown.errorCode).toBe("transport_outcome_unknown");
    expect(JSON.stringify(unknown)).not.toContain(fakeSecret);
    expect(
      JSON.stringify(
        db.query(
          "SELECT request_json, error_code FROM stripe_checkout_operations WHERE id = ?",
        ).get(unknown.operationId),
      ),
    ).not.toContain(fakeSecret);
    expect((await createStripeSandboxCheckout(input, runtime)).status).toBe(
      "submission_unknown",
    );
    expect(calls).toBe(1);

    for (const override of [
      { livemode: true },
      { client_reference_id: newId() },
      { amount_total: 1251 },
      { currency: "eur" },
      { id: "cs_live_FAKE000000000001" },
      { metadata: { cashloom_intent_id: newId() } },
    ] satisfies Array<Partial<StripeDirectCheckoutResponse>>) {
      const nextInput = inputFor(accountId);
      const result = await createStripeSandboxCheckout(nextInput, {
        returnBaseUrl: RETURN_BASE_URL,
        now: () => NOW,
        transport: {
          async createDirectCheckout(request) {
            return responseFor(request, override);
          },
        },
      });
      expect(result.status).toBe("submission_unknown");
      expect(result.errorCode).toBe("provider_response_mismatch");
    }
  });

  it("authenticates raw webhook bytes, deduplicates events, and never downgrades paid", async () => {
    const connectedAccountId = "acct_FAKESELLER00000002";
    const accountId = createAccount(connectedAccountId);
    const input = inputFor(accountId);
    const operation = await createStripeSandboxCheckout(input, {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request) {
          return responseFor(request, {
            payment_intent: "pi_FAKEPAYMENT000000001",
          });
        },
      },
    });
    const paidEvent = checkoutEvent({
      account: connectedAccountId,
      intentId: input.intentId,
      sessionId: operation.checkoutSessionId!,
      paymentIntent: "pi_FAKEPAYMENT000000001",
    });
    const raw = JSON.stringify(paidEvent);
    const valid = signatureFor(raw);

    const paid = ingestStripeSandboxWebhook(
      {
        rawBody: raw,
        signatureHeader: `t=${valid.timestamp},v1=${"0".repeat(64)},v1=${valid.header.split("v1=")[1]}`,
        endpointSecret: ENDPOINT_SECRET,
      },
      { now: () => NOW },
    );
    expect(paid).toMatchObject({
      duplicate: false,
      disposition: "applied",
      operationId: operation.operationId,
      status: "provider_reported_paid",
    });

    const duplicate = ingestStripeSandboxWebhook(
      {
        rawBody: raw,
        signatureHeader: valid.header,
        endpointSecret: ENDPOINT_SECRET,
      },
      { now: () => NOW },
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.status).toBe("provider_reported_paid");

    const altered = JSON.stringify({
      ...paidEvent,
      data: {
        object: { ...paidEvent.data.object, amount_total: 999 },
      },
    });
    expect(() =>
      ingestStripeSandboxWebhook(
        {
          rawBody: altered,
          signatureHeader: signatureFor(altered).header,
          endpointSecret: ENDPOINT_SECRET,
        },
        { now: () => NOW },
      ),
    ).toThrow(/different bytes/);

    const expired = JSON.stringify(
      checkoutEvent({
        eventId: "evt_FAKEEXPIRED000000001",
        type: "checkout.session.expired",
        account: connectedAccountId,
        intentId: input.intentId,
        sessionId: operation.checkoutSessionId!,
        paymentIntent: "pi_FAKEPAYMENT000000001",
      }),
    );
    const expiredResult = ingestStripeSandboxWebhook(
      {
        rawBody: expired,
        signatureHeader: signatureFor(expired).header,
        endpointSecret: ENDPOINT_SECRET,
      },
      { now: () => NOW },
    );
    expect(expiredResult.status).toBe("provider_reported_paid");

    const inbox = db
      .query(
        `SELECT event_id, payload_sha256, disposition
         FROM stripe_webhook_inbox WHERE operation_id = ? ORDER BY event_id`,
      )
      .all(operation.operationId);
    expect(JSON.stringify(inbox)).not.toContain(input.purpose);
    expect(JSON.stringify(inbox)).not.toContain(raw);
  });

  it("records authenticated binding mismatches without moving operation state", async () => {
    const accountId = createAccount("acct_FAKESELLER00000003");
    const input = inputFor(accountId);
    const operation = await createStripeSandboxCheckout(input, {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request) {
          return responseFor(request);
        },
      },
    });
    const mismatch = JSON.stringify(
      checkoutEvent({
        eventId: "evt_FAKEMISMATCH00000001",
        account: "acct_OTHERSELLER00000001",
        intentId: input.intentId,
        sessionId: operation.checkoutSessionId!,
        paymentIntent: null,
      }),
    );
    const result = ingestStripeSandboxWebhook(
      {
        rawBody: mismatch,
        signatureHeader: signatureFor(mismatch).header,
        endpointSecret: ENDPOINT_SECRET,
      },
      { now: () => NOW },
    );
    expect(result.disposition).toBe("refused");
    expect(getStripeCheckoutOperation(operation.operationId)?.status).toBe("submitted");

    const metadataMismatch = JSON.stringify(
      checkoutEvent({
        eventId: "evt_FAKEMETADATA0000001",
        account: "acct_FAKESELLER00000003",
        intentId: input.intentId,
        metadataIntentId: newId(),
        sessionId: operation.checkoutSessionId!,
      }),
    );
    const metadataResult = ingestStripeSandboxWebhook(
      {
        rawBody: metadataMismatch,
        signatureHeader: signatureFor(metadataMismatch).header,
        endpointSecret: ENDPOINT_SECRET,
      },
      { now: () => NOW },
    );
    expect(metadataResult.disposition).toBe("refused");
    expect(getStripeCheckoutOperation(operation.operationId)?.status).toBe("submitted");
  });

  it("accepts a paid webhook racing ahead of the provider response without downgrade", async () => {
    const connectedAccountId = "acct_FAKESELLER00000004";
    const accountId = createAccount(connectedAccountId);
    const input = inputFor(accountId);
    const sessionId = `cs_test_${input.intentId.replaceAll("-", "")}`;

    const operation = await createStripeSandboxCheckout(input, {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request) {
          const event = JSON.stringify(
            checkoutEvent({
              eventId: "evt_FAKERACE000000000001",
              account: connectedAccountId,
              intentId: input.intentId,
              sessionId,
              paymentIntent: "pi_FAKERACE000000000001",
            }),
          );
          const projected = ingestStripeSandboxWebhook(
            {
              rawBody: event,
              signatureHeader: signatureFor(event).header,
              endpointSecret: ENDPOINT_SECRET,
            },
            { now: () => NOW },
          );
          expect(projected.status).toBe("provider_reported_paid");
          return responseFor(request, {
            id: sessionId,
            payment_intent: "pi_FAKERACE000000000001",
          });
        },
      },
    });

    expect(operation.status).toBe("provider_reported_paid");
    expect(operation.checkoutSessionId).toBe(sessionId);
    expect(operation.checkoutUrl).toContain(sessionId);
  });

  it("surfaces a durable conflict when a paid webhook and response bind different provider ids", async () => {
    const connectedAccountId = "acct_FAKESELLER00000006";
    const accountId = createAccount(connectedAccountId);
    const input = inputFor(accountId);
    const webhookSessionId = "cs_test_WEBHOOKBBBBBBBB";
    const webhookPaymentIntentId = "pi_WEBHOOKBBBBBBBB";
    let calls = 0;

    const runtime = {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request: StripeDirectCheckoutRequest) {
          calls += 1;
          const event = JSON.stringify(
            checkoutEvent({
              eventId: "evt_FAKECONFLICT00000001",
              account: connectedAccountId,
              intentId: input.intentId,
              sessionId: webhookSessionId,
              paymentIntent: webhookPaymentIntentId,
            }),
          );
          expect(
            ingestStripeSandboxWebhook(
              {
                rawBody: event,
                signatureHeader: signatureFor(event).header,
                endpointSecret: ENDPOINT_SECRET,
              },
              { now: () => NOW },
            ).status,
          ).toBe("provider_reported_paid");
          return responseFor(request, {
            payment_intent: "pi_RESPONSEAAAAAAAA",
          });
        },
      },
    };

    const operation = await createStripeSandboxCheckout(input, runtime);
    expect(operation).toMatchObject({
      status: "provider_reported_paid",
      checkoutSessionId: webhookSessionId,
      paymentIntentId: webhookPaymentIntentId,
      checkoutUrl: null,
      errorCode: "provider_identity_conflict",
    });
    expect(await createStripeSandboxCheckout(input, runtime)).toEqual(operation);
    expect(calls).toBe(1);
  });

  it("re-reads provider identity inside the projection transaction", async () => {
    const connectedAccountId = "acct_FAKESELLER00000007";
    const accountId = createAccount(connectedAccountId);
    const input = inputFor(accountId);
    const responseSessionId = `cs_test_${input.intentId.replaceAll("-", "")}`;
    const responsePaymentIntentId = "pi_RESPONSEREREAD000001";
    const webhookSessionId = "cs_test_WEBHOOKSTALEREAD01";
    const webhookPaymentIntentId = "pi_WEBHOOKSTALEREAD001";

    const operation = await createStripeSandboxCheckout(input, {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request) {
          const event = JSON.stringify(
            checkoutEvent({
              eventId: "evt_FAKEREADINSIDETX001",
              account: connectedAccountId,
              intentId: input.intentId,
              sessionId: webhookSessionId,
              paymentIntent: webhookPaymentIntentId,
            }),
          );
          const projected = ingestStripeSandboxWebhook(
            {
              rawBody: event,
              signatureHeader: signatureFor(event).header,
              endpointSecret: ENDPOINT_SECRET,
            },
            {
              now: () => NOW,
              beforeProjection: () => {
                const changed = db.query(
                  `UPDATE stripe_checkout_operations
                   SET checkout_session_id = ?, payment_intent_id = ?,
                       status = 'submitted', updated_at = ?
                   WHERE intent_id = ? AND status = 'submitting'`,
                ).run(
                  responseSessionId,
                  responsePaymentIntentId,
                  NOW.toISOString(),
                  input.intentId,
                );
                expect(changed.changes).toBe(1);
              },
            },
          );
          expect(projected).toMatchObject({
            disposition: "refused",
            status: "submitted",
          });
          return responseFor(request, {
            payment_intent: responsePaymentIntentId,
          });
        },
      },
    });

    expect(operation).toMatchObject({
      status: "submitted",
      checkoutSessionId: responseSessionId,
      paymentIntentId: responsePaymentIntentId,
      errorCode: null,
    });
    expect(
      (
        db.query(
          `SELECT disposition FROM stripe_webhook_inbox
           WHERE event_id = 'evt_FAKEREADINSIDETX001'`,
        ).get() as { disposition: string }
      ).disposition,
    ).toBe("refused");
  });

  it("deduplicates one signed event across two sovereign processes", async () => {
    const connectedAccountId = "acct_FAKESELLER00000008";
    const accountId = createAccount(connectedAccountId);
    const input = inputFor(accountId);
    const operation = await createStripeSandboxCheckout(input, {
      returnBaseUrl: RETURN_BASE_URL,
      now: () => NOW,
      transport: {
        async createDirectCheckout(request) {
          return responseFor(request, {
            payment_intent: "pi_CROSSPROCESS0000001",
          });
        },
      },
    });
    const raw = JSON.stringify(
      checkoutEvent({
        eventId: "evt_FAKECROSSPROCESS001",
        account: connectedAccountId,
        intentId: input.intentId,
        sessionId: operation.checkoutSessionId!,
        paymentIntent: "pi_CROSSPROCESS0000001",
      }),
    );
    const signature = signatureFor(raw).header;
    const workers = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, webhookWorkerPath], {
        env: {
          ...process.env,
          CASHLOOM_DATA_DIR: dataDir,
          CASHLOOM_TEST_STRIPE_WEBHOOK_RAW: raw,
          CASHLOOM_TEST_STRIPE_WEBHOOK_SIGNATURE: signature,
          CASHLOOM_TEST_STRIPE_WEBHOOK_SECRET: ENDPOINT_SECRET,
          CASHLOOM_TEST_STRIPE_WEBHOOK_NOW: NOW.toISOString(),
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      workers.map(async (worker) => ({
        status: await worker.exited,
        stdout: await new Response(worker.stdout).text(),
        stderr: await new Response(worker.stderr).text(),
      })),
    );
    expect(
      results.map(({ status }) => status),
      JSON.stringify(results),
    ).toEqual([0, 0]);
    const projections = results.map(({ stdout }) =>
      JSON.parse(stdout) as {
        duplicate: boolean;
        disposition: string;
        status: string;
      },
    );
    expect(projections.map(({ duplicate }) => duplicate).sort()).toEqual([
      false,
      true,
    ]);
    for (const projection of projections) {
      expect(projection.disposition).toBe("applied");
      expect(projection.status).toBe("provider_reported_paid");
    }
  });

  it("rejects stale, malformed, and wrong-secret signatures before persistence", () => {
    const raw = JSON.stringify({
      id: "evt_FAKESIGNATURE0000001",
      object: "event",
      livemode: false,
      type: "ping",
      account: "acct_FAKESELLER00000005",
      data: { object: { id: "obj_FAKE00000001" } },
    });
    const valid = signatureFor(raw);
    const cases = [
      { header: "garbage", secret: ENDPOINT_SECRET, now: NOW },
      { header: valid.header, secret: "whsec_WRONG_FAKE", now: NOW },
      {
        header: signatureFor(raw, valid.timestamp - 301).header,
        secret: ENDPOINT_SECRET,
        now: NOW,
      },
    ];
    for (const item of cases) {
      expect(() =>
        ingestStripeSandboxWebhook(
          {
            rawBody: raw,
            signatureHeader: item.header,
            endpointSecret: item.secret,
          },
          { now: () => item.now },
        ),
      ).toThrow(/signature|timestamp/);
    }
    expect(
      (
        db.query(
          "SELECT COUNT(*) AS count FROM stripe_webhook_inbox WHERE event_id = ?",
        ).get("evt_FAKESIGNATURE0000001") as { count: number }
      ).count,
    ).toBe(0);
  });
});
