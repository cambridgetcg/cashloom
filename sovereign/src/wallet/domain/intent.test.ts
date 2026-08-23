import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  createPaymentIntentV1,
  parsePaymentIntentV1,
  verifyPaymentIntentHash,
  type JsonValue,
} from "./intent";

const body = {
  schema_version: "cashloom.payment-intent/1",
  intent_id: "intent_01J123",
  kind: "transfer",
  source_account: {
    kind: "crypto",
    account_id: "eip155:1:0xAbCDEF0123456789AbcdEF0123456789aBCDEF01",
  },
  destination: {
    kind: "account",
    account: {
      kind: "crypto",
      account_id: "eip155:1:0x1111111111111111111111111111111111111111",
    },
  },
  amount: {
    asset: { kind: "crypto", asset_id: "eip155:1/slip44:60" },
    atomic: "1000000000000000000",
  },
  fee_ceiling: {
    asset: { kind: "crypto", asset_id: "eip155:1/slip44:60" },
    atomic: "5000000000000000",
  },
  created_by: { kind: "human", actor_id: "user_01J" },
  nonce: "nonce_01J123",
  created_at: "2026-08-21T12:00:00.000Z",
  expires_at: "2026-08-21T12:05:00.000Z",
  purpose: "Treasury transfer",
} as const;

describe("canonical payment intents", () => {
  it("canonicalises object keys deterministically", () => {
    expect(canonicalizeJson({ z: 1, a: "money", nested: { y: true, x: null } })).toBe(
      '{"a":"money","nested":{"x":null,"y":true},"z":1}',
    );
    expect(canonicalizeJson(-0)).toBe("0");
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalizeJson("\ud800")).toThrow(/surrogate/);
    const sparse: JsonValue[] = [];
    sparse.length = 1;
    expect(() => canonicalizeJson(sparse)).toThrow(/sparse/);
  });

  it("creates the same hash independent of insertion order", () => {
    const first = createPaymentIntentV1(body);
    const reordered = createPaymentIntentV1({
      purpose: body.purpose,
      expires_at: body.expires_at,
      created_at: body.created_at,
      nonce: body.nonce,
      created_by: body.created_by,
      fee_ceiling: body.fee_ceiling,
      amount: body.amount,
      destination: body.destination,
      source_account: body.source_account,
      kind: body.kind,
      intent_id: body.intent_id,
      schema_version: body.schema_version,
    });
    expect(first.intent_hash).toBe(reordered.intent_hash);
    expect(first.intent_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("detects any post-authorization change", () => {
    const intent = createPaymentIntentV1(body);
    const tampered = {
      ...intent,
      amount: { ...intent.amount, atomic: "1000000000000000001" },
    };
    expect(verifyPaymentIntentHash(intent)).toBe(true);
    expect(verifyPaymentIntentHash(tampered)).toBe(false);
    expect(() => parsePaymentIntentV1(tampered)).toThrow(/hash mismatch/);
  });

  it("rejects non-canonical time, invalid expiry, and wrong-chain assets", () => {
    expect(() => createPaymentIntentV1({ ...body, created_at: "2026-08-21T12:00:00Z" })).toThrow();
    expect(() => createPaymentIntentV1({ ...body, expires_at: body.created_at })).toThrow(/expire after/);
    expect(() =>
      createPaymentIntentV1({
        ...body,
        amount: {
          asset: { kind: "crypto", asset_id: "eip155:8453/slip44:60" },
          atomic: "1",
        },
      }),
    ).toThrow(/source account is on/);
  });

  it("binds direct destinations and fee assets to the source chain", () => {
    expect(() =>
      createPaymentIntentV1({
        ...body,
        destination: {
          kind: "account",
          account: {
            kind: "crypto",
            account_id: "eip155:8453:0x1111111111111111111111111111111111111111",
          },
        },
      }),
    ).toThrow(/use a bridge intent/);

    expect(() =>
      createPaymentIntentV1({
        ...body,
        fee_ceiling: {
          asset: { kind: "crypto", asset_id: "eip155:8453/slip44:60" },
          atomic: "1",
        },
      }),
    ).toThrow(/fee asset is on/);

    expect(() =>
      createPaymentIntentV1({
        ...body,
        destination: {
          kind: "account",
          account: {
            kind: "fiat",
            provider: "bank-test",
            account_ref: "recipient-1",
          },
        },
      }),
    ).toThrow(/on-chain account destination/);
  });

  it("allows an explicitly-labelled bridge to bind a destination on another chain", () => {
    expect(() =>
      createPaymentIntentV1({
        ...body,
        kind: "bridge",
        destination: {
          kind: "account",
          account: {
            kind: "crypto",
            account_id: "eip155:8453:0x1111111111111111111111111111111111111111",
          },
        },
      }),
    ).not.toThrow();
  });
});
