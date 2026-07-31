import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sha256Id } from "@agenttool/wallet";
import type {
  BitcoinPayLinkExecutionService,
  ConfirmBitcoinPayLinkExecutionInput,
  PrepareBitcoinPayLinkExecutionInput,
} from "./bitcoin-pay-link.ts";

// bitcoin-pay-link-router imports the service error class, whose module graph
// reaches the process-global database. Keep even this route-only test away
// from a real CashLoom home before dynamically loading that graph.
process.env.CASHLOOM_DATA_DIR = mkdtempSync(
  join(tmpdir(), "cashloom-btc-pay-link-router-"),
);

const { BitcoinPayLinkExecutionError } = await import(
  "./bitcoin-pay-link.ts"
);
const { mountBitcoinPayLinkExecutionRoutes } = await import(
  "./bitcoin-pay-link-router.ts"
);

const INTENT_ID = sha256Id({ router: "intent" });
const REQUEST_ID = sha256Id({ router: "request" });
const MERCHANT_ID = sha256Id({ router: "merchant" });
const REVIEW_ID = sha256Id({ router: "review" });
const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const REVIEW = Object.freeze({
  review_id: REVIEW_ID,
  payment_id: PAYMENT_ID,
  intent_record_id: INTENT_ID,
  request_record_id: REQUEST_ID,
  merchant_key_id: MERCHANT_ID,
  network: "Bitcoin mainnet" as const,
  account_id: ACCOUNT_ID,
  account_label: "local BTC",
  source_address: "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5",
  destination: "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty",
  asset: "BTC" as const,
  amount_sats: "25000",
  fee_sats: "100",
  total_sats: "25100",
  max_fee_sats: "500",
  quote_expires_at: "2030-01-01T00:05:00.000Z",
  intent_expires_at: "2030-01-01T00:10:00.000Z",
  confirm_before: "2030-01-01T00:05:00.000Z",
  fee_is_exact: true as const,
  cashloom_fee_sats: "0" as const,
  no_money_moved: true as const,
  transaction_not_signed: true as const,
});

interface StubState {
  readonly prepares: PrepareBitcoinPayLinkExecutionInput[];
  readonly confirms: ConfirmBitcoinPayLinkExecutionInput[];
  readonly statuses: ConfirmBitcoinPayLinkExecutionInput[];
}

function stubService(options: {
  readonly prepareError?: Error;
  readonly confirmError?: Error;
} = {}): {
  readonly service: BitcoinPayLinkExecutionService;
  readonly state: StubState;
} {
  const state: StubState = { prepares: [], confirms: [], statuses: [] };
  const service: BitcoinPayLinkExecutionService = Object.freeze({
    async prepare(input) {
      state.prepares.push(input);
      if (options.prepareError) throw options.prepareError;
      return Object.freeze({ review: REVIEW, reused: false });
    },
    async confirm(input) {
      state.confirms.push(input);
      if (options.confirmError) throw options.confirmError;
      return Object.freeze({
        payment_id: input.payment_id,
        review_id: REVIEW_ID,
        status: "broadcast" as const,
        tx_hash: "a".repeat(64),
        error: null,
      });
    },
    status(input) {
      state.statuses.push(input);
      return Object.freeze({
        payment_id: input.payment_id,
        review_id: REVIEW_ID,
        intent_record_id: INTENT_ID,
        status: "awaiting_confirmation" as const,
        can_confirm: true,
        tx_hash: null,
        error: null,
      });
    },
  });
  return { service, state };
}

