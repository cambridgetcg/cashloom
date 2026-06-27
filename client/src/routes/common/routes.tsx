import { lazy } from "react";
import { AUTH_ROUTES, PROTECTED_ROUTES } from "./routePath";

const SignIn = lazy(() => import("@/pages/auth/sign-in"));
const SignUp = lazy(() => import("@/pages/auth/sign-up"));
const ForgotPassword = lazy(() => import("@/pages/auth/forgot-password"));
const ResetPassword = lazy(() => import("@/pages/auth/reset-password"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Accounts = lazy(() => import("@/pages/accounts"));
const Transactions = lazy(() => import("@/pages/transactions"));
const Reports = lazy(() => import("@/pages/reports"));
const Settings = lazy(() => import("@/pages/settings"));
const Account = lazy(() => import("@/pages/settings/account"));
const Appearance = lazy(() => import("@/pages/settings/appearance"));
const Plan = lazy(() => import("@/pages/settings/plan"));
const NotFound = lazy(() => import("@/pages/settings/not-found"));

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
      { index: true, element: <Account /> },
      { path: PROTECTED_ROUTES.SETTINGS, element: <Account /> },
      { path: PROTECTED_ROUTES.SETTINGS_APPEARANCE, element: <Appearance /> },
      { path: PROTECTED_ROUTES.SETTINGS_PLAN, element: <Plan /> },
    ]
  },
];
