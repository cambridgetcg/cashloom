import { z } from "zod";

// Validate all environment variables at boot so a misconfig fails fast with a
// clear message instead of surfacing as a cryptic runtime error mid-request.
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().default(8000),
  BASE_PATH: z.string().default("/api"),
  MONGO_URI: z.string().min(1, "MONGO_URI is required"),

  JWT_SECRET: z.string().default("secert_jwt"),
  // Long-lived token: there's no refresh endpoint, so a short expiry just
  // dumps the user mid-session. 7 days is the coherent single-token path.
  JWT_EXPIRES_IN: z.string().default("7d"),

  GEMINI_API_KEY: z.string().optional(),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_MAILER_SENDER: z.string().default(""),

  FRONTEND_ORIGIN: z.string().default("localhost"),

  // Connector credentials — READ-ONLY-scoped except AGENTTOOL_API_KEY (see
  // below) — set via `fly secrets set ...`. OPTIONAL
  // on purpose: a missing key must not stop boot — the connector fails
  // per-call with a message naming the unset variable instead (see
  // connectors/credentials.ts, which resolves these from process.env at call
  // time). The Stripe key is a RESTRICTED key (rk_...) scoped to
  // balance:read + balance_transactions:read; the GoCardless pair is the
  // Bank Account Data secret id/key. The Alchemy key must be a READ-ONLY
  // scoped key: its value lives ONLY in the gitignored .env / fly secrets —
  // the DB stores the pointer-only credentialRef "ALCHEMY_API_KEY", never the
  // value (SECURITY-ROTATION leak lesson). Esplora is a keyless public
  // indexer: ESPLORA_BASE_URL is an optional base-URL override
  // (mempool.space/api is shape-compatible), not a credential. None of the
  // above can move money. The agenttool key is the ONE exception to that
  // sentence: agenttool bearer keys have no read-only scope upstream, so
  // while the connector only ever reads, the credential itself is
  // money-capable — mint it in a dedicated bridge project, fence that
  // project's wallets with economy.policies, treat it as hot
  // (agenttool.connector.ts header). AGENTTOOL_BASE_URL is a base-URL
  // override like Esplora's, not a credential. These entries are fly-secrets
  // BOOKKEEPING — the connectors read process.env at call time, never this
  // object.
  STRIPE_RESTRICTED_KEY: z.string().optional(),
  GOCARDLESS_SECRET_ID: z.string().optional(),
  GOCARDLESS_SECRET_KEY: z.string().optional(),
  ALCHEMY_API_KEY: z.string().optional(),
  ESPLORA_BASE_URL: z.string().optional(),
  AGENTTOOL_API_KEY: z.string().optional(),
  AGENTTOOL_BASE_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${errors}`);
}

export const Env = parsed.data;

// Never let the known public-repo default sign tokens in production — that
// would let anyone forge a login — and don't accept a trivially weak secret
// either. Fail fast at boot rather than shipping a forgeable-token deploy.
// (Treasury context: this app is the proposer/bookkeeper; money-moving secrets
// must never live in its env at all — see project design notes.)
if (Env.NODE_ENV === "production") {
  if (Env.JWT_SECRET === "secert_jwt" || Env.JWT_SECRET.length < 32) {
    throw new Error(
      "JWT_SECRET must be a strong secret (>= 32 chars) in production — the default is public."
    );
  }
}
