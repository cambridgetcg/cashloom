import { AUTH_ROUTES, PROTECTED_ROUTES } from "./routePath";
import SignIn from "@/pages/auth/sign-in";
import SignUp from "@/pages/auth/sign-up";
import ForgotPassword from "@/pages/auth/forgot-password";
import ResetPassword from "@/pages/auth/reset-password";
import Dashboard from "@/pages/dashboard";
import Accounts from "@/pages/accounts";
import Transactions from "@/pages/transactions";
import Reports from "@/pages/reports";
import Settings from "@/pages/settings";
import Account from "@/pages/settings/account";
import Appearance from "@/pages/settings/appearance";
import NotFound from "@/pages/settings/not-found";

export const authenticationRoutePaths = [
  { path: AUTH_ROUTES.SIGN_IN, element: <SignIn /> },
  { path: AUTH_ROUTES.SIGN_UP, element: <SignUp /> },
  { path: AUTH_ROUTES.FORGOT_PASSWORD, element: <ForgotPassword /> },
  { path: AUTH_ROUTES.RESET_PASSWORD, element: <ResetPassword /> },
];

export const protectedRoutePaths = [
  { path: PROTECTED_ROUTES.NotFound, element: <NotFound /> },
  { path: PROTECTED_ROUTES.OVERVIEW, element: <Dashboard /> },
  { path: PROTECTED_ROUTES.ACCOUNTS, element: <Accounts /> },
  { path: PROTECTED_ROUTES.TRANSACTIONS, element: <Transactions /> },
  { path: PROTECTED_ROUTES.REPORTS, element: <Reports /> },
  { path: PROTECTED_ROUTES.SETTINGS, 
    element: <Settings /> ,
    children: [
      { index: true, element: <Account /> }, // Default route
      { path: PROTECTED_ROUTES.SETTINGS, element: <Account /> },
      { path: PROTECTED_ROUTES.SETTINGS_APPEARANCE, element: <Appearance /> },
    ]
  },
];
