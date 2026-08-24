/**
 * One-off domestic GBP PIS execution through a regulated Yapily consent.
 *
 * This module does not create recurring/VRP, scheduled, bulk, international,
 * refund or payout operations. A caller must supply the one-time consent token
 * returned by the regulated user journey. Redirect completion is never mapped
 * to settlement; only the status observer may report a terminal provider fact.
 */

import type {
  PrepareDomesticGbpPayment,
  PreparedDomesticGbpPayment,
  Sha256Digest,
  YapilyConnectPaymentExecutor,
  YapilyPaymentSubmission,
} from "../open-banking/contracts.ts";
import { OPEN_BANKING_SCHEMA } from "../open-banking/contracts.ts";
import { fingerprint, randomAuthorizationState } from "../open-banking/crypto.ts";
import {
  OpenBankingAdapterError,
  stableOpenBankingError,
} from "../open-banking/errors.ts";
import {
  createFixedJsonHttp,
  type FixedJsonHttp,
  type FixedJsonHttpDependencies,
} from "../open-banking/http.ts";
import type { JsonValue } from "../domain/intent.ts";

const API_ORIGIN = "https://api.yapily.com";
const APPLICATION_ID_REF = "YAPILY_APPLICATION_ID";
const APPLICATION_SECRET_REF = "YAPILY_APPLICATION_SECRET";
const MAX_GBP_MINOR = 999_999_999_999n;

export interface YapilyConnectExecutorDependencies extends FixedJsonHttpDependencies {
  readonly resolve_credential: (reference: string) => string;
  readonly http?: FixedJsonHttp;
  readonly date_now?: () => Date;
  readonly authorization_state?: () => string;
}

interface PaymentResponse {
  data?: {
    id?: unknown;
    status?: unknown;
    statusDetails?: {
      status?: unknown;
      isoStatus?: { code?: unknown } | null;
    } | null;
  } | null;
}

const stableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const canonicalTime = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  new Date(value).toISOString() === value;

const minorToProviderMajor = (minor: string): number => {
  if (!/^[1-9][0-9]*$/.test(minor)) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  const amount = BigInt(minor);
  if (amount > MAX_GBP_MINOR) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  const whole = amount / 100n;
  const fraction = (amount % 100n).toString().padStart(2, "0");
  return Number(`${whole}.${fraction}`);
};

const preparedSemantic = (
  value: Omit<PreparedDomesticGbpPayment, "request_fingerprint">,
): JsonValue => ({
  schema_version: value.schema_version,
  provider: value.provider,
  kind: value.kind,
  execution_id: value.execution_id,
  intent_hash: value.intent_hash,
  idempotency_key: value.idempotency_key,
  source_account_ref: value.source_account_ref,
  institution_id: value.institution_id,
  amount_minor: value.amount_minor,
  currency: value.currency,
  payment_type: value.payment_type,
  beneficiary: {
    name: value.beneficiary.name,
    sort_code: value.beneficiary.sort_code,
    account_number: value.beneficiary.account_number,
  },
  reference: value.reference,
  authorization_state: value.authorization_state,
  expires_at: value.expires_at,
});

