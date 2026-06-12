import { Router } from "express";
import rateLimit from "express-rate-limit";
import { netWorthController } from "../controllers/valuation.controller";

const valuationRoutes = Router();

// Per-route cap (per IP) — same pattern as the sync limiters in
// account.route.ts, satisfying the ROADMAP's costly-route rule: net worth
// fans out to free-tier rate APIs (CoinGecko ~10-30 req/min), but the rate
// layer's TTL cache + single-flight make steady-state upstream cost ~zero, so
// this cap exists to stop a looping client from burning the shared quota, not
// to ration honest use.
const netWorthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Net-worth limit reached — try again shortly." },
});

// NO auth in this file BY DESIGN (house invariant): authentication lives at
// the mount — src/index.ts attaches passportAuthenticateJwt when it mounts
// `${BASE_PATH}/valuation`. Until that mount lands this router is deliberately
// dead/unreachable code, so there is never an unauthenticated window.
valuationRoutes.get("/net-worth", netWorthLimiter, netWorthController);

export default valuationRoutes;
