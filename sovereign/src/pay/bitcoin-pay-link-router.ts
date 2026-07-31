/**
 * Session-gated HTTP doors for payer-local Pay Link execution.
 *
 * Mounted after the sovereign vault middleware. None of these routes accepts
 * payment terms from the caller: prepare names one local signed intent +
 * account, while confirm and status name one server-derived exact review.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  BitcoinPayLinkExecutionError,
  type BitcoinPayLinkExecutionService,
} from "./bitcoin-pay-link.ts";
import {
  V2RouteError,
  localJson,
} from "../protocol/v2/router.ts";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const EXECUTION_COMMAND_MAX_BYTES = 4 * 1024;

const prepareSchema = z
  .object({
    intent_record_id: z.string().regex(HASH),
    account_id: z.string().uuid(),
  })
  .strict();

const confirmSchema = z
  .object({
    payment_id: z.string().uuid(),
    review_id: z.string().regex(HASH),
  })
  .strict();

export interface BitcoinPayLinkExecutionRouteDependencies {
  readonly service: () => BitcoinPayLinkExecutionService;
}

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store");
}

function executionProblem(c: Context, error: unknown): Response {
  noStore(c);
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: "invalid_execution_command",
        message: "The Pay Link execution command has invalid or extra fields.",
      },
      400,
    );
  }
  if (error instanceof V2RouteError) {
    return c.json(
      {
        error: error.code,
        message: error.message,
      },
      error.status as 400,
    );
  }
  if (error instanceof BitcoinPayLinkExecutionError) {
    const status =
      error.code === "INTENT_NOT_LOCALLY_AUTHORED"
        ? 403
        : error.code === "STORAGE_INTEGRITY_FAILURE"
          ? 500
          : error.code === "WRONG_BITCOIN_PROFILE"
              || error.code === "ASSET_POLICY_REJECTED"
            ? 422
            : 409;
    return c.json(
      {
        error: error.code.toLowerCase(),
        message: error.message,
      },
      status,
    );
  }
  return c.json(
    {
      error: "bitcoin_execution_refused",
      message:
        "The sovereign node could not complete the exact Bitcoin payment. Inspect its local payment state; do not retry an uncertain confirmation.",
    },
    500,
  );
}

export function mountBitcoinPayLinkExecutionRoutes(
  app: Hono,
  dependencies: BitcoinPayLinkExecutionRouteDependencies,
): void {
  app.post("/api/v2/pay-links/executions/prepare", async (c) => {
    try {
      const input = prepareSchema.parse(
        await localJson(c.req.raw, EXECUTION_COMMAND_MAX_BYTES),
      );
      const result = await dependencies.service().prepare(input);
      noStore(c);
      return c.json(result);
    } catch (error) {
      return executionProblem(c, error);
    }
  });

  app.post("/api/v2/pay-links/executions/confirm", async (c) => {
    try {
      const input = confirmSchema.parse(
        await localJson(c.req.raw, EXECUTION_COMMAND_MAX_BYTES),
      );
      const result = await dependencies.service().confirm(input);
      noStore(c);
      return c.json(result);
    } catch (error) {
      return executionProblem(c, error);
    }
  });

  app.post("/api/v2/pay-links/executions/status", async (c) => {
    try {
      const input = confirmSchema.parse(
        await localJson(c.req.raw, EXECUTION_COMMAND_MAX_BYTES),
      );
      const result = dependencies.service().status(input);
      noStore(c);
      return c.json(result);
    } catch (error) {
      return executionProblem(c, error);
    }
  });
}
