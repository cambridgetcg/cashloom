import { Outlet, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { AUTH_ROUTES } from "@/routes/common/routePath";

// Auth screens name themselves in the tab too.
const AUTH_TITLES: Record<string, string> = {
  [AUTH_ROUTES.SIGN_IN]: "Sign in",
  [AUTH_ROUTES.SIGN_UP]: "Sign up",
  [AUTH_ROUTES.FORGOT_PASSWORD]: "Forgot password",
  [AUTH_ROUTES.RESET_PASSWORD]: "Reset password",
};

const BaseLayout = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const page = AUTH_TITLES[pathname];
    document.title = page ? `${page} · CashLoom` : "CashLoom";
  }, [pathname]);

  return (
    <div className="flex flex-col w-full h-auto">
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-full mx-auto h-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default BaseLayout;