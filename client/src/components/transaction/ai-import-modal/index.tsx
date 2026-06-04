import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, ChevronLeft, Loader } from "lucide-react";
import { toast } from "sonner";
import {
  useParseStatementMutation,
  useBulkImportTransactionMutation,
} from "@/features/transaction/transactionAPI";
import { ParsedStatementRow } from "@/features/transaction/transationType";

// Paste a bank/card statement or CSV rows → AI reads them into transactions →
// you check the list → save. Nothing is written until you confirm. Saving
// reuses the existing bulk-import endpoint.
const AiImportModal = () => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ParsedStatementRow[] | null>(null);

  const [parseStatement, { isLoading: isParsing }] =
    useParseStatementMutation();
  const [bulkImportTransaction, { isLoading: isSaving }] =
    useBulkImportTransactionMutation();

  const reset = () => {
    setText("");
    setRows(null);
  };

  const handleClose = () => {
    setOpen(false);
    setTimeout(reset, 300);
  };

  const handleParse = () => {
    parseStatement({ text })
      .unwrap()
      .then((res) => {
        if (res.data?.error) {
          toast.error(res.data.error);
          return;
        }
        const found = res.data?.transactions ?? [];
        if (found.length === 0) {
          toast.error("No transactions found — check the text and try again.");
          return;
        }
        setRows(found);
      })
      .catch((error) => {
        toast.error(error.data?.message || "Could not read the statement.");
      });
  };

  const handleSave = () => {
    if (!rows?.length) return;
    const payload = {
      transactions: rows.map((r) => ({
        title: r.title,
        type: r.type,
        amount: r.amount,
        category: r.category,
        description: r.description ?? "",
        date: r.date,
        paymentMethod: r.paymentMethod,
        isRecurring: false,
      })),
    };
    bulkImportTransaction(payload)
      .unwrap()
      .then((res) => {
        const added = res?.insertedCount ?? rows.length;
        const skipped = res?.skippedCount ?? 0;
        toast.success(
          skipped > 0
            ? `Added ${added} · skipped ${skipped} already there`
            : `Added ${added} transactions`
        );
        handleClose();
      })
      .catch((error) => {
        toast.error(error.data?.message || "Failed to add transactions");
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : handleClose())}
    >
      <Button
        variant="outline"
        className="!shadow-none !cursor-pointer !border-gray-500
         !text-white !bg-transparent"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="!w-5 !h-5" />
        AI Import
      </Button>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from a statement</DialogTitle>
          <DialogDescription>
            Paste rows from a bank or card statement (or CSV). We read them into
            transactions for you to check — nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        {!rows ? (
          <div className="space-y-4">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "Paste your statement here…\n" +
                "2026-05-01  TESCO        -42.10\n" +
                "2026-05-02  SALARY     +2200.00"
              }
              className="min-h-[220px] font-mono text-sm"
              disabled={isParsing}
            />
            <div className="flex justify-end">
              <Button
                onClick={handleParse}
                disabled={isParsing || !text.trim()}
              >
                {isParsing && <Loader className="mr-2 h-4 w-4 animate-spin" />}
                {isParsing ? "Reading…" : "Read transactions"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Found {rows.length} transaction{rows.length === 1 ? "" : "s"}.
              Check them, then add.
            </p>
            <div className="max-h-[300px] overflow-y-auto rounded-md border divide-y">
              {rows.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(r.date).toLocaleDateString()} · {r.category}
                    </p>
                  </div>
                  <span
                    className={
                      r.type === "INCOME"
                        ? "shrink-0 font-medium text-green-600"
                        : "shrink-0 font-medium text-red-600"
                    }
                  >
                    {r.type === "INCOME" ? "+" : "-"}
                    {r.amount.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setRows(null)}
                disabled={isSaving}
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader className="mr-2 h-4 w-4 animate-spin" />}
                {isSaving
                  ? "Adding…"
                  : `Add ${rows.length} transaction${
                      rows.length === 1 ? "" : "s"
                    }`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default AiImportModal;
