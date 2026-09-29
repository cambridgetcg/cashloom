import { z } from "zod";

const singleLine = (maximum: number) => z.string().trim().min(1).max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const accessInputSchema = z.object({
  label: singleLine(80), account_ids: z.array(z.string().uuid()).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  allow_proposals: z.boolean(), ttl_minutes: z.number().int().min(1).max(60),
}).strict();
export const proposalInputSchema = z.object({
  request_id: z.string().uuid(), transaction_id: z.string().uuid(),
  expected_record_version: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  category: singleLine(60), reason: z.string().trim().max(500).transform((value) => value.replace(/\r\n?/g, "\n"))
    .pipe(z.string().min(1).refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value))),
}).strict();
