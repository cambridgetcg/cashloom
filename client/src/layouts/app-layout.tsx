import Navbar from "@/components/navbar";
import { Outlet, useLocation } from "react-router-dom";
import { useEffect } from "react";
import EditTransactionDrawer from "@/components/transaction/edit-transaction-drawer";
import { PROTECTED_ROUTES } from "@/routes/common/routePath";

// Each screen names itself in the browser tab — clear for people and agents.
const PAGE_TITLES: Record<string, string> = {
  [PROTECTED_ROUTES.OVERVIEW]: "Overview",
  [PROTECTED_ROUTES.TRANSACTIONS]: "Transactions",
  [PROTECTED_ROUTES.REPORTS]: "Reports",
  [PROTECTED_ROUTES.SETTINGS]: "Settings",
  [PROTECTED_ROUTES.SETTINGS_APPEARANCE]: "Appearance",
};

const AppLayout = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const page = PAGE_TITLES[pathname];
    document.title = page ? `${page} · CashLoom` : "CashLoom";
  }, [pathname]);

  return (
    <>
      <div className="min-h-screen pb-10">
        <Navbar />
        <main className="w-full max-w-full">
          <Outlet />
        </main>
      </div>
      <EditTransactionDrawer />
    </>
  );
};

export default AppLayout;
