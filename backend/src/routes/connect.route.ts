import { Router } from "express";
import {
  createRequisitionController,
  getRequisitionController,
  importRequisitionAccountsController,
  listInstitutionsController,
} from "../controllers/connect.controller";

const connectRoutes = Router();

// GoCardless bank-linking. Everything here is read-only onboarding: list
// banks, create a requisition (hosted auth link), poll it, then import the
// linked account ids as BANK Accounts. No money movement surface exists.
connectRoutes.get("/gocardless/institutions", listInstitutionsController);
connectRoutes.post("/gocardless/requisitions", createRequisitionController);
connectRoutes.get("/gocardless/requisitions/:id", getRequisitionController);
connectRoutes.post(
  "/gocardless/requisitions/:id/import",
  importRequisitionAccountsController
);

export default connectRoutes;
