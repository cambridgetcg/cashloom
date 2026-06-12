import { z } from "zod";
import { AccountStatusEnum, RailEnum } from "../models/account.model";

export const accountIdSchema = z.string().trim().min(1);

export const createAccountSchema = z.object({
  rail: z.enum([
    RailEnum.STRIPE,
    RailEnum.BANK,
    RailEnum.CRYPTO,
    RailEnum.CASH,
    RailEnum.PLATFORM_CREDIT,
    RailEnum.GIFT_CARD,
  ]),
  connectorType: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1, "Display name is required"),
  // Fiat ISO-4217 or crypto symbol; uppercased to match the model.
  currency: z
    .string()
    .trim()
    .min(2, "Currency is required")
    .max(10)
    .transform((v) => v.toUpperCase()),
  decimals: z.number().int().min(0).max(30).optional(),
  externalAccountId: z.string().trim().min(1).optional(),
  // A pointer to a secret store, never a secret value.
  credentialRef: z.string().trim().min(1).optional(),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  status: z
    .enum([AccountStatusEnum.ACTIVE, AccountStatusEnum.ARCHIVED])
    .optional(),
});

export type CreateAccountType = z.infer<typeof createAccountSchema>;
export type UpdateAccountType = z.infer<typeof updateAccountSchema>;