function gatedApp(service: BitcoinPayLinkExecutionService): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer local-session") {
      return c.json({ error: "locked" }, 401);
    }
    await next();
  });
  mountBitcoinPayLinkExecutionRoutes(app, { service: () => service });
  return app;
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  unlocked = true,
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(unlocked
        ? { authorization: "Bearer local-session" }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Bitcoin Pay Link execution HTTP router", () => {
  it("composes behind the session gate and adds no-store to successful replies", async () => {
    const stub = stubService();
    const app = gatedApp(stub.service);
    const prepareBody = {
      intent_record_id: INTENT_ID,
      account_id: ACCOUNT_ID,
    };

    const locked = await post(
      app,
      "/api/v2/pay-links/executions/prepare",
      prepareBody,
      false,
    );
    expect(locked.status).toBe(401);
    expect(await locked.json()).toEqual({ error: "locked" });
    expect(stub.state.prepares).toHaveLength(0);

    const prepared = await post(
      app,
      "/api/v2/pay-links/executions/prepare",
      prepareBody,
    );
    expect(prepared.status).toBe(200);
    expect(prepared.headers.get("cache-control")).toBe("no-store");
    expect(await prepared.json()).toEqual({ review: REVIEW, reused: false });
    expect(stub.state.prepares).toEqual([prepareBody]);

    const confirmBody = {
      payment_id: PAYMENT_ID,
      review_id: REVIEW_ID,
    };
    const confirmed = await post(
      app,
      "/api/v2/pay-links/executions/confirm",
      confirmBody,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(await confirmed.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      review_id: REVIEW_ID,
      status: "broadcast",
    });
    expect(stub.state.confirms).toEqual([confirmBody]);

    const status = await post(
      app,
      "/api/v2/pay-links/executions/status",
      confirmBody,
    );
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      review_id: REVIEW_ID,
      intent_record_id: INTENT_ID,
      status: "awaiting_confirmation",
      can_confirm: true,
    });
    expect(stub.state.statuses).toEqual([confirmBody]);
  });

  it("strictly refuses caller-supplied terms, extra fields, and malformed IDs", async () => {
    const stub = stubService();
    const app = gatedApp(stub.service);
    const cases: Array<{ path: string; body: unknown }> = [
      {
        path: "/api/v2/pay-links/executions/prepare",
        body: {
          intent_record_id: INTENT_ID,
          account_id: ACCOUNT_ID,
          destination: REVIEW.destination,
          amount_sats: REVIEW.amount_sats,
          max_fee_sats: REVIEW.max_fee_sats,
        },
      },
      {
        path: "/api/v2/pay-links/executions/prepare",
        body: { intent_record_id: "sha256:nope", account_id: ACCOUNT_ID },
      },
      {
        path: "/api/v2/pay-links/executions/confirm",
        body: {
          payment_id: PAYMENT_ID,
          review_id: REVIEW_ID,
          intent_record_id: INTENT_ID,
        },
      },
      {
        path: "/api/v2/pay-links/executions/confirm",
        body: { payment_id: "not-a-uuid", review_id: REVIEW_ID },
      },
      {
        path: "/api/v2/pay-links/executions/status",
        body: {
          payment_id: PAYMENT_ID,
          review_id: REVIEW_ID,
          broadcast: true,
        },
      },
    ];

    for (const selected of cases) {
      const response = await post(app, selected.path, selected.body);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "invalid_execution_command",
        message: "The Pay Link execution command has invalid or extra fields.",
      });
    }
    expect(stub.state.prepares).toHaveLength(0);
    expect(stub.state.confirms).toHaveLength(0);
    expect(stub.state.statuses).toHaveLength(0);
  });

  it("bounds JSON commands and does not echo unexpected internal errors", async () => {
    const stub = stubService();
    const app = gatedApp(stub.service);
    const wrongMedia = await app.request(
      "/api/v2/pay-links/executions/prepare",
      {
        method: "POST",
        headers: {
          authorization: "Bearer local-session",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          intent_record_id: INTENT_ID,
          account_id: ACCOUNT_ID,
        }),
      },
    );
    expect(wrongMedia.status).toBe(415);
    expect(wrongMedia.headers.get("cache-control")).toBe("no-store");
    expect(await wrongMedia.json()).toEqual({
      error: "unsupported_media_type",
      message: "Local v2 commands require application/json.",
    });

    const oversized = await post(
      app,
      "/api/v2/pay-links/executions/prepare",
      { padding: "x".repeat(5_000) },
    );
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(await oversized.json()).toEqual({
      error: "body_too_large",
      message: "Request body exceeds 4096 bytes.",
    });
    expect(stub.state.prepares).toHaveLength(0);

    const internal = stubService({
      prepareError: new Error(
        "sensitive adapter diagnostic: upstream token and RPC body",
      ),
    });
    const refused = await post(
      gatedApp(internal.service),
      "/api/v2/pay-links/executions/prepare",
      { intent_record_id: INTENT_ID, account_id: ACCOUNT_ID },
    );
    expect(refused.status).toBe(500);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    const problem = await refused.json() as {
      error: string;
      message: string;
    };
    expect(problem).toEqual({
      error: "bitcoin_execution_refused",
      message:
        "The sovereign node could not complete the exact Bitcoin payment. Inspect its local payment state; do not retry an uncertain confirmation.",
    });
    expect(JSON.stringify(problem)).not.toContain("sensitive adapter diagnostic");
  });

  it("maps execution refusals without caching or leaking alternate terms", async () => {
    const stub = stubService({
      prepareError: new BitcoinPayLinkExecutionError(
        "INTENT_NOT_LOCALLY_AUTHORED",
        "Only a local payer intent may execute.",
      ),
    });
    const response = await post(
      gatedApp(stub.service),
      "/api/v2/pay-links/executions/prepare",
      { intent_record_id: INTENT_ID, account_id: ACCOUNT_ID },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "intent_not_locally_authored",
      message: "Only a local payer intent may execute.",
    });
    expect(stub.state.prepares).toHaveLength(1);
  });
});
