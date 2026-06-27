import { apiClient } from "@/app/api-client";

export interface PlanInfo {
  id: string;
  name: string;
  tagline: string;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  highlights: string[];
}

export interface PlanUsageItem {
  used: number;
  limit: number | null;
}

export interface MyPlanResponse {
  plan: string;
  planName: string;
  tagline: string;
  priceMonthly: number;
  limits: Record<string, number | string | null>;
  usage: {
    aiImports: PlanUsageItem;
    scans: PlanUsageItem;
    imports: PlanUsageItem;
    accounts: PlanUsageItem;
  };
  checkoutUrl: string | null;
}

export const planApi = apiClient.injectEndpoints({
  endpoints: (builder) => ({
    getPlans: builder.query<PlanInfo[], void>({
      query: () => "/plans",
    }),
    getMyPlan: builder.query<MyPlanResponse, void>({
      query: () => "/user/plan",
    }),
  }),
});

export const { useGetPlansQuery, useGetMyPlanQuery } = planApi;
