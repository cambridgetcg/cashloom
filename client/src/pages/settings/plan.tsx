import { useGetPlansQuery, useGetMyPlanQuery } from "@/features/plan/planAPI";
import PageLayout from "@/components/page-layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2 } from "lucide-react";

const UsageBar = ({ used, limit }: { used: number; limit: number | null }) => {
  if (limit === null) {
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{used} used</span>
          <Badge variant="secondary">Unlimited</Badge>
        </div>
      </div>
    );
  }
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{used} / {limit}</span>
        <span className={pct >= 90 ? "text-destructive font-medium" : "text-muted-foreground"}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export default function PlanPage() {
  const { data: plans, isLoading: plansLoading } = useGetPlansQuery();
  const { data: myPlan, isLoading: planLoading } = useGetMyPlanQuery();

  if (plansLoading || planLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PageLayout title="Plan & Usage" subtitle="Fair pricing. No dark patterns. Cancel anytime.">
      {/* Current plan + usage */}
      {myPlan && (
        <Card className="p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold">Your plan: {myPlan.planName}</h3>
              <p className="text-sm text-muted-foreground">{myPlan.tagline}</p>
            </div>
            <Badge variant={myPlan.plan === "PRO" ? "default" : "secondary"}>
              {myPlan.plan === "PRO" ? "Pro" : "Free"}
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium mb-1">Connected accounts</p>
              <UsageBar used={myPlan.usage.accounts.used} limit={myPlan.usage.accounts.limit} />
            </div>
            <div>
              <p className="text-sm font-medium mb-1">AI statement imports</p>
              <UsageBar used={myPlan.usage.aiImports.used} limit={myPlan.usage.aiImports.limit} />
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Receipt scans</p>
              <UsageBar used={myPlan.usage.scans.used} limit={myPlan.usage.scans.limit} />
            </div>
            <div>
              <p className="text-sm font-medium mb-1">CSV / bulk imports</p>
              <UsageBar used={myPlan.usage.imports.used} limit={myPlan.usage.imports.limit} />
            </div>
          </div>
        </Card>
      )}

      {/* Pricing cards */}
      <div className="grid gap-6 md:grid-cols-2">
        {plans?.map((plan) => {
          const isCurrent = myPlan?.plan === plan.id;
          const isPro = plan.id === "PRO";
          return (
            <Card key={plan.id} className={`p-6 flex flex-col ${isPro ? "border-primary ring-2 ring-primary/20" : ""}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xl font-bold">{plan.name}</h3>
                {isCurrent && <Badge>Current</Badge>}
                {isPro && !isCurrent && <Badge variant="default">Best value</Badge>}
              </div>
              <div className="mb-4">
                <span className="text-3xl font-bold">£{plan.priceMonthly}</span>
                <span className="text-muted-foreground">/month</span>
                {plan.priceYearly > 0 && (
                  <span className="text-sm text-muted-foreground ml-2">
                    or £{plan.priceYearly}/year (save 2 months)
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mb-4">{plan.tagline}</p>
              <ul className="space-y-2 flex-grow">
                {plan.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
              {isPro && !isCurrent && (
                <div className="mt-6 pt-4 border-t text-center">
                  <p className="text-xs text-muted-foreground mb-2">
                    Checkout opens when a merchant-of-record is connected.
                    Pro features activate instantly on payment confirmation.
                  </p>
                  <button
                    disabled
                    className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-60 cursor-not-allowed"
                  >
                    Upgrade soon
                  </button>
                </div>
              )}
              {isCurrent && (
                <div className="mt-6 pt-4 border-t">
                  <p className="text-center text-sm text-muted-foreground">
                    You're on this plan. No cancellation maze — downgrade anytime.
                  </p>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </PageLayout>
  );
}
