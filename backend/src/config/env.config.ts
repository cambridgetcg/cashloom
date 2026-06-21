import { getEnv } from "../utils/get-env";

const envConfig = () => ({
  NODE_ENV: getEnv("NODE_ENV", "development"),

  PORT: getEnv("PORT", "8000"),
  BASE_PATH: getEnv("BASE_PATH", "/api"),
  MONGO_URI: getEnv("MONGO_URI"),

  JWT_SECRET: getEnv("JWT_SECRET", "secert_jwt"),
  // Long-lived token: there's no refresh endpoint, so a short expiry just
  // dumps the user mid-session. 7 days is the coherent single-token path.
  JWT_EXPIRES_IN: getEnv("JWT_EXPIRES_IN", "7d") as string,

  GEMINI_API_KEY: getEnv("GEMINI_API_KEY", ""),

  CLOUDINARY_CLOUD_NAME: getEnv("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: getEnv("CLOUDINARY_API_KEY", ""),
  CLOUDINARY_API_SECRET: getEnv("CLOUDINARY_API_SECRET", ""),

  RESEND_API_KEY: getEnv("RESEND_API_KEY", ""),
  RESEND_MAILER_SENDER: getEnv("RESEND_MAILER_SENDER", ""),

  FRONTEND_ORIGIN: getEnv("FRONTEND_ORIGIN", "localhost"),

  // READ-ONLY connector credentials, set via `fly secrets set ...`. OPTIONAL
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
  // (mempool.space/api is shape-compatible), not a credential. None of these
  // can move money. These entries are fly-secrets BOOKKEEPING — the
  // connectors read process.env at call time, never this object.
  STRIPE_RESTRICTED_KEY: getEnv("STRIPE_RESTRICTED_KEY", ""),
  GOCARDLESS_SECRET_ID: getEnv("GOCARDLESS_SECRET_ID", ""),
  GOCARDLESS_SECRET_KEY: getEnv("GOCARDLESS_SECRET_KEY", ""),
  ALCHEMY_API_KEY: getEnv("ALCHEMY_API_KEY", ""),
  ESPLORA_BASE_URL: getEnv("ESPLORA_BASE_URL", ""),
});

export const Env = envConfig();

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
