import { z } from "zod";

// Display currencies we support. This is a symbol/format choice, not FX —
// amounts are stored as entered; the user just sees their own currency.
export const SUPPORTED_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "JPY",
  "INR",
  "SGD",
  "NZD",
  "CHF",
] as const;

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
});

export type UpdateUserType = z.infer<typeof updateUserSchema>;
