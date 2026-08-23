import { z } from "zod";

export const CUSTODY_MODES = [
  "watch_only",
  "external_signer",
  "local_self_custody",
  "smart_account",
  "managed_mpc",
  "regulated_fiat_provider",
] as const;

export const custodyModeSchema = z.enum(CUSTODY_MODES);
export type CustodyMode = z.infer<typeof custodyModeSchema>;

export const canCustodyModeSign = (mode: CustodyMode): boolean =>
  mode !== "watch_only" && mode !== "regulated_fiat_provider";

