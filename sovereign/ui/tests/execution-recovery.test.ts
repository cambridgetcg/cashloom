import { describe, expect, test } from "bun:test";
import {
  exactExecutionRecoveryKey,
  executionRecoveryKeyForReview,
  sameExecutionRecoveryKey,
} from "../src/execution-recovery";

const review = {
  payment_id: "payment-a",
  review_id: "review-a",
};

describe("payment execution recovery identity", () => {
  test("requires both exact IDs before a prepared review can be sent", () => {
    expect(exactExecutionRecoveryKey(review, null)).toBeNull();
    expect(exactExecutionRecoveryKey(review, {
      payment_id: "payment-b",
      review_id: review.review_id,
    })).toBeNull();
    expect(exactExecutionRecoveryKey(review, {
      payment_id: review.payment_id,
      review_id: "review-b",
    })).toBeNull();
    expect(exactExecutionRecoveryKey(review, review)).toEqual(review);
  });

  test("creates a minimal marker containing only the payment binding", () => {
    expect(executionRecoveryKeyForReview({
      ...review,
      ignored: "payment terms must not enter session storage",
    })).toEqual(review);
  });

  test("never treats an absent or cross-review marker as the same binding", () => {
    expect(sameExecutionRecoveryKey(null, null)).toBe(false);
    expect(sameExecutionRecoveryKey(review, null)).toBe(false);
    expect(sameExecutionRecoveryKey(review, {
      payment_id: review.payment_id,
      review_id: "review-b",
    })).toBe(false);
    expect(sameExecutionRecoveryKey(review, { ...review })).toBe(true);
  });
});
