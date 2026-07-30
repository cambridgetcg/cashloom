import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "cashloom-stripe-checkout-migration-"));
process.env.CASHLOOM_DATA_DIR = dataDir;
const databasePath = join(dataDir, "sovereign.db");

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";

const legacy = new Database(databasePath, { create: true });
legacy.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY,
  rail                TEXT NOT NULL,
  connector_type      TEXT,
  display_name        TEXT NOT NULL,
  currency            TEXT NOT NULL,
  decimals            INTEGER NOT NULL,
  balance_minor       TEXT NOT NULL DEFAULT '0',
  balance_as_of       TEXT,
  external_account_id TEXT,
  credential_ref      TEXT,
  vault_key_id        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  rail         TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  asset        TEXT NOT NULL,
  amount_minor TEXT NOT NULL,
  fee_minor    TEXT,
  status       TEXT NOT NULL,
  tx_hash      TEXT,
  error        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT
);
INSERT INTO accounts
  (id, rail, display_name, currency, decimals, external_account_id,
   credential_ref, balance_minor)
VALUES
  ('${ACCOUNT_ID}', 'STRIPE', 'legacy Stripe seller', 'USD', 2,
   'acct_LEGACYSELLER000001', 'STRIPE_RESTRICTED_KEY', '98765');
`);
legacy.close();

const { db } = await import("../db.ts");
const { createStripeSandboxCheckout } = await import("./stripe-checkout.ts");

describe("Stripe Checkout sandbox migration", () => {
  it("adds isolated operation and webhook tables without rewriting existing Stripe data", async () => {
    const operationColumns = new Set(
      (
        db.query("PRAGMA table_info(stripe_checkout_operations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const name of [
      "id",
      "intent_id",
      "account_id",
      "connected_account_id",
      "currency",
      "amount_minor",
      "idempotency_key",
      "request_sha256",
      "status",
      "checkout_session_id",
      "payment_intent_id",
      "livemode",
    ]) {
      expect(operationColumns.has(name), name).toBe(true);
    }
    const webhookColumns = new Set(
      (
        db.query("PRAGMA table_info(stripe_webhook_inbox)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const name of [
      "event_id",
      "payload_sha256",
      "operation_id",
      "connected_account_id",
      "event_type",
      "disposition",
      "received_at",
    ]) {
      expect(webhookColumns.has(name), name).toBe(true);
    }

    expect(
      db.query(
        `SELECT display_name, balance_minor, credential_ref
         FROM accounts WHERE id = ?`,
      ).get(ACCOUNT_ID),
    ).toEqual({
      display_name: "legacy Stripe seller",
      balance_minor: "98765",
      credential_ref: "STRIPE_RESTRICTED_KEY",
    });

    const operation = await createStripeSandboxCheckout(
      {
        intentId: INTENT_ID,
        accountId: ACCOUNT_ID,
        amountMinor: "2500",
        purpose: "Migration fixture",
      },
      {
        returnBaseUrl: "https://cashloom.invalid",
        now: () => new Date("2026-07-30T09:00:00.000Z"),
        transport: {
          async createDirectCheckout(request) {
            const id = `cs_test_${INTENT_ID.replaceAll("-", "")}`;
            return {
              id,
              object: "checkout.session",
              url: `https://checkout.stripe.com/c/pay/${id}`,
              livemode: false,
              client_reference_id: INTENT_ID,
              currency: "usd",
              amount_total: 2500,
              payment_intent: null,
              metadata: {
                cashloom_intent_id: request.form["metadata[cashloom_intent_id]"]!,
              },
            };
          },
        },
      },
    );
    expect(operation.status).toBe("submitted");
    expect(operation.connectedAccountId).toBe("acct_LEGACYSELLER000001");
    expect(
      (db.query("SELECT COUNT(*) AS count FROM payments").get() as { count: number })
        .count,
    ).toBe(0);
  });
});
