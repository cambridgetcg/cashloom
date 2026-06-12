import { apiClient } from "@/app/api-client";
import {
  CreateAccountBody,
  CreateAccountResponse,
  GetAllAccountsResponse,
  SyncAccountResponse,
  SyncAllAccountsResponse,
  UpdateAccountPayload,
  UpdateAccountResponse,
} from "./accountType";

// Register the "accounts" tag on the shared api so syncs can refetch the
// account list. Connector syncs also insert transactions, so sync mutations
// invalidate the existing "transactions" (and "analytics") tags too.
const accountApiClient = apiClient.enhanceEndpoints({
  addTagTypes: ["accounts"],
});

export const accountApi = accountApiClient.injectEndpoints({
  endpoints: (builder) => ({
    getAllAccounts: builder.query<GetAllAccountsResponse, void>({
      query: () => ({
        url: "/account/all",
        method: "GET",
      }),
      providesTags: ["accounts"],
    }),

    createAccount: builder.mutation<CreateAccountResponse, CreateAccountBody>({
      query: (body) => ({
        url: "/account/create",
        method: "POST",
        body,
      }),
      invalidatesTags: ["accounts"],
    }),

    updateAccount: builder.mutation<UpdateAccountResponse, UpdateAccountPayload>(
      {
        query: ({ id, account }) => ({
          url: `/account/update/${id}`,
          method: "PUT",
          body: account,
        }),
        invalidatesTags: ["accounts"],
      }
    ),

    syncAccount: builder.mutation<SyncAccountResponse, string>({
      query: (id) => ({
        url: `/account/sync/${id}`,
        method: "POST",
      }),
      invalidatesTags: ["accounts", "transactions", "analytics"],
    }),

    syncAllAccounts: builder.mutation<SyncAllAccountsResponse, void>({
      query: () => ({
        url: "/account/sync-all",
        method: "POST",
      }),
      invalidatesTags: ["accounts", "transactions", "analytics"],
    }),
  }),
});

export const {
  useGetAllAccountsQuery,
  useCreateAccountMutation,
  useUpdateAccountMutation,
  useSyncAccountMutation,
  useSyncAllAccountsMutation,
} = accountApi;
