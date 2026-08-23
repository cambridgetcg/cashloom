import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PaymentActivity,
  paymentActivityState,
  paymentCanReconcile,
  paymentHasFinalizedConsensus,
} from "../src/components/PaymentActivity";
import type { PaymentListItem } from "../src/types";

const payment = (overrides: Partial<PaymentListItem> = {}): PaymentListItem => ({
  id: "payment-1",
  account_id: "account-1",
  rail: "evm-base",
  to_addr: `0x${"b".repeat(40)}`,
  asset: "ETH",
  amount_minor: "1000000000000000000",
  fee_minor: "1000",
  status: "broadcast",
  tx_hash: `0x${"a".repeat(64)}`,
  error: null,
  created_at: "2026-08-23T12:00:00.000Z",
  intent_state: "submitted",
  ...overrides,
});

describe("payment activity truth projection", () => {
  test("an absent receipt remains unknown and never becomes a drop", () => {
    const state = paymentActivityState(payment({
      truth: {
        visibility: "NOT_FOUND",
        security_level: "UNSAFE",
        execution_result: null,
      },
    }));
    expect(state.kind).toBe("ambiguous");
    expect(state.label.toLowerCase()).toContain("not found yet");
    expect(`${state.label} ${state.detail}`.toLowerCase()).not.toContain("dropped");
    expect(state.detail).toContain("not proof of a drop");
  });

  test("distinguishes signed, broadcast, pending, finalized, reverted and ambiguous", () => {
    const finalizedConsensus = {
      canonicality: "CANONICAL",
      evidence: { provider_ids: ["base-a", "base-b"], quorum: "2" },
      actions: { reconcile: false },
    } as const;
    expect(paymentActivityState(payment({ status: "confirmed", intent_state: "signed" })).kind).toBe("signed");
    expect(paymentActivityState(payment()).kind).toBe("broadcast");
    expect(paymentActivityState(payment({ truth: { visibility: "MEMPOOL" } })).kind).toBe("pending");
    expect(paymentActivityState(payment({
      truth: {
        ...finalizedConsensus,
        visibility: "INCLUDED",
        security_level: "FINALIZED",
        execution_result: "SUCCESS",
      },
    })).kind).toBe("finalized");
    expect(paymentActivityState(payment({
      truth: {
        ...finalizedConsensus,
        visibility: "INCLUDED",
        security_level: "FINALIZED",
        execution_result: "REVERTED",
      },
    })).kind).toBe("reverted");
    expect(paymentActivityState(payment({
      truth: { canonicality: "REORGED", visibility: "INCLUDED" },
    })).kind).toBe("ambiguous");
  });

  test("only enables explicit reconciliation for a non-terminal Base tx", () => {
    expect(paymentCanReconcile(payment())).toBe(true);
    expect(paymentCanReconcile(payment({ rail: "btc", asset: "BTC" }))).toBe(false);
    expect(paymentCanReconcile(payment({ tx_hash: null }))).toBe(false);
    expect(paymentCanReconcile(payment({ truth: { actions: { reconcile: false } } }))).toBe(false);
    expect(paymentCanReconcile(payment({
      truth: {
        visibility: "INCLUDED",
        security_level: "FINALIZED",
        execution_result: "SUCCESS",
        canonicality: "CANONICAL",
        evidence: { provider_ids: ["base-a", "base-b"], quorum: "2" },
        actions: { reconcile: false },
      },
    }))).toBe(false);
  });

  test("keeps one-provider finalized evidence nonterminal and checkable", () => {
    const partial = payment({
      truth: {
        visibility: "INCLUDED",
        security_level: "FINALIZED",
        execution_result: "SUCCESS",
        canonicality: "UNKNOWN",
        evidence: { provider_ids: ["base-a"], quorum: null },
        actions: { reconcile: true },
      },
    });
    const state = paymentActivityState(partial);
    expect(paymentHasFinalizedConsensus(partial.truth)).toBe(false);
    expect(state.kind).toBe("pending");
    expect(state.label.toLowerCase()).toContain("quorum pending");
    expect(state.detail.toLowerCase()).not.toContain("two providers agree");
    expect(paymentCanReconcile(partial)).toBe(true);
  });

  test("renders exact fee components, raw atomics, timestamps and a busy manual check", () => {
    const html = renderToStaticMarkup(
      <PaymentActivity
        payments={[payment({
          truth: {
            visibility: "INCLUDED",
            security_level: "SAFE",
            execution_result: "SUCCESS",
            checked_at: "2026-08-23T12:01:00.000Z",
            observed_at: "2026-08-23T12:00:30.000Z",
            fee: {
              asset: "eip155:8453/slip44:60",
              l2_execution_atomic: "21000000000000",
              l1_data_security_atomic: "123456789",
              operator_atomic: "0",
              total_atomic: "21000123456789",
              completeness: "exact",
              budget_atomic: "20000000000000",
              budget_exceeded: true,
            },
          },
        })]}
        error={null}
        checkingId="payment-1"
        notice={null}
        onReconcile={() => undefined}
      />,
    );
    expect(html).toContain("Base execution (L2)");
    expect(html).toContain("Ethereum data security (L1)");
    expect(html).toContain("Visibility");
    expect(html).toContain("Security");
    expect(html).toContain("21000123456789 atomic");
    expect(html).toContain("Fee budget exceeded");
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("<time");
  });
});
