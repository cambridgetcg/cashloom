import { Env } from "../config/env.config";

// Thin logger that keeps debug noise + PII out of production logs. In dev you
// see everything; in prod we only surface the error name + path — never the
// full object (which can carry financial data, file paths, stack traces).
const isProd = Env.NODE_ENV === "production";

export const logger = {
  info: (message: string, ...meta: unknown[]) => {
    if (!isProd) console.log(message, ...meta);
  },
  error: (message: string, ...meta: unknown[]) => {
    if (isProd) {
      // In prod: just the message — no full error objects dumped.
      console.error(message);
    } else {
      console.error(message, ...meta);
    }
  },
  warn: (message: string, ...meta: unknown[]) => {
    console.warn(message, ...meta);
  },
};
