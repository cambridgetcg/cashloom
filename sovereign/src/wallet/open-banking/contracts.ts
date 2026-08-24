import { z } from "zod";
import type { Sha256Digest } from "../domain/intent.ts";
export type { Sha256Digest } from "../domain/intent.ts";

export const OPEN_BANKING_SCHEMA = Object.freeze({
  CONNECTION_ACTION: "cashloom.open-banking-connection-action/1",
  CONNECTION_STATUS: "cashloom.open-banking-connection-status/1",
  PREPARED_PAYMENT: "cashloom.open-banking-prepared-payment/1",
  PAYMENT_SUBMISSION: "cashloom.open-banking-payment-submission/1",
  PAYMENT_STATUS: "cashloom.open-banking-payment-status/1",
} as const);

export const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const canonicalTimestampSchema = z.string().datetime({ offset: false, precision: 3 });
export const canonicalUnsignedSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export type OpenBankingCurrency = "GBP" | "EUR";
export type BankDataScope = "balances" | "transactions";

export interface BeginBankDataConnection {
  readonly connection_id: string;
  readonly institution_id: string;
  readonly country: string;
  readonly currency: OpenBankingCurrency;
  readonly scopes: readonly BankDataScope[];
  readonly access_valid_for_days: number;
  readonly max_historical_days: number;
}

export interface BankDataConnectionAction {
  readonly schema_version: typeof OPEN_BANKING_SCHEMA.CONNECTION_ACTION;
  readonly provider: "gocardless-bank-data";
  readonly connection_id: string;
  readonly provider_connection_id: string;
  readonly provider_agreement_id: string;
  readonly country: string;
  readonly currency: OpenBankingCurrency;
  readonly state: "awaiting_user";
  /** A provider-created, fixed-origin URL. Callers can never supply this URL. */
  readonly authorization_url: string;
  readonly scopes: readonly BankDataScope[];
  readonly expires_at: string;
}

export type BankDataConnectionState =
  | "awaiting_user"
  | "linked"
  | "rejected"
  | "expired"
  | "revoked";

export interface BankDataConnectionStatus {
  readonly schema_version: typeof OPEN_BANKING_SCHEMA.CONNECTION_STATUS;
  readonly provider: "gocardless-bank-data";
  readonly connection_id: string;
  readonly provider_connection_id: string;
  readonly state: BankDataConnectionState;
  readonly provider_status: string;
  readonly account_refs: readonly string[];
  readonly observed_at: string;
}

export interface BankDataConnectionBroker {
  begin(
    request: BeginBankDataConnection,
    signal?: AbortSignal,
  ): Promise<BankDataConnectionAction>;
  status(
    request: {
      readonly connection_id: string;
      readonly provider_connection_id: string;
    },
    signal?: AbortSignal,
  ): Promise<BankDataConnectionStatus>;
  revoke(
    request: {
      readonly connection_id: string;
      readonly provider_connection_id: string;
    },
    signal?: AbortSignal,
  ): Promise<BankDataConnectionStatus>;
}

export interface DomesticGbpBeneficiary {
  readonly name: string;
  readonly sort_code: string;
  readonly account_number: string;
}

export interface PrepareDomesticGbpPayment {
  readonly execution_id: string;
  readonly intent_hash: Sha256Digest;
  /** Provider replay key, durably selected before authorization (max 40). */
  readonly idempotency_key: string;
  readonly source_account_ref: string;
  readonly institution_id: string;
  readonly amount_minor: string;
  readonly beneficiary: DomesticGbpBeneficiary;
  readonly reference: string;
  readonly expires_at: string;
}

export interface PreparedDomesticGbpPayment extends PrepareDomesticGbpPayment {
  readonly schema_version: typeof OPEN_BANKING_SCHEMA.PREPARED_PAYMENT;
  readonly provider: "yapily-connect";
  readonly kind: "provider-authorized";
  readonly currency: "GBP";
  readonly payment_type: "DOMESTIC_SINGLE_IMMEDIATE";
  readonly authorization_state: string;
  readonly request_fingerprint: Sha256Digest;
}

export type OpenBankingPaymentState =
  | "authorization_returned"
  | "submitted"
  | "pending"
  | "settled"
  | "declined"
  | "failed"
  | "ambiguous";

export interface YapilyPaymentSubmission {
  readonly schema_version: typeof OPEN_BANKING_SCHEMA.PAYMENT_SUBMISSION;
  readonly provider: "yapily-connect";
  readonly execution_id: string;
  readonly intent_hash: Sha256Digest;
  /** A create-payment response is transport evidence only. Terminal truth is
   * available solely from the separate status observer/reconciler. */
  readonly outcome: "pending" | "ambiguous";
  readonly state: OpenBankingPaymentState;
  readonly provider_payment_id: string | null;
  readonly provider_status: string | null;
  readonly idempotency_key: string;
  readonly submitted_at: string;
  readonly safe_to_retry: false;
}

export interface YapilyPaymentStatus {
  readonly schema_version: typeof OPEN_BANKING_SCHEMA.PAYMENT_STATUS;
  readonly provider: "yapily-connect";
  readonly execution_id: string;
  readonly provider_payment_id: string;
  readonly state: OpenBankingPaymentState;
  readonly provider_status: string;
  readonly iso_status_code: string | null;
  readonly observed_at: string;
  readonly terminal: boolean;
}

export interface YapilyConnectPaymentExecutor {
  prepare(request: PrepareDomesticGbpPayment): PreparedDomesticGbpPayment;
  authorize(
    request: {
      readonly prepared: PreparedDomesticGbpPayment;
      readonly request_fingerprint: Sha256Digest;
      readonly authorization_state: string;
      /** Exact durable consent projection. The one-use consent token is
       * provider-scoped; this public reference proves which source account the
       * local authorization expected it to represent. */
      readonly consented_source_account_ref: string;
      readonly consent_token: string;
      readonly idempotency_key: string;
    },
    signal?: AbortSignal,
  ): Promise<YapilyPaymentSubmission>;
}

export interface YapilyPaymentStatusObserver {
  status(
    request: {
      readonly execution_id: string;
      readonly provider_payment_id: string;
    },
    signal?: AbortSignal,
  ): Promise<YapilyPaymentStatus>;
}
