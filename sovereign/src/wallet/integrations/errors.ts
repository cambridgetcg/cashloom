/** Stable, secret-safe errors for a future transport/API boundary. */
export const INTEGRATION_ERROR_CODES = [
  "integration_contract_invalid",
  "webauthn_ceremony_refused",
  "external_signer_mismatch",
  "walletconnect_session_refused",
  "erc4337_user_operation_refused",
  "fiat_provider_authorization_refused",
  "integration_evidence_rejected",
] as const;

export type IntegrationErrorCode = typeof INTEGRATION_ERROR_CODES[number];

const messages: Record<IntegrationErrorCode, string> = {
  integration_contract_invalid: "The external-wallet contract was invalid.",
  webauthn_ceremony_refused: "The passkey ceremony did not satisfy the approved binding.",
  external_signer_mismatch: "The external signer did not satisfy the approved request.",
  walletconnect_session_refused: "The WalletConnect session did not satisfy the approved binding.",
  erc4337_user_operation_refused: "The smart-account operation did not satisfy the approved binding.",
  fiat_provider_authorization_refused: "The fiat-provider authorization did not satisfy the approved binding.",
  integration_evidence_rejected: "The external execution evidence could not be verified.",
};

export class IntegrationContractError extends Error {
  readonly name = "IntegrationContractError";
  constructor(readonly code: IntegrationErrorCode) {
    super(messages[code]);
  }
}

export const integrationErrorMessage = (code: IntegrationErrorCode): string => messages[code];
