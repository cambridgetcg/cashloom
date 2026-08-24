export type OpenBankingErrorCode =
  | "OPEN_BANKING_INVALID_REQUEST"
  | "OPEN_BANKING_CREDENTIAL_UNAVAILABLE"
  | "OPEN_BANKING_UNAUTHORIZED"
  | "OPEN_BANKING_FORBIDDEN"
  | "OPEN_BANKING_RATE_LIMITED"
  | "OPEN_BANKING_PROVIDER_CONFLICT"
  | "OPEN_BANKING_PROVIDER_UNAVAILABLE"
  | "OPEN_BANKING_PROVIDER_REJECTED"
  | "OPEN_BANKING_PROVIDER_MALFORMED"
  | "OPEN_BANKING_RESPONSE_TOO_LARGE"
  | "OPEN_BANKING_TIMEOUT"
  | "OPEN_BANKING_CANCELLED"
  | "OPEN_BANKING_NETWORK_UNAVAILABLE"
  | "OPEN_BANKING_AMBIGUOUS_SUBMISSION"
  | "OPEN_BANKING_BINDING_MISMATCH";

/** Stable and deliberately provider-body-free. */
export class OpenBankingAdapterError extends Error {
  constructor(
    readonly code: OpenBankingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenBankingAdapterError";
  }
}

export const stableOpenBankingError = (
  code: OpenBankingErrorCode,
): OpenBankingAdapterError => {
  const messages: Record<OpenBankingErrorCode, string> = {
    OPEN_BANKING_INVALID_REQUEST: "The open-banking request is invalid.",
    OPEN_BANKING_CREDENTIAL_UNAVAILABLE: "The open-banking provider credential is unavailable.",
    OPEN_BANKING_UNAUTHORIZED: "The open-banking provider rejected its configured credential.",
    OPEN_BANKING_FORBIDDEN: "The open-banking provider refused this operation.",
    OPEN_BANKING_RATE_LIMITED: "The open-banking provider rate limit is active; do not retry automatically.",
    OPEN_BANKING_PROVIDER_CONFLICT: "The open-banking provider reported an existing or conflicting resource.",
    OPEN_BANKING_PROVIDER_UNAVAILABLE: "The open-banking provider is temporarily unavailable.",
    OPEN_BANKING_PROVIDER_REJECTED: "The open-banking provider rejected the request.",
    OPEN_BANKING_PROVIDER_MALFORMED: "The open-banking provider returned malformed data.",
    OPEN_BANKING_RESPONSE_TOO_LARGE: "The open-banking provider response exceeded its safe bound.",
    OPEN_BANKING_TIMEOUT: "The open-banking provider did not answer before the deadline.",
    OPEN_BANKING_CANCELLED: "The open-banking operation was cancelled.",
    OPEN_BANKING_NETWORK_UNAVAILABLE: "The open-banking provider could not be reached.",
    OPEN_BANKING_AMBIGUOUS_SUBMISSION: "The payment submission outcome is unknown and must be reconciled before retrying.",
    OPEN_BANKING_BINDING_MISMATCH: "The open-banking authorization no longer matches its prepared payment.",
  };
  return new OpenBankingAdapterError(code, messages[code]);
};
