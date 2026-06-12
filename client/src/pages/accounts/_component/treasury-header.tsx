import { formatDistanceToNow } from "date-fns";
import {
  BanknoteIcon,
  BitcoinIcon,
  ClockIcon,
  CreditCardIcon,
  GiftIcon,
  LandmarkIcon,
  LucideIcon,
  WalletIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useGetAllAccountsQuery,
  useGetNetWorthQuery,
} from "@/features/account/accountAPI";
import { RailType } from "@/features/account/accountType";

// Display order + labels + icons for the rails. Lives here (not in the page
// index) so both the header's per-rail chip strip and the page's section loop
// import it without a circular import (index.tsx already imports this file).
export const RAIL_SECTIONS: {
  rail: RailType;
  label: string;
  Icon: LucideIcon;
}[] = [
  { rail: "STRIPE", label: "Stripe", Icon: CreditCardIcon },
  { rail: "BANK", label: "Bank", Icon: LandmarkIcon },
  { rail: "CRYPTO", label: "Crypto", Icon: BitcoinIcon },
  { rail: "CASH", label: "Cash", Icon: BanknoteIcon },
  { rail: "PLATFORM_CREDIT", label: "Platform credit", Icon: WalletIcon },
  { rail: "GIFT_CARD", label: "Gift cards", Icon: GiftIcon },
];

// Skeleton matches the final card's dimensions so loading → loaded causes no
// layout shift.
const TreasuryHeaderSkeleton = () => (
  <Card className="border shadow-none !gap-0 mb-6">
    <CardHeader className="!pb-3">
      <Skeleton className="h-4 w-24" />
    </CardHeader>
    <CardContent className="space-y-3">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-6 w-72" />
      <Skeleton className="h-3 w-80" />
    </CardContent>
  </Card>
);

// Treasury header: the net-worth total over the accounts page.
//
// RULE — ZERO client money math. Every number shown here is a SERVER-formatted
// string rendered verbatim (totalFormatted, homeValueFormatted). No formatMinor,
// no BigInt, no parseFloat; CountUp/SummaryCard/formatCurrency are number-based
// and forbidden for these wei-safe strings. On any query error the header
// renders nothing and the per-account cards below remain the source of truth.
const TreasuryHeader = () => {
  // isLoading (not isFetching) — page convention: sync-triggered refetches
  // must not flash the skeleton.
  const { data, isLoading, isError } = useGetNetWorthQuery();
  // Cache-shared with the page's own accounts query (same endpoint + tag),
  // so this costs no extra request — used only for the "archived excluded"
  // honesty note.
  const { data: accountsData } = useGetAllAccountsQuery();

  // Gracefully inert: endpoint unavailable (e.g. route not mounted yet) or
  // failing → no header, no error state. The cards below still render.
  if (isError) return null;
  if (isLoading) return <TreasuryHeaderSkeleton />;
  if (!data) return null;

  const { netWorth } = data;
  // Server formatter renders the sign glyph — detect negativity from the
  // minor string only for styling; never prefix another "-".
  const isNegative = netWorth.totalHomeMinor.trim().startsWith("-");
  const hasArchivedAccounts = (accountsData?.accounts ?? []).some(
    (account) => account.status === "ARCHIVED"
  );

  // unconverted[] is one entry PER (rail, currency, decimals) GROUP, so the
  // same unpriced currency held on two rails appears twice. The badge speaks
  // in CURRENCIES — dedupe before counting/listing. First reason wins: the
  // rate layer prices per currency, not per rail, so reasons for one currency
  // are identical across its groups anyway.
  const unpricedByCurrency = new Map<string, string>();
  for (const entry of netWorth.unconverted) {
    if (!unpricedByCurrency.has(entry.currency)) {
      unpricedByCurrency.set(entry.currency, entry.reason);
    }
  }
  const unpricedCount = unpricedByCurrency.size;

  // Honest-degradation timestamp: netWorth.asOf is the moment THIS valuation
  // ran — always "just now" — so showing it under the stale badge would claim
  // freshness exactly when stale quotes are being served. The truthful time is
  // the quote's own rateAsOf (preserved through the serve-stale path); show
  // the OLDEST one among the stale groups so the claim is never fresher than
  // the data behind it.
  const oldestStaleRateAsOf = netWorth.groups
    .filter((group) => group.rateStale && group.rateAsOf !== null)
    .map((group) => group.rateAsOf as string)
    .reduce<string | null>(
      (oldest, rateAsOf) =>
        oldest === null || new Date(rateAsOf) < new Date(oldest)
          ? rateAsOf
          : oldest,
      null
    );

  // Per-rail chips, in page section order, only for rails present.
  const railChips = RAIL_SECTIONS.flatMap(({ rail, label, Icon }) => {
    const entry = netWorth.byRail.find((item) => item.rail === rail);
    return entry ? [{ rail, label, Icon, entry }] : [];
  });

  return (
    <Card className="border shadow-none !gap-0 mb-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 !pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Net worth
        </CardTitle>
        <div className="flex items-center gap-2">
          {!netWorth.complete && (
            <Badge
              className="border-transparent bg-amber-100 text-amber-800"
              title={[...unpricedByCurrency.entries()]
                .map(([currency, reason]) => `${currency}: ${reason}`)
                .join("\n")}
            >
              Partial — {unpricedCount}{" "}
              {unpricedCount === 1 ? "currency" : "currencies"} unpriced
            </Badge>
          )}
          {netWorth.stale && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ClockIcon className="h-3.5 w-3.5" />
              rates as of{" "}
              {formatDistanceToNow(
                new Date(oldestStaleRateAsOf ?? netWorth.asOf),
                { addSuffix: true }
              )}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className={cn(
            "text-3xl font-bold tabular-nums",
            isNegative && "text-red-500"
          )}
        >
          {netWorth.totalFormatted}{" "}
          <span className="text-base font-medium text-muted-foreground">
            {netWorth.home}
          </span>
        </div>

        {railChips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {railChips.map(({ rail, label, Icon, entry }) => (
              <div
                key={rail}
                className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs tabular-nums"
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{entry.homeValueFormatted}</span>
                <span className="text-muted-foreground">
                  ({entry.accountCount})
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-0.5">
          <p className="text-xs text-gray-400">{netWorth.disclaimer}</p>
          {hasArchivedAccounts && (
            <p className="text-xs text-muted-foreground">
              archived accounts excluded
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default TreasuryHeader;
