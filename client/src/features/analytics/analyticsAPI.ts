import { apiClient } from "@/app/api-client";
import { ChartAnalyticsResponse, ExpensePieChartBreakdownResponse, FilterParams, SummaryAnalyticsResponse } from "./anayticsType";

export const analyticsApi = apiClient.injectEndpoints({
  endpoints: (builder) => ({
    summaryAnalytics: builder.query<SummaryAnalyticsResponse, FilterParams>({
      query: ({preset, from, to}) => ({
        url: "/analytics/summary",
        method: "GET",
        params: {preset, from, to}
      }),
      providesTags: ["analytics"],
    }),
    chartAnalytics: builder.query<ChartAnalyticsResponse, FilterParams>({
      query: ({preset, from, to}) => ({
        url: "/analytics/chart",
        method: "GET",
        // Send the browser's timezone so the daily chart buckets each
        // transaction on its correct local day, not the UTC day.
        params: {
          preset,
          from,
          to,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
      providesTags: ["analytics"],
    }),
    expensePieChartBreakdown: builder.query<ExpensePieChartBreakdownResponse, FilterParams  >({
      query: ({preset, from, to}) => ({
        url: "/analytics/expense-breakdown",
        method: "GET",
        params: {preset, from, to}
      }),
      providesTags: ["analytics"],
    }),
  }),
});

export const {
  useSummaryAnalyticsQuery,
  useChartAnalyticsQuery,
  useExpensePieChartBreakdownQuery,
} = analyticsApi;
