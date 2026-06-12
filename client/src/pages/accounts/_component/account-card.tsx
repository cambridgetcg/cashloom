import { formatDistanceToNow } from "date-fns";
import { Loader, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSyncAccountMutation } from "@/features/account/accountAPI";
import { AccountType } from "@/features/account/accountType";
import { formatMinor } from "@/features/account/format-minor";

const AccountCard = ({ account }: { account: AccountType }) => {
  const [syncAccount, { isLoading: isSyncing }] = useSyncAccountMutation();

  // Only connector-backed accounts can sync — manual ones have no connector.
  const isConnectorBacked = !!account.connectorType;
  const isArchived = account.status === "ARCHIVED";
  const isNegative = account.balanceMinor.trim().startsWith("-");

  const handleSync = () => {
    syncAccount(account._id)
      .unwrap()
      .then((res) => {
        const { imported, skipped, warnings } = res.result;
        const summary =
          skipped > 0
            ? `${account.displayName} synced · ${imported} imported, ${skipped} skipped`
            : `${account.displayName} synced · ${imported} imported`;
        // A sync carrying warnings withheld money data (balance not written,
        // rows skipped for precision) — never show it as a clean success.
        if (warnings && warnings.length > 0) {
          toast.warning(summary, {
            description: warnings.join("\n"),
            duration: 10000,
          });
        } else {
          toast.success(summary);
        }
      })
      .catch((error) => {
        toast.error(error.data?.message || `Failed to sync ${account.displayName}`);
      });
  };

  return (
    <Card className={cn("border shadow-none !gap-0", isArchived && "opacity-60")}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 !pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-[15px] font-medium truncate">
            {account.displayName}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {account.currency}
            {isConnectorBacked && ` · ${account.connectorType}`}
          </p>
        </div>
        <Badge variant={isArchived ? "outline" : "secondary"}>
          {account.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={cn(
            "text-2xl font-bold tabular-nums",
            isNegative && "text-red-500"
          )}
        >
          {formatMinor(account.balanceMinor, account.decimals)}{" "}
          <span className="text-sm font-medium text-muted-foreground">
            {account.currency}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {account.balanceAsOf
              ? `Synced ${formatDistanceToNow(new Date(account.balanceAsOf), {
                  addSuffix: true,
                })}`
              : "Never synced"}
          </p>
          {isConnectorBacked && (
            <Button
              size="sm"
              variant="outline"
              className="!cursor-pointer"
              disabled={isSyncing}
              onClick={handleSync}
            >
              {isSyncing ? (
                <Loader className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="h-4 w-4" />
              )}
              {isSyncing ? "Syncing…" : "Sync"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default AccountCard;
