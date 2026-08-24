/**
 * Bounded GoCardless Bank Account Data consent broker.
 *
 * This adapter can create, inspect and revoke AIS requisitions only. It has no
 * payment, mandate or outbound-transfer endpoint. The API and authorization
 * origins are constants, and the redirect URI is fixed at construction, so a
 * caller cannot turn the broker into an SSRF or open-redirect primitive.
 */

import type {
  BankDataConnectionAction,
  BankDataConnectionBroker,
  BankDataConnectionState,
  BankDataConnectionStatus,
  BankDataScope,
  BeginBankDataConnection,
} from "../open-banking/contracts.ts";
import { OPEN_BANKING_SCHEMA } from "../open-banking/contracts.ts";
import { stableOpenBankingError } from "../open-banking/errors.ts";
import {
  createFixedJsonHttp,
  type FixedJsonHttp,
  type FixedJsonHttpDependencies,
} from "../open-banking/http.ts";

const API_ORIGIN = "https://bankaccountdata.gocardless.com";
const AUTHORIZATION_ORIGIN = "https://ob.gocardless.com";
const SECRET_ID_REF = "GOCARDLESS_SECRET_ID";
const SECRET_KEY_REF = "GOCARDLESS_SECRET_KEY";

export interface GoCardlessBankDataBrokerDependencies extends FixedJsonHttpDependencies {
  readonly resolve_credential: (reference: string) => string;
  readonly redirect_uri: string;
  readonly http?: FixedJsonHttp;
  readonly date_now?: () => Date;
}

interface TokenResponse {
  access?: unknown;
  access_expires?: unknown;
}

interface AgreementResponse {
  id?: unknown;
}

interface RequisitionResponse {
  id?: unknown;
  reference?: unknown;
  status?: unknown;
  accounts?: unknown;
  link?: unknown;
}

const stableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const fixedRedirect = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("GoCardless redirect_uri is invalid.");
  }
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
  if (
    (!loopbackHttp && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("GoCardless redirect_uri must be fixed HTTPS or loopback HTTP without query or fragment.");
  }
  return url.href;
};

const exactScopes = (value: readonly BankDataScope[]): readonly BankDataScope[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  const allowed = new Set<BankDataScope>(["balances", "transactions"]);
  if (value.some((scope) => !allowed.has(scope)) || new Set(value).size !== value.length) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  return Object.freeze([...value].sort()) as readonly BankDataScope[];
};

const boundedDays = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= 90;

const validateBegin = (request: BeginBankDataConnection) => {
  if (
    !request ||
    typeof request !== "object" ||
    !stableId(request.connection_id) ||
    !stableId(request.institution_id) ||
    !/^[A-Z]{2}$/.test(request.country) ||
    (request.currency !== "GBP" && request.currency !== "EUR") ||
    !boundedDays(request.access_valid_for_days) ||
    !boundedDays(request.max_historical_days)
  ) {
    throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
  }
  return Object.freeze({ ...request, scopes: exactScopes(request.scopes) });
};

const mapRequisitionState = (status: string): BankDataConnectionState => {
  if (status === "LN") return "linked";
  if (status === "RJ") return "rejected";
  if (status === "EX") return "expired";
  if (["CR", "GC", "UA", "SA", "GA"].includes(status)) return "awaiting_user";
  throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
};

const authorizationUrl = (value: unknown): string => {
  if (typeof value !== "string") {
    throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
  }
  if (
    url.origin !== AUTHORIZATION_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
  }
  return url.href;
};

const accountRefs = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 256 || value.some((entry) => !stableId(entry))) {
    throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
  }
  return Object.freeze([...new Set(value as string[])].sort());
};

