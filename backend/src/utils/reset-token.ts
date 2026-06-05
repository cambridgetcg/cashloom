import crypto from "crypto";

// We store the HASH of a reset token, never the token itself — so a DB leak
// can't be used to reset anyone's password. The raw token only ever lives in
// the emailed link. SHA-256 is fine here: the token is already 256 bits of
// randomness, so there's nothing to brute-force.
export const hashResetToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

// A fresh reset token: the raw value goes in the email link, the hash in the DB.
export const generateResetToken = (): { token: string; tokenHash: string } => {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashResetToken(token) };
};
