import { InternalServerException } from "../utils/app-error";

// The ONLY place connector secrets are touched. A credentialRef (see
// Account.credentialRef) is the NAME of an environment variable — a pointer,
// never a value. Resolution happens here, at call time, so secrets live solely
// in the process environment: not in the database, not in code, not in logs.
// Error messages name the missing VARIABLE, never any value.

// The pointer namespace is CLOSED. credentialRef is stored from API input, so
// an unbounded ref would let an authenticated user point a connector at ANY
// server env var (JWT_SECRET, DATABASE_URL, RESEND_API_KEY...) and have its
// value transmitted upstream as a bearer token — blind exfiltration of
// arbitrary server secrets. Only env vars under a connector-credential prefix
// (STRIPE_* / GOCARDLESS_* / ALCHEMY_*) are nameable; everything else is
// unreachable by construction. Keyless connectors (Esplora, the public rate
// APIs) add NOTHING here — a prefix only enters this pattern when a connector
// genuinely needs a credential. Enforced both at input validation
// (account.validator) and here at resolution, so no write path — present or
// future — can widen the namespace.
export const CREDENTIAL_REF_PATTERN = /^(STRIPE|GOCARDLESS|ALCHEMY)_[A-Z0-9_]+$/;

export const isAllowedCredentialRef = (ref: string): boolean =>
  CREDENTIAL_REF_PATTERN.test(ref);

export const resolveCredentialRef = (ref: string): string => {
  if (!ref || ref.trim() === "") {
    throw new InternalServerException(
      "Cannot resolve connector credential: credentialRef is empty"
    );
  }
  if (!isAllowedCredentialRef(ref)) {
    throw new InternalServerException(
      `Refusing to resolve credentialRef "${ref}": only connector-credential environment variables (STRIPE_* / GOCARDLESS_* / ALCHEMY_*) can be referenced`
    );
  }
  const value = process.env[ref];
  if (value === undefined || value.trim() === "") {
    throw new InternalServerException(
      `Connector credential is not configured: environment variable "${ref}" is unset or empty`
    );
  }
  return value;
};