const validatePreparedInput = (request: PrepareDomesticGbpPayment): void => {
  if (
    !request ||
    typeof request !== "object" ||
    !stableId(request.execution_id) ||
    !/^sha256:[0-9a-f]{64}$/.test(request.intent_hash) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/.test(request.idempotency_key) ||
    !stableId(request.source_account_ref) ||
    !stableId(request.institution_id) ||
    !canonicalTime(request.expires_at) ||
    typeof request.reference !== "string" ||
    !/^[A-Za-z0-9 .,'+&\-/]{1,18}$/.test(request.reference) ||
    !request.beneficiary ||
    typeof request.beneficiary.name !== "string" ||
    request.beneficiary.name.trim().length < 1 ||
    request.beneficiary.name.trim().length > 70 ||
    !/^\d{6}$/.test(request.beneficiary.sort_code) ||
    !/^\d{8}$/.test(request.beneficiary.account_number)
  ) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  minorToProviderMajor(request.amount_minor);
};

const submissionStateFromProvider = (
  value: string,
): "authorization_returned" | "submitted" => {
  const status = value.toUpperCase();
  if (["AUTHORIZED", "AUTHORISATION_RETURNED"].includes(status)) {
    return "authorization_returned";
  }
  if ([
    "PENDING", "PROCESSING", "SUBMITTED", "INITIATED",
    "COMPLETED", "SETTLED", "DECLINED", "REJECTED", "CANCELLED",
  ].includes(status)) {
    // A POST response is transport acknowledgement, not our authoritative
    // settlement/rejection fact. The separate read-only status observer must
    // corroborate every terminal provider state.
    return "submitted";
  }
  throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
};

export const createYapilyConnectExecutor = (
  dependencies: YapilyConnectExecutorDependencies,
): YapilyConnectPaymentExecutor => {
  if (typeof dependencies?.resolve_credential !== "function") {
    throw new TypeError("Yapily credential resolver is required.");
  }
  const http = dependencies.http ?? createFixedJsonHttp(dependencies);
  const dateNow = dependencies.date_now ?? (() => new Date());
  const nextState = dependencies.authorization_state ?? randomAuthorizationState;

  const nowIso = (): string => {
    const value = dateNow();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Yapily clock is invalid.");
    }
    return value.toISOString();
  };

  const credential = (reference: string): string => {
    let value: string;
    try {
      value = dependencies.resolve_credential(reference);
    } catch {
      throw stableOpenBankingError("OPEN_BANKING_CREDENTIAL_UNAVAILABLE");
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw stableOpenBankingError("OPEN_BANKING_CREDENTIAL_UNAVAILABLE");
    }
    return value;
  };

  const basicAuthorization = (): string => {
    const id = credential(APPLICATION_ID_REF);
    const secret = credential(APPLICATION_SECRET_REF);
    return `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
  };

  const exactPrepared = (value: PreparedDomesticGbpPayment): Sha256Digest => {
    validatePreparedInput(value);
    if (
      value.schema_version !== OPEN_BANKING_SCHEMA.PREPARED_PAYMENT ||
      value.provider !== "yapily-connect" ||
      value.kind !== "provider-authorized" ||
      value.currency !== "GBP" ||
      value.payment_type !== "DOMESTIC_SINGLE_IMMEDIATE" ||
      !stableId(value.authorization_state)
    ) {
      throw stableOpenBankingError("OPEN_BANKING_BINDING_MISMATCH");
    }
    return fingerprint(preparedSemantic(value));
  };

  return Object.freeze({
    prepare(request: PrepareDomesticGbpPayment): PreparedDomesticGbpPayment {
      validatePreparedInput(request);
      if (Date.parse(request.expires_at) <= dateNow().getTime()) {
        throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
      }
      const authorizationState = nextState();
      if (!stableId(authorizationState)) {
        throw new TypeError("Yapily authorization_state generator is invalid.");
      }
      const withoutFingerprint = Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.PREPARED_PAYMENT,
        provider: "yapily-connect" as const,
        kind: "provider-authorized" as const,
        execution_id: request.execution_id,
        intent_hash: request.intent_hash,
        idempotency_key: request.idempotency_key,
        source_account_ref: request.source_account_ref,
        institution_id: request.institution_id,
        amount_minor: request.amount_minor,
        currency: "GBP" as const,
        payment_type: "DOMESTIC_SINGLE_IMMEDIATE" as const,
        beneficiary: Object.freeze({
          name: request.beneficiary.name.trim(),
          sort_code: request.beneficiary.sort_code,
          account_number: request.beneficiary.account_number,
        }),
        reference: request.reference,
        authorization_state: authorizationState,
        expires_at: request.expires_at,
      });
      return Object.freeze({
        ...withoutFingerprint,
        request_fingerprint: fingerprint(preparedSemantic(withoutFingerprint)),
      });
    },

    async authorize(
      request: {
        readonly prepared: PreparedDomesticGbpPayment;
        readonly request_fingerprint: Sha256Digest;
        readonly authorization_state: string;
        readonly consented_source_account_ref: string;
        readonly consent_token: string;
        readonly idempotency_key: string;
      },
      signal?: AbortSignal,
    ): Promise<YapilyPaymentSubmission> {
      if (signal?.aborted) {
        throw stableOpenBankingError("OPEN_BANKING_CANCELLED");
      }
      if (
        !request ||
        typeof request !== "object" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/.test(request.idempotency_key) ||
        !stableId(request.consented_source_account_ref) ||
        typeof request.consent_token !== "string" ||
        request.consent_token.length < 16 ||
        request.consent_token.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(request.consent_token)
      ) {
        throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
      }
      const recomputed = exactPrepared(request.prepared);
      if (
        recomputed !== request.prepared.request_fingerprint ||
        recomputed !== request.request_fingerprint ||
        request.idempotency_key !== request.prepared.idempotency_key ||
        request.consented_source_account_ref !== request.prepared.source_account_ref ||
        request.authorization_state !== request.prepared.authorization_state ||
        Date.parse(request.prepared.expires_at) <= dateNow().getTime()
      ) {
        throw stableOpenBankingError("OPEN_BANKING_BINDING_MISMATCH");
      }
      const submittedAt = nowIso();
      const ambiguous = (
        providerPaymentId: string | null = null,
        providerStatus: string | null = null,
      ): YapilyPaymentSubmission => Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.PAYMENT_SUBMISSION,
        provider: "yapily-connect",
        execution_id: request.prepared.execution_id,
        intent_hash: request.prepared.intent_hash,
        outcome: "ambiguous",
        state: "ambiguous",
        provider_payment_id: providerPaymentId,
        provider_status: providerStatus,
        idempotency_key: request.prepared.idempotency_key,
        submitted_at: submittedAt,
        safe_to_retry: false,
      });
      let response: PaymentResponse;
      try {
        response = await http.request<PaymentResponse>({
          origin: API_ORIGIN,
          path: "/payments",
          method: "POST",
          headers: {
            authorization: basicAuthorization(),
            consent: request.consent_token,
          },
          body: {
            paymentIdempotencyId: request.prepared.idempotency_key,
            institutionId: request.prepared.institution_id,
            type: "DOMESTIC_SINGLE_PAYMENT",
            amount: {
              amount: minorToProviderMajor(request.prepared.amount_minor),
              currency: "GBP",
            },
            payee: {
              name: request.prepared.beneficiary.name,
              accountIdentifications: [
                { type: "SORT_CODE", identification: request.prepared.beneficiary.sort_code },
                { type: "ACCOUNT_NUMBER", identification: request.prepared.beneficiary.account_number },
              ],
            },
            reference: request.prepared.reference,
          },
          signal,
        });
      } catch (error) {
        if (
          error instanceof OpenBankingAdapterError &&
          (error.code === "OPEN_BANKING_TIMEOUT" ||
            error.code === "OPEN_BANKING_NETWORK_UNAVAILABLE" ||
            error.code === "OPEN_BANKING_CANCELLED" ||
            error.code === "OPEN_BANKING_PROVIDER_UNAVAILABLE" ||
            error.code === "OPEN_BANKING_PROVIDER_CONFLICT" ||
            error.code === "OPEN_BANKING_PROVIDER_MALFORMED" ||
            error.code === "OPEN_BANKING_RESPONSE_TOO_LARGE")
        ) {
          return ambiguous();
        }
        throw error;
      }
      const data = response?.data;
      const providerStatus = typeof data?.statusDetails?.status === "string"
        ? data.statusDetails.status
        : data?.status;
      if (!stableId(data?.id) || typeof providerStatus !== "string") {
        return ambiguous();
      }
      let submissionState: "authorization_returned" | "submitted";
      try {
        submissionState = submissionStateFromProvider(providerStatus);
      } catch {
        return ambiguous(data.id, providerStatus);
      }
      return Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.PAYMENT_SUBMISSION,
        provider: "yapily-connect",
        execution_id: request.prepared.execution_id,
        intent_hash: request.prepared.intent_hash,
        outcome: "pending",
        state: submissionState,
        provider_payment_id: data.id,
        provider_status: providerStatus,
        idempotency_key: request.idempotency_key,
        submitted_at: submittedAt,
        safe_to_retry: false,
      });
    },
  });
};
