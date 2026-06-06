import { Sparkles, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import AiImportModal from "@/components/transaction/ai-import-modal";
import { PROTECTED_ROUTES } from "@/routes/common/routePath";

// Shown on the dashboard when the account has no transactions yet — turns the
// empty "all zeros" landing into a clear first step, leading with the fastest
// path (paste a statement, AI reads it).
const DashboardWelcome = () => {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md border text-center shadow-sm">
        <CardContent className="flex flex-col items-center gap-5 p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold">Welcome to CashLoom 👋</h2>
            <p className="text-sm text-muted-foreground">
              Your dashboard fills in as you add income and expenses. The fastest
              way to start — paste a bank statement and we'll read it for you, no
              typing.
            </p>
          </div>

          <AiImportModal
            trigger={
              <Button size="lg" className="w-full">
                <Sparkles className="mr-2 h-4 w-4" />
                Paste a bank statement
              </Button>
            }
          />

          <Link
            to={PROTECTED_ROUTES.TRANSACTIONS}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Prefer to add them yourself? Go to Transactions
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
};

export default DashboardWelcome;
