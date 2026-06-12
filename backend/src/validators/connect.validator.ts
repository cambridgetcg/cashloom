import { z } from "zod";

// GoCardless onboarding inputs. Country is ISO 3166-1 alpha-2, lowercased to
// match what the GoCardless institutions endpoint expects; defaults to "gb"
// because that's where the kingdom banks today.
export const institutionsQuerySchema = z.object({
  country: z
    .string()
    .trim()
    .length(2, "country must be a 2-letter ISO code")
    .transform((v) => v.toLowerCase())
    .default("gb"),
});

export const requisitionIdSchema = z.string().trim().min(1);

export const createRequisitionSchema = z.object({
  institutionId: z.string().trim().min(1, "institutionId is required"),
  // Where the bank sends the browser after auth. Optional — falls back to the
  // first configured frontend origin.
  redirectUrl: z.string().trim().url().optional(),
});

export type CreateRequisitionType = z.infer<typeof createRequisitionSchema>;
