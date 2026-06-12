import { Router } from "express";
import {
  createAccountController,
  getAccountByIdController,
  getAllAccountsController,
  updateAccountController,
} from "../controllers/account.controller";

const accountRoutes = Router();

// An Account is a labelled balance container on a rail — creating/updating one
// is metadata, not money movement (no funds live here). Read paths are the
// Phase-1 "see all the money in one place" surface.
accountRoutes.post("/create", createAccountController);
accountRoutes.put("/update/:id", updateAccountController);

accountRoutes.get("/all", getAllAccountsController);
accountRoutes.get("/:id", getAccountByIdController);

export default accountRoutes;
