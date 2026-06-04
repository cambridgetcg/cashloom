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
import analyticsRoutes from "./routes/analytics.route";

const app = express();
const BASE_PATH = Env.BASE_PATH;

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
app.use(`${BASE_PATH}/report`, passportAuthenticateJwt, reportRoutes);
app.use(`${BASE_PATH}/analytics`, passportAuthenticateJwt, analyticsRoutes);

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

  console.log(`Server is running on port ${Env.PORT} in ${Env.NODE_ENV} mode`);
});
