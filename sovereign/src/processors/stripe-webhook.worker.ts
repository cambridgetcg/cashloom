/**
 * Cross-process Stripe webhook test worker.
 *
 * Test fixtures pass only fake sandbox bytes and secrets. The production
 * package script never invokes this module directly.
 */

import { ingestStripeSandboxWebhook } from "./stripe-checkout.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const result = ingestStripeSandboxWebhook(
  {
    rawBody: required("CASHLOOM_TEST_STRIPE_WEBHOOK_RAW"),
    signatureHeader: required("CASHLOOM_TEST_STRIPE_WEBHOOK_SIGNATURE"),
    endpointSecret: required("CASHLOOM_TEST_STRIPE_WEBHOOK_SECRET"),
  },
  {
    now: () => new Date(required("CASHLOOM_TEST_STRIPE_WEBHOOK_NOW")),
  },
);

process.stdout.write(JSON.stringify(result));
