import { Resend } from "resend";
import { Env } from "./env.config";

// Lazy-init: only create the Resend client if a key is present.
// Without a key, email features fail gracefully per-call instead of crashing boot.
let _resend: Resend | null = null;
export const resend = new Proxy({} as Resend, {
  get(_t, prop) {
    if (!Env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set — email features unavailable");
    }
    if (!_resend) _resend = new Resend(Env.RESEND_API_KEY);
    return (_resend as any)[prop];
  },
});
