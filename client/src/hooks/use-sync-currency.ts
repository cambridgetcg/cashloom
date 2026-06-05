import { useEffect } from "react";
import { useTypedSelector } from "@/app/hook";
import { setActiveCurrency } from "@/lib/format-currency";

// Keep the app-wide display currency in step with the logged-in user, so every
// formatCurrency call renders their currency without per-site wiring.
const useSyncCurrency = () => {
  const currency = useTypedSelector((s) => s.auth.user?.currency);
  useEffect(() => {
    setActiveCurrency(currency || "USD");
  }, [currency]);
};

export default useSyncCurrency;
