import { Loader, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSyncAllAccountsMutation } from "@/features/account/accountAPI";

const SyncAllButton = () => {
  const [syncAllAccounts, { isLoading }] = useSyncAllAccountsMutation();

  const handleSyncAll = () => {
    syncAllAccounts()
      .unwrap()
      .then((res) => {
        const results = res.results ?? [];
        if (results.length === 0) {
          toast.info("No connector-backed accounts to sync");
          return;
        }

        const succeeded = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);

        if (succeeded.length > 0) {
          const imported = succeeded.reduce(
            (sum, r) => sum + (r.imported ?? 0),
            0
          );
          toast.success(
            `Synced ${succeeded.length} account${
              succeeded.length === 1 ? "" : "s"
            } · ${imported} transaction${imported === 1 ? "" : "s"} imported`
          );
        }

        // A sync that carried warnings withheld money data (balance not
        // written, precision skips) — surface each one so a sweep that
        // dropped data never looks identical to a clean sweep.
        succeeded
          .filter((s) => s.warnings && s.warnings.length > 0)
          .forEach((s) => {
            toast.warning(`${s.displayName}: synced with warnings`, {
              description: s.warnings!.join("\n"),
              duration: 10000,
            });
          });

        // One failing account doesn't abort the rest — surface each failure
        // (the API guarantees error is a safe message, never a credential).
        failed.forEach((f) => {
          toast.error(`${f.displayName}: ${f.error || "sync failed"}`);
        });
      })
      .catch((error) => {
        toast.error(error.data?.message || "Failed to sync accounts");
      });
  };

  return (
    <Button
      variant="outline"
      className="!shadow-none !cursor-pointer !border-gray-500
       !text-white !bg-transparent"
      disabled={isLoading}
      onClick={handleSyncAll}
    >
      {isLoading ? (
        <Loader className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCwIcon className="h-4 w-4" />
      )}
      {isLoading ? "Syncing…" : "Sync all"}
    </Button>
  );
};

export default SyncAllButton;
