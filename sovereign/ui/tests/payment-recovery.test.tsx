import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "../src/api";
import { PaymentActivity, paymentRecoveryReview } from "../src/components/PaymentActivity";
import { recoverReviewedPayment } from "../src/views/Pay";
import type { PaymentListItem } from "../src/types";

const TX = `0x${"a".repeat(64)}`;
const DESTINATION = `0x${"b".repeat(40)}`;
const signed = (): PaymentListItem => ({
  id: "payment-1", account_id: "account-1", rail: "evm-base", asset: "ETH",
  to_addr: DESTINATION, amount_minor: "1000000000000000001", fee_minor: "1000",
  status: "confirmed", tx_hash: TX, error: null, created_at: "2026-08-23T12:00:00Z", intent_state: "signed",
  truth: { intent_id: "payment-1", lifecycle_state: "signed", chain_id: "eip155:8453", network_tx_id: TX,
    visibility: "not_checked", actions: { reconcile: true, exact_rebroadcast: true, safe_to_create_new_payment: false } },
});

describe("reviewed exact-byte payment recovery", () => {
  test("requires explicit permission and a stable signed Base transaction", () => {
    const payment = signed();
    expect(paymentRecoveryReview(payment)).toMatchObject({ txId: TX, destination: DESTINATION, amountMinor: "1000000000000000001" });
    for (const patch of [
      { actions: undefined },
      { actions: { exact_rebroadcast: false } },
      { lifecycle_state: "prepared" },
      // Backend truth currently offers this, but its recovery endpoint refuses ambiguous executions.
      { lifecycle_state: "ambiguous" },
      { canonicality: "conflicted" },
      { canonicality: "reorged" },
      { visibility: "included" },
      { visibility: "mempool" },
      { network_tx_id: null },
      { intent_id: "another-payment" },
    ]) expect(paymentRecoveryReview({ ...payment, truth: { ...payment.truth, ...patch } })).toBeNull();
    expect(paymentRecoveryReview({ ...payment, tx_hash: `0x${"c".repeat(64)}` })).toBeNull();
    expect(paymentRecoveryReview({ ...payment, asset: "SOL" })).toBeNull();
    expect(paymentRecoveryReview({ ...payment, amount_minor: "0" })).toBeNull();
    expect(paymentRecoveryReview({ ...payment, truth: null })).toBeNull();
  });

  test("shows the full reviewed identity and disables both activity actions during either operation", () => {
    const payment = signed();
    const review = paymentRecoveryReview(payment)!;
    for (const operation of ["reconcile", "recover"] as const) {
      const html = renderToStaticMarkup(<PaymentActivity payments={[payment]} error={null}
        checkingId={operation === "reconcile" ? payment.id : null}
        recoveringId={operation === "recover" ? payment.id : null}
        recoveryReview={review} notice={null} onReconcile={() => undefined}
        onReviewRecovery={() => undefined} onRecover={() => undefined} onCancelRecovery={() => undefined} />);
      expect(html).toContain(TX);
      expect(html).toContain(DESTINATION);
      expect(html).toContain("1000000000000000001 atomic");
      expect(html).toContain("1.000000000000000001");
      expect(html).toContain("No new transaction is created or signed");
      const buttons = [...html.matchAll(/<button\b[^>]*>/g)];
      expect(buttons.length).toBe(4);
      expect(buttons.every(([tag]) => tag.includes("disabled"))).toBe(true);
    }
  });

  test("withdraws the confirmation when the displayed record changes after review", () => {
    const payment = signed();
    const html = renderToStaticMarkup(<PaymentActivity payments={[{ ...payment, to_addr: `0x${"c".repeat(40)}` }]}
      error={null} checkingId={null} notice={null} recoveryReview={paymentRecoveryReview(payment)}
      onReconcile={() => undefined} onRecover={() => undefined} />);
    expect(html).toContain("This record changed or recovery is no longer available");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Rebroadcast this transaction<\/button>/);
  });

  test("preflights the reviewed identity, makes one POST, then loads locally recorded ambiguity", async () => {
    const before = signed();
    const after = { ...before, intent_state: "ambiguous", truth: { ...before.truth, lifecycle_state: "ambiguous" } };
    const calls: string[] = [];
    const result = await recoverReviewedPayment(paymentRecoveryReview(before)!, {
      payments: async () => { calls.push("read"); return { payments: [calls.length === 1 ? before : after] }; },
      payRecover: async paymentId => {
        calls.push(`recover:${paymentId}`);
        return { paymentId, status: "confirmed", txHash: TX, error: "Outcome unknown" };
      },
    });
    expect(calls).toEqual(["read", "recover:payment-1", "read"]);
    expect(result.payments).toEqual([after]);
    expect(result.notice).toMatchObject({ kind: "alert", text: expect.stringContaining("No recovery was retried") });
    expect(paymentRecoveryReview(result.payments![0])).toBeNull();
  });

  test("reloads local truth after a lost response without automatically repeating the mutation", async () => {
    const before = signed();
    const after = { ...before, status: "broadcast", intent_state: "submitted", truth: { ...before.truth, lifecycle_state: "submitted" } };
    const calls: string[] = [];
    const result = await recoverReviewedPayment(paymentRecoveryReview(before)!, {
      payments: async () => { calls.push("read"); return { payments: [calls.length === 1 ? before : after] }; },
      payRecover: async () => { calls.push("recover"); throw new TypeError("Failed to fetch"); },
    });
    expect(calls).toEqual(["read", "recover", "read"]);
    expect(result.payments).toEqual([after]);
    expect(result.notice.kind).toBe("alert");
    expect(result.notice.text).toContain("may already be on the network");
  });

  test("does not mutate when identity or availability changed before confirmation", async () => {
    const before = signed();
    for (const current of [
      { ...before, amount_minor: "2000000000000000000" },
      { ...before, truth: { ...before.truth, actions: { exact_rebroadcast: false } } },
    ]) {
      let mutations = 0;
      const result = await recoverReviewedPayment(paymentRecoveryReview(before)!, {
        payments: async () => ({ payments: [current] }),
        payRecover: async () => { mutations++; throw new Error("Must not mutate"); },
      });
      expect(mutations).toBe(0);
      expect(result.payments).toEqual([current]);
      expect(result.notice.text).toContain("No recovery was requested");
    }
  });

  test("keeps failed local reloads visible and does not infer settlement from broadcast", async () => {
    const before = signed();
    let reads = 0;
    const result = await recoverReviewedPayment(paymentRecoveryReview(before)!, {
      payments: async () => { if (++reads > 1) throw new Error("Local reload failed"); return { payments: [before] }; },
      payRecover: async paymentId => ({ paymentId, status: "broadcast", txHash: TX, error: null }),
    });
    expect(reads).toBe(2);
    expect(result.reloadError).toBe("Local reload failed");
    expect(result.notice.kind).toBe("alert");
    expect(result.notice.text).toContain("Settlement is still unverified");
    expect(result.notice.text).toContain("record is from before recovery");
  });
});

test("recovery API submits only the reviewed payment id and rejects unreadable or mismatched results", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: unknown; init?: RequestInit }> = [];
  let response = Response.json({ paymentId: "payment-1", status: "confirmed", txHash: TX, error: "Outcome unknown" });
  globalThis.fetch = (async (path, init) => { calls.push({ path, init }); return response; }) as typeof fetch;
  try {
    expect(await api.payRecover("payment-1")).toMatchObject({ status: "confirmed", txHash: TX });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/pay/recover");
    expect(calls[0].init).toMatchObject({ method: "POST", body: JSON.stringify({ paymentId: "payment-1" }) });
    for (const next of [new Response("<html>unreadable</html>"), Response.json({}),
      Response.json({ paymentId: "wrong-payment", status: "broadcast", txHash: TX, error: null })]) {
      response = next;
      let error: unknown;
      try { await api.payRecover("payment-1"); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("recovery_outcome_unknown");
      expect((error as ApiError).message).not.toContain("Retry the exact request");
    }
    expect(calls).toHaveLength(4);
  } finally { globalThis.fetch = originalFetch; }
});
