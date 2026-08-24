/** Read-only Yapily payment status polling. It never creates or retries work. */

import type {
  YapilyPaymentStatus,
  YapilyPaymentStatusObserver,
} from "../open-banking/contracts.ts";
import { OPEN_BANKING_SCHEMA } from "../open-banking/contracts.ts";
import { stableOpenBankingError } from "../open-banking/errors.ts";
import {
  createFixedJsonHttp,
  type FixedJsonHttp,
  type FixedJsonHttpDependencies,
} from "../open-banking/http.ts";

const API_ORIGIN = "https://api.yapily.com";
const APPLICATION_ID_REF = "YAPILY_APPLICATION_ID";
const APPLICATION_SECRET_REF = "YAPILY_APPLICATION_SECRET";

export interface YapilyPaymentStatusObserverDependencies extends FixedJsonHttpDependencies {
  readonly resolve_credential: (reference: string) => string;
  readonly http?: FixedJsonHttp;
  readonly date_now?: () => Date;
}

interface PaymentDetailsResponse {
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

const mapStatus = (statusInput: string): Pick<YapilyPaymentStatus, "state" | "terminal"> => {
  const status = statusInput.toUpperCase();
  if (["COMPLETED", "SETTLED"].includes(status)) return { state: "settled", terminal: true };
  if (["DECLINED", "REJECTED", "CANCELLED"].includes(status)) {
    return { state: "declined", terminal: true };
  }
  if (["FAILED", "ERROR"].includes(status)) return { state: "failed", terminal: true };
  if (["AUTHORIZED", "AUTHORISATION_RETURNED"].includes(status)) {
    return { state: "authorization_returned", terminal: false };
  }
  if (["PENDING", "PROCESSING", "SUBMITTED", "INITIATED"].includes(status)) {
    return { state: "pending", terminal: false };
  }
  throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
};

export const createYapilyPaymentStatusObserver = (
  dependencies: YapilyPaymentStatusObserverDependencies,
): YapilyPaymentStatusObserver => {
  if (typeof dependencies?.resolve_credential !== "function") {
    throw new TypeError("Yapily credential resolver is required.");
  }
  const http = dependencies.http ?? createFixedJsonHttp(dependencies);
  const dateNow = dependencies.date_now ?? (() => new Date());

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

  return Object.freeze({
    async status(
      request: { readonly execution_id: string; readonly provider_payment_id: string },
      signal?: AbortSignal,
    ): Promise<YapilyPaymentStatus> {
      if (
        !request ||
        !stableId(request.execution_id) ||
        !stableId(request.provider_payment_id)
      ) {
        throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
      }
      const id = credential(APPLICATION_ID_REF);
      const secret = credential(APPLICATION_SECRET_REF);
      const response = await http.request<PaymentDetailsResponse>({
        origin: API_ORIGIN,
        path: `/payments/${encodeURIComponent(request.provider_payment_id)}/details`,
        method: "GET",
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`,
        },
        signal,
      });
      const data = response?.data;
      if (!data || data.id !== request.provider_payment_id) {
        throw stableOpenBankingError("OPEN_BANKING_BINDING_MISMATCH");
      }
      const providerStatus = typeof data.statusDetails?.status === "string"
        ? data.statusDetails.status
        : data.status;
      if (typeof providerStatus !== "string") {
        throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
      }
      const isoCode = data.statusDetails?.isoStatus?.code;
      if (isoCode !== undefined && isoCode !== null &&
        (typeof isoCode !== "string" || !/^[A-Z0-9]{1,16}$/.test(isoCode))) {
        throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
      }
      const mapped = mapStatus(providerStatus);
      const observed = dateNow();
      if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
        throw new TypeError("Yapily clock is invalid.");
      }
      return Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.PAYMENT_STATUS,
        provider: "yapily-connect",
        execution_id: request.execution_id,
        provider_payment_id: request.provider_payment_id,
        state: mapped.state,
        provider_status: providerStatus,
        iso_status_code: typeof isoCode === "string" ? isoCode : null,
        observed_at: observed.toISOString(),
        terminal: mapped.terminal,
      });
    },
  });
};
