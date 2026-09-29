import type { CapitalFlowAdapter } from "./model.ts";
import { createEcbFundAdapter, createEcbSovereignAdapter } from "./ecb.ts";
import { createTicTransactionsAdapter, createUsCashFinancingAdapter } from "./us.ts";

/** Fixed, separately scoped publisher populations; these series are not a global total. */
export const capitalFlowAdapters: readonly CapitalFlowAdapter[] = [
  createUsCashFinancingAdapter(),
  createEcbSovereignAdapter(),
  createTicTransactionsAdapter(),
  createEcbFundAdapter(),
];
