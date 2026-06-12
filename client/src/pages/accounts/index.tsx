import {
  BanknoteIcon,
  BitcoinIcon,
  CreditCardIcon,
  GiftIcon,
  LandmarkIcon,
  LucideIcon,
  PlusIcon,
  WalletIcon,
} from "lucide-react";
import PageLayout from "@/components/page-layout";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetAllAccountsQuery } from "@/features/account/accountAPI";
import { AccountType, RailType } from "@/features/account/accountType";
import AccountCard from "./_component/account-card";
import AddAccountDialog from "./_component/add-account-dialog";
import SyncAllButton from "./_component/sync-all-button";

// Display order + labels for the rail sections.
const RAIL_SECTIONS: { rail: RailType; label: string; Icon: LucideIcon }[] = [
  { rail: "STRIPE", label: "Stripe", Icon: CreditCardIcon },
  { rail: "BANK", label: "Bank", Icon: LandmarkIcon },
  { rail: "CRYPTO", label: "Crypto", Icon: BitcoinIcon },
  { rail: "CASH", label: "Cash", Icon: BanknoteIcon },
  { rail: "PLATFORM_CREDIT", label: "Platform credit", Icon: WalletIcon },
  { rail: "GIFT_CARD", label: "Gift cards", Icon: GiftIcon },
];

const AccountsSkeleton = () => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {[...Array(3)].map((_, i) => (
      <Card key={i} className="border shadow-none !gap-0">
        <CardHeader className="!pb-3">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-3 w-24" />
        </CardContent>
      </Card>
    ))}
  </div>
);

export default function Accounts() {
  // isLoading (not isFetching) so sync-triggered refetches don't swap the
  // cards out for skeletons mid-sync.
  const { data, isLoading, isError } = useGetAllAccountsQuery();

  const accounts = data?.accounts ?? [];
  const byRail = accounts.reduce<Partial<Record<RailType, AccountType[]>>>(
    (groups, account) => {
      (groups[account.rail] ??= []).push(account);
      return groups;
    },
    {}
  );
  const sections = RAIL_SECTIONS.filter(({ rail }) => byRail[rail]?.length);

  return (
    <PageLayout
      title="Accounts"
      subtitle="All your money in one place"
      addMarginTop
      rightAction={
        <div className="flex items-center gap-2">
          <SyncAllButton />
          <AddAccountDialog />
        </div>
      }
    >
      <Card className="border-0 shadow-none">
        <CardContent className="pt-2 space-y-8">
          {isLoading ? (
            <AccountsSkeleton />
          ) : isError ? (
            <EmptyState
              title="Could not load accounts"
              description="Something went wrong fetching your accounts. Please try again."
            />
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center">
              <EmptyState
                icon={WalletIcon}
                title="No accounts yet"
                description="CashLoom pulls every balance — Stripe, banks, crypto, cash floats, platform credits and gift cards — into one treasury view. Start by adding an account."
              />
              <AddAccountDialog
                trigger={
                  <Button className="mt-4 !cursor-pointer !px-6 !text-white">
                    <PlusIcon className="h-4 w-4" />
                    <span>Add account</span>
                  </Button>
                }
              />
            </div>
          ) : (
            sections.map(({ rail, label, Icon }) => (
              <section key={rail} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    {label}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    ({byRail[rail]?.length})
                  </span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {byRail[rail]?.map((account) => (
                    <AccountCard key={account._id} account={account} />
                  ))}
                </div>
              </section>
            ))
          )}
        </CardContent>
      </Card>
    </PageLayout>
  );
}
