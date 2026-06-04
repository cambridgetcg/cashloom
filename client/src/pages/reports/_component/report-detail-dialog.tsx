import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";
import { ReportType } from "@/features/report/reportType";

const money = (n: number) =>
  `$${(n ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// Shows the saved content of a past report — the numbers and the AI insights
// that used to be emailed once and thrown away.
const ReportDetailDialog = ({ report }: { report: ReportType }) => {
  const [open, setOpen] = useState(false);
  const { summary, insights } = report;
  const hasContent = Boolean(summary || (insights && insights.length));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        className="font-normal"
        onClick={() => setOpen(true)}
      >
        <Eye className="h-4 w-4" />
        View
      </Button>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{report.period}</DialogTitle>
          <DialogDescription>
            Sent {new Date(report.sentDate).toLocaleDateString()} ·{" "}
            {report.status}
          </DialogDescription>
        </DialogHeader>

        {!hasContent ? (
          <p className="text-sm text-muted-foreground">
            No details were saved for this report.
          </p>
        ) : (
          <div className="space-y-5">
            {summary && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-muted-foreground">Income</p>
                    <p className="font-medium text-green-600">
                      {money(summary.income)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Expenses</p>
                    <p className="font-medium text-red-600">
                      {money(summary.expenses)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Balance</p>
                    <p className="font-medium">{money(summary.balance)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Savings rate</p>
                    <p className="font-medium">{summary.savingsRate}%</p>
                  </div>
                </div>

                {summary.topCategories?.length > 0 && (
                  <div>
                    <p className="mb-2 text-sm font-medium">Top spending</p>
                    <div className="space-y-1">
                      {summary.topCategories.map((c, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="capitalize">{c.name}</span>
                          <span className="text-muted-foreground">
                            {money(c.amount)} · {c.percent}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {insights && insights.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">Insights</p>
                <ul className="space-y-1.5">
                  {insights.map((t, i) => (
                    <li
                      key={i}
                      className="flex gap-2 text-sm text-muted-foreground"
                    >
                      <span aria-hidden>•</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ReportDetailDialog;
