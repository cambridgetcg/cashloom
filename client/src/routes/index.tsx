import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import {
  authenticationRoutePaths,
  protectedRoutePaths,
} from "./common/routes";
import AppLayout from "@/layouts/app-layout";
import BaseLayout from "@/layouts/base-layout";
import AuthRoute from "./authRoute";
import ProtectedRoute from "./protectedRoute";
import useAuthExpiration from "@/hooks/use-auth-expiration";
import useSyncCurrency from "@/hooks/use-sync-currency";

function AppRoutes() {
  useAuthExpiration();
  useSyncCurrency();
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>}>
      <Routes>
        <Route path="/" element={<AuthRoute />}>
          <Route element={<BaseLayout />}>
            {authenticationRoutePaths.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.element}
              />
            ))}
          </Route>
        </Route>
        {/* Protected Route */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            {protectedRoutePaths.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.element}
              >
                {route.children?.map((childRoute) => (
                  <Route
                    key={childRoute.path || 'index'}
                    index={childRoute.index}
                    path={childRoute.path}
                    element={childRoute.element}
                  />
                ))}
              </Route>
            ))}
          </Route>
        </Route>
        {/* Catch-all for undefined routes */}
        <Route path="*" element={<>404</>} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRoutes;