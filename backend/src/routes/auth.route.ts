import { Router } from "express";
import {
  forgotPasswordController,
  loginController,
  logoutController,
  registerController,
  resetPasswordController,
} from "../controllers/auth.controller";

const authRoutes = Router();

authRoutes.post("/register", registerController);
authRoutes.post("/login", loginController);
// Both inherit the app-level authLimiter on /auth (brute-force / spam guard).
authRoutes.post("/forgot-password", forgotPasswordController);
authRoutes.post("/logout", logoutController);
authRoutes.post("/reset-password", resetPasswordController);

export default authRoutes;
