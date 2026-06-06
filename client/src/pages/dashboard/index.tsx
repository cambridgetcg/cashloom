import DashboardDataChart from "./dashboard-data-chart";
import DashboardSummary from "./dashboard-summary";
import PageLayout from "@/components/page-layout";
//import ExpenseBreakDown from "./expense-breakdown";
import ExpensePieChart from "./expense-pie-chart";
import DashboardRecentTransactions from "./dashboard-recent-transactions";
import DashboardWelcome from "./_component/dashboard-welcome";
import { useState } from "react";
import { Loader } from "lucide-react";
import { DateRangeType } from "@/components/date-range-select";
import { useGetAllTransactionsQuery } from "@/features/transaction/transactionAPI";

const Dashboard = () => {
  const [dateRange, _setDateRange] = useState<DateRangeType>(null);

  // Is this a brand-new account with no transactions at all? If so, guide them
  // in instead of showing an all-zeros dashboard.
  const { data: txData, isLoading: isCheckingAccount } =
    useGetAllTransactionsQuery({ pageNumber: 1, pageSize: 1 });
  const hasNoTransactions = txData?.pagination?.totalCount === 0;

  if (isCheckingAccount) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (hasNoTransactions) {
    return (
      <div className="flex min-h-[70vh] w-full flex-col">
        <DashboardWelcome />
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col">
      {/* Dashboard Summary Overview */}
      <PageLayout
        className="space-y-6"
        renderPageHeader={
          <DashboardSummary
            dateRange={dateRange}
            setDateRange={_setDateRange}
          />
        }
      >
        {/* Dashboard Main Section */}
        <div className="w-full grid grid-cols-1 lg:grid-cols-6 gap-8">
          <div className="lg:col-span-4">
            <DashboardDataChart dateRange={dateRange} />
          </div>
          <div className="lg:col-span-2">
            <ExpensePieChart dateRange={dateRange} />
          </div>
        </div>
        {/* Dashboard Recent Transactions */}
        <div className="w-full mt-0">
          <DashboardRecentTransactions />
        </div>
      </PageLayout>
    </div>
  );
};

export default Dashboard;