export const createGoCardlessBankDataBroker = (
  dependencies: GoCardlessBankDataBrokerDependencies,
): BankDataConnectionBroker => {
  if (typeof dependencies?.resolve_credential !== "function") {
    throw new TypeError("GoCardless credential resolver is required.");
  }
  const redirectUri = fixedRedirect(dependencies.redirect_uri);
  const http = dependencies.http ?? createFixedJsonHttp(dependencies);
  const dateNow = dependencies.date_now ?? (() => new Date());
  let cachedToken: { value: string; expires_at_ms: number } | null = null;
  let tokenFlight: Promise<string> | null = null;

  const nowIso = (): string => {
    const value = dateNow();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("GoCardless clock is invalid.");
    }
    return value.toISOString();
  };

  const credential = (reference: typeof SECRET_ID_REF | typeof SECRET_KEY_REF): string => {
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

  const token = async (signal?: AbortSignal): Promise<string> => {
    const now = dateNow().getTime();
    if (cachedToken && cachedToken.expires_at_ms - now > 60_000) return cachedToken.value;
    if (tokenFlight) return tokenFlight;
    tokenFlight = (async () => {
      const data = await http.request<TokenResponse>({
        origin: API_ORIGIN,
        path: "/api/v2/token/new/",
        method: "POST",
        body: {
          secret_id: credential(SECRET_ID_REF),
          secret_key: credential(SECRET_KEY_REF),
        },
        signal,
      });
      if (
        typeof data?.access !== "string" ||
        data.access.length < 16 ||
        typeof data.access_expires !== "number" ||
        !Number.isSafeInteger(data.access_expires) ||
        data.access_expires < 60 ||
        data.access_expires > 31_536_000
      ) {
        throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
      }
      cachedToken = {
        value: data.access,
        expires_at_ms: dateNow().getTime() + data.access_expires * 1_000,
      };
      return data.access;
    })();
    try {
      return await tokenFlight;
    } finally {
      tokenFlight = null;
    }
  };

  const providerRequest = async <T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body: unknown | undefined,
    signal?: AbortSignal,
    allowEmpty = false,
  ): Promise<T> => http.request<T>({
    origin: API_ORIGIN,
    path,
    method,
    headers: { authorization: `Bearer ${await token(signal)}` },
    ...(body === undefined ? {} : { body }),
    signal,
    allow_empty: allowEmpty,
  });

  const statusView = (
    request: { readonly connection_id: string; readonly provider_connection_id: string },
    providerStatus: string,
    accounts: readonly string[],
  ): BankDataConnectionStatus => Object.freeze({
    schema_version: OPEN_BANKING_SCHEMA.CONNECTION_STATUS,
    provider: "gocardless-bank-data",
    connection_id: request.connection_id,
    provider_connection_id: request.provider_connection_id,
    state: mapRequisitionState(providerStatus),
    provider_status: providerStatus,
    account_refs: accounts,
    observed_at: nowIso(),
  });

  const validateConnectionRef = (request: {
    readonly connection_id: string;
    readonly provider_connection_id: string;
  }) => {
    if (!request || !stableId(request.connection_id) || !stableId(request.provider_connection_id)) {
      throw stableOpenBankingError("OPEN_BANKING_INVALID_REQUEST");
    }
    return request;
  };

  return Object.freeze({
    async begin(
      request: BeginBankDataConnection,
      signal?: AbortSignal,
    ): Promise<BankDataConnectionAction> {
      const value = validateBegin(request);
      const started = dateNow();
      if (!Number.isFinite(started.getTime())) throw new TypeError("GoCardless clock is invalid.");
      const agreement = await providerRequest<AgreementResponse>(
        "/api/v2/agreements/enduser/",
        "POST",
        {
          institution_id: value.institution_id,
          max_historical_days: value.max_historical_days,
          access_valid_for_days: value.access_valid_for_days,
          access_scope: value.scopes,
        },
        signal,
      );
      if (!stableId(agreement?.id)) {
        throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
      }
      const requisition = await providerRequest<RequisitionResponse>(
        "/api/v2/requisitions/",
        "POST",
        {
          redirect: redirectUri,
          institution_id: value.institution_id,
          reference: value.connection_id,
          agreement: agreement.id,
        },
        signal,
      );
      if (
        !stableId(requisition?.id) ||
        requisition.status !== "CR" ||
        requisition.reference !== value.connection_id
      ) {
        throw stableOpenBankingError("OPEN_BANKING_PROVIDER_MALFORMED");
      }
      return Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.CONNECTION_ACTION,
        provider: "gocardless-bank-data",
        connection_id: value.connection_id,
        provider_connection_id: requisition.id,
        provider_agreement_id: agreement.id,
        country: value.country,
        currency: value.currency,
        state: "awaiting_user",
        authorization_url: authorizationUrl(requisition.link),
        scopes: value.scopes,
        expires_at: new Date(
          started.getTime() + value.access_valid_for_days * 86_400_000,
        ).toISOString(),
      });
    },

    async status(
      request: { readonly connection_id: string; readonly provider_connection_id: string },
      signal?: AbortSignal,
    ): Promise<BankDataConnectionStatus> {
      const value = validateConnectionRef(request);
      const response = await providerRequest<RequisitionResponse>(
        `/api/v2/requisitions/${encodeURIComponent(value.provider_connection_id)}/`,
        "GET",
        undefined,
        signal,
      );
      if (
        response?.id !== value.provider_connection_id ||
        response.reference !== value.connection_id ||
        typeof response.status !== "string"
      ) {
        throw stableOpenBankingError("OPEN_BANKING_BINDING_MISMATCH");
      }
      return statusView(value, response.status, accountRefs(response.accounts ?? []));
    },

    async revoke(
      request: { readonly connection_id: string; readonly provider_connection_id: string },
      signal?: AbortSignal,
    ): Promise<BankDataConnectionStatus> {
      const value = validateConnectionRef(request);
      const existing = await providerRequest<RequisitionResponse>(
        `/api/v2/requisitions/${encodeURIComponent(value.provider_connection_id)}/`,
        "GET",
        undefined,
        signal,
      );
      if (
        existing?.id !== value.provider_connection_id ||
        existing.reference !== value.connection_id ||
        typeof existing.status !== "string"
      ) {
        throw stableOpenBankingError("OPEN_BANKING_BINDING_MISMATCH");
      }
      await providerRequest<void>(
        `/api/v2/requisitions/${encodeURIComponent(value.provider_connection_id)}/`,
        "DELETE",
        undefined,
        signal,
        true,
      );
      return Object.freeze({
        schema_version: OPEN_BANKING_SCHEMA.CONNECTION_STATUS,
        provider: "gocardless-bank-data",
        connection_id: value.connection_id,
        provider_connection_id: value.provider_connection_id,
        state: "revoked",
        provider_status: "REVOKED",
        account_refs: Object.freeze([]),
        observed_at: nowIso(),
      });
    },
  });
};
