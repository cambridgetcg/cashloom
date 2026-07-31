export interface ExecutionRecoveryKey {
  payment_id: string;
  review_id: string;
}

export interface ExecutionReviewIdentity {
  payment_id: string;
  review_id: string;
}

export function executionRecoveryKeyForReview(
  review: ExecutionReviewIdentity,
): ExecutionRecoveryKey {
  return {
    payment_id: review.payment_id,
    review_id: review.review_id,
  };
}

export function sameExecutionRecoveryKey(
  left: ExecutionRecoveryKey | null,
  right: ExecutionRecoveryKey | null,
): boolean {
  return left !== null
    && right !== null
    && left.payment_id === right.payment_id
    && left.review_id === right.review_id;
}

export function exactExecutionRecoveryKey(
  review: ExecutionReviewIdentity,
  marker: ExecutionRecoveryKey | null,
): ExecutionRecoveryKey | null {
  const expected = executionRecoveryKeyForReview(review);
  return sameExecutionRecoveryKey(expected, marker) ? expected : null;
}
