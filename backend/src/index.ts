import "dotenv/config";
import "./config/passport.config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import passport from "passport";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Env } from "./config/env.config";
import { HTTPSTATUS } from "./config/http.config";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import { asyncHandler } from "./middlewares/asyncHandler.middleware";
import connectDatabase from "./config/database.config";
import authRoutes from "./routes/auth.route";
import { passportAuthenticateJwt } from "./config/passport.config";
import userRoutes from "./routes/user.route";
import transactionRoutes from "./routes/transaction.route";
import { initializeCrons } from "./cron";
import reportRoutes from "./routes/report.route";
import { getDateRange } from "./utils/date";
import { logger } from "./utils/logger";
import analyticsRoutes from "./routes/analytics.route";
import planRoutes from "./routes/plan.route";
import { getMyPlanController } from "./controllers/plan.controller";
import accountRoutes from "./routes/account.route";
import connectRoutes from "./routes/connect.route";
import valuationRoutes from "./routes/valuation.route";
import walletRoutes from "./routes/wallet.route";

const app = express();
const BASE_PATH = Env.BASE_PATH;

// Behind a host/proxy (Fly, etc.) trust the first hop so express-rate-limit keys
// by the real client IP, not the proxy's — makes the usage caps actually work.
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(passport.initialize());

// Usage limits — the floor of "limited usage, no loophole for exploit".
// Generous for honest use; caps abuse (auth brute-force + runaway AI/upload
// spend) per IP. Tune per-endpoint (esp. the AI scan + bulk import) next.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // generous baseline per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests — please slow down and try again shortly." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // tight: login/register brute-force guard
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many auth attempts — please wait a few minutes." },
});
app.use(globalLimiter);

app.use(
  cors({
    origin: Env.FRONTEND_ORIGIN.includes(',') 
      ? Env.FRONTEND_ORIGIN.split(',').map(origin => origin.trim())
      : Env.FRONTEND_ORIGIN,
    credentials: true
  })
);

app.get(
  "/",
  asyncHandler(async (_req: Request, res: Response, _next: NextFunction) => {
    res.status(HTTPSTATUS.OK).json({
      status: "ok",
      service: "cashloom-api",
    });
  })
);

app.use(`${BASE_PATH}/auth`, authLimiter, authRoutes);
app.use(`${BASE_PATH}/user`, passportAuthenticateJwt, userRoutes);
app.use(`${BASE_PATH}/transaction`, passportAuthenticateJwt, transactionRoutes);
app.use(`${BASE_PATH}/account`, passportAuthenticateJwt, accountRoutes);
app.use(`${BASE_PATH}/connect`, passportAuthenticateJwt, connectRoutes);
app.use(`${BASE_PATH}/report`, passportAuthenticateJwt, reportRoutes);
app.use(`${BASE_PATH}/analytics`, passportAuthenticateJwt, analyticsRoutes);

// Public plans endpoint (no auth — the pricing page).
app.get(`${BASE_PATH}/plans`, planRoutes);

// Authenticated: current user plan + usage.
userRoutes.get("/plan", getMyPlanController);
// Auth lives AT THE MOUNT (house invariant) — the route file itself carries
// no auth, so it is only ever reachable behind the JWT gate attached here.
app.use(`${BASE_PATH}/valuation`, passportAuthenticateJwt, valuationRoutes);
app.use(`${BASE_PATH}/wallet`, passportAuthenticateJwt, walletRoutes);

app.use(errorHandler);

app.listen(Env.PORT, async () => {
  await connectDatabase();

  // Crons drive recurring transactions + monthly reports. Previously gated to
  // "development", so both scheduled features were silently dead in production.
  // (If scaled to multiple instances, guard the recurrence job with an
  // idempotency check — see ROADMAP high-value bet #2.)
  if (Env.NODE_ENV !== "test") {
    await initializeCrons();
  }

  logger.info(`Server is running on port ${Env.PORT} in ${Env.NODE_ENV} mode`);
});
