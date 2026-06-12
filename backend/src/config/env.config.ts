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

  GEMINI_API_KEY: getEnv("GEMINI_API_KEY"),

  CLOUDINARY_CLOUD_NAME: getEnv("CLOUDINARY_CLOUD_NAME"),
  CLOUDINARY_API_KEY: getEnv("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: getEnv("CLOUDINARY_API_SECRET"),

  RESEND_API_KEY: getEnv("RESEND_API_KEY"),
  RESEND_MAILER_SENDER: getEnv("RESEND_MAILER_SENDER", ""),

  FRONTEND_ORIGIN: getEnv("FRONTEND_ORIGIN", "localhost"),
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
