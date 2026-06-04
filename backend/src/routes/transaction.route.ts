import { Router } from "express";
import {
  bulkDeleteTransactionController,
  bulkTransactionController,
  createTransactionController,
  deleteTransactionController,
  duplicateTransactionController,
  getAllTransactionController,
  getTransactionByIdController,
  parseStatementController,
  scanReceiptController,
  updateTransactionController,
} from "../controllers/transaction.controller";
import { upload } from "../config/cloudinary.config";
import rateLimit from "express-rate-limit";

const transactionRoutes = Router();

// Tighter caps on the genuinely costly endpoints (per IP). Generous for honest
// use; they stop someone running up the Gemini bill or spamming the free tier.
const aiScanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // Gemini receipt scans — real $ per call
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Receipt-scan limit reached — try again within the hour." },
});
const bulkImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15, // bulk imports
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Bulk-import limit reached — try again within the hour." },
});

transactionRoutes.post("/create", createTransactionController);

transactionRoutes.post(
  "/scan-receipt",
  aiScanLimiter,
  upload.single("receipt"),
  scanReceiptController
);

transactionRoutes.post(
  "/parse-statement",
  aiScanLimiter, // Gemini call — same cost guard as receipt scan
  parseStatementController
);

transactionRoutes.post(
  "/bulk-transaction",
  bulkImportLimiter,
  bulkTransactionController
);

transactionRoutes.put("/duplicate/:id", duplicateTransactionController);
transactionRoutes.put("/update/:id", updateTransactionController);

transactionRoutes.get("/all", getAllTransactionController);
transactionRoutes.get("/:id", getTransactionByIdController);
transactionRoutes.delete("/delete/:id", deleteTransactionController);
transactionRoutes.delete("/bulk-delete", bulkDeleteTransactionController);

export default transactionRoutes;
