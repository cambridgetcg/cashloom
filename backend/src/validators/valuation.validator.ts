import { z } from "zod";

// Query shape for GET /valuation/net-worth. `home` optionally overrides the
// user's display currency for this one valuation (e.g. ?home=JPY). Trimmed and
// uppercased BEFORE the pattern check so "gbp" is accepted; the 2–8 capital
// letter/length bound matches fiat ISO-4217 codes and crypto symbols alike
// while refusing anything that couldn't be a currency code. The service treats
// an absent override as "use the user's stored display currency, else USD".
export const netWorthQuerySchema = z.object({
  home: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,8}$/, "home must be a currency code like GBP or BTC")
    .optional(),
});

export type NetWorthQueryType = z.infer<typeof netWorthQuerySchema>;
