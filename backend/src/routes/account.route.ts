import { Router } from "express";
import {
  createAccountController,
  getAccountByIdController,
  getAllAccountsController,
  updateAccountController,
} from "../controllers/account.controller";
import {
  syncAccountController,
  syncAllAccountsController,
} from "../controllers/sync.controller";
import rateLimit from "express-rate-limit";
import { requireQuota } from "../middlewares/quota.middleware";

const accountRoutes = Router();

// Tighter caps on the sync endpoints (per IP) — same pattern as the AI-scan /
// bulk-import limiters. Syncs drive QUOTA-LIMITED and PAID upstream calls:
// GoCardless allows ~4 calls per account per DAY (each sync burns 2) and
// Stripe usage is metered, so the 300/15min global cap alone would let one
// looping client torch every linked account's daily bank-data quota. Generous
// for honest use; a buggy retry loop hits the wall here, not at GoCardless.
const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // single-account syncs
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Sync limit reached — try again within the hour." },
});
const syncAllLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 4, // each sweep hits EVERY connector-backed account
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Sync-all limit reached — try again within the hour." },
});

// An Account is a labelled balance container on a rail — creating/updating one
// is metadata, not money movement (no funds live here). Read paths are the
// Phase-1 "see all the money in one place" surface.
accountRoutes.post("/create", requireQuota("account"), createAccountController);
accountRoutes.put("/update/:id", updateAccountController);

// Sync pulls READS through the rail connectors (balances + transactions in);
// nothing here can move money. sync-all is sequential by design — GoCardless
// rate limits punish parallel hammering.
accountRoutes.post("/sync-all", syncAllLimiter, syncAllAccountsController);
accountRoutes.post("/sync/:id", syncLimiter, syncAccountController);

accountRoutes.get("/all", getAllAccountsController);
accountRoutes.get("/:id", getAccountByIdController);

export default accountRoutes;
