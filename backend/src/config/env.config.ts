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
// would let anyone forge a login. Fail fast instead of shipping it.
if (Env.NODE_ENV === "production" && Env.JWT_SECRET === "secert_jwt") {
  throw new Error(
    "JWT_SECRET must be set to a strong secret in production (the default is public)."
  );
}
