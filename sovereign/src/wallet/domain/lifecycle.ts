import { z } from "zod";

export const PAYMENT_LIFECYCLE_STATES = [
  "draft",
  "validated",
  "quoted",
  "simulated",
  "reserved",
  "authorized",
  "prepared",
  "signed",
  "submitted",
  "accepted",
  "pending",
  "settled",
  "ambiguous",
  "replaced",
  "reorged",
  "expired",
  "declined",
  "failed",
  "dropped",
  "cancelled",
  "reversed",
  "charged_back",
  "refunded",
] as const;

export const paymentLifecycleStateSchema = z.enum(PAYMENT_LIFECYCLE_STATES);
export type PaymentLifecycleState = z.infer<typeof paymentLifecycleStateSchema>;

/**
 * Durable workflows may be projected after an upstream validation, quote, or
 * provider authorization. They may not first appear as executed/terminal: an
 * execution state requires the intervening append-only lifecycle evidence.
 */
export const PAYMENT_LIFECYCLE_INITIAL_STATES = [
  "draft",
  "validated",
  "quoted",
  "simulated",
  "reserved",
  "authorized",
] as const satisfies readonly PaymentLifecycleState[];

export const paymentLifecycleInitialStateSchema = z.enum(
  PAYMENT_LIFECYCLE_INITIAL_STATES,
);
export type PaymentLifecycleInitialState = z.infer<
  typeof paymentLifecycleInitialStateSchema
>;

export const parseInitialPaymentLifecycleState = (
  input: unknown,
): PaymentLifecycleInitialState => paymentLifecycleInitialStateSchema.parse(input);

const TRANSITIONS: Readonly<Record<PaymentLifecycleState, readonly PaymentLifecycleState[]>> = {
  draft: ["validated", "cancelled"],
  validated: ["quoted", "simulated", "reserved", "declined", "expired", "cancelled"],
  quoted: ["simulated", "reserved", "declined", "expired", "cancelled"],
  simulated: ["quoted", "reserved", "declined", "expired", "cancelled"],
  reserved: ["authorized", "declined", "expired", "cancelled", "failed"],
  authorized: ["prepared", "declined", "expired", "cancelled", "failed"],
  prepared: ["signed", "submitted", "expired", "cancelled", "failed"],
  signed: ["submitted", "expired", "cancelled", "failed"],
  submitted: ["accepted", "pending", "settled", "ambiguous", "failed"],
  accepted: ["pending", "settled", "ambiguous", "failed", "replaced", "dropped"],
  pending: ["settled", "ambiguous", "failed", "replaced", "dropped", "reorged"],
  settled: ["reversed", "charged_back", "refunded", "reorged"],
  ambiguous: ["accepted", "pending", "settled", "failed", "replaced", "dropped"],
  replaced: ["pending", "settled", "ambiguous", "failed", "dropped"],
  reorged: ["pending", "settled", "replaced", "dropped", "failed"],
  expired: [],
  declined: [],
  failed: [],
  dropped: [],
  cancelled: [],
  reversed: [],
  charged_back: [],
  refunded: [],
};

export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentLifecycleState> = new Set(
  PAYMENT_LIFECYCLE_STATES.filter((state) => TRANSITIONS[state].length === 0),
);

export const allowedTransitionsFrom = (
  stateInput: PaymentLifecycleState,
): readonly PaymentLifecycleState[] => {
  const state = paymentLifecycleStateSchema.parse(stateInput);
  return TRANSITIONS[state];
};

export const canTransition = (
  fromInput: PaymentLifecycleState,
  toInput: PaymentLifecycleState,
): boolean => {
  const from = paymentLifecycleStateSchema.parse(fromInput);
  const to = paymentLifecycleStateSchema.parse(toInput);
  return TRANSITIONS[from].includes(to);
};

export const assertTransition = (
  fromInput: PaymentLifecycleState,
  toInput: PaymentLifecycleState,
): void => {
  const from = paymentLifecycleStateSchema.parse(fromInput);
  const to = paymentLifecycleStateSchema.parse(toInput);
  if (!canTransition(from, to)) {
    throw new Error(`invalid payment lifecycle transition: ${from} -> ${to}`);
  }
};
