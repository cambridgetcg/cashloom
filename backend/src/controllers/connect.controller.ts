import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import { Env } from "../config/env.config";
import {
  createRequisitionSchema,
  institutionsQuerySchema,
  requisitionIdSchema,
} from "../validators/connect.validator";
import { listInstitutions } from "../connectors/gocardless.connector";
import {
  createRequisitionService,
  getRequisitionService,
} from "../services/connect.service";
import { importGoCardlessAccountsService } from "../services/sync.service";

// GoCardless (Bank Account Data) onboarding — the three-step, read-only dance
// that links a bank and turns it into syncable Accounts:
//   1. GET  /gocardless/institutions?country=gb        → pick the bank
//   2. POST /gocardless/requisitions                    → open `link`, auth
//   3. GET  /gocardless/requisitions/:id                → poll until linked
//      POST /gocardless/requisitions/:id/import         → create the Accounts
// Requisitions are bound to their creating user at step 2 and every poll/import
// is owner-scoped — upstream they are integration-wide, so the user binding
// only exists in our RequisitionModel.

// Default post-auth landing page when the client doesn't pass one: the first
// configured frontend origin (FRONTEND_ORIGIN may be a comma-list).
const defaultRedirectUrl = (): string =>
  Env.FRONTEND_ORIGIN.split(",")[0].trim();

export const listInstitutionsController = asyncHandler(
  async (req: Request, res: Response) => {
    const { country } = institutionsQuerySchema.parse(req.query);

    const institutions = await listInstitutions(country);

    return res.status(HTTPSTATUS.OK).json({
      message: "Institutions fetched successfully",
      institutions,
    });
  }
);

export const createRequisitionController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const body = createRequisitionSchema.parse(req.body);

    const requisition = await createRequisitionService(
      userId,
      body.institutionId,
      body.redirectUrl ?? defaultRedirectUrl()
    );

    // id + link at the top level per the connect contract: open `link` in a
    // browser to authenticate with the bank, keep `id` to poll/import after.
    return res.status(HTTPSTATUS.CREATED).json({
      message: "Requisition created — open the link to authenticate with the bank",
      id: requisition.id,
      link: requisition.link,
    });
  }
);

export const getRequisitionController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const requisitionId = requisitionIdSchema.parse(req.params.id);

    const requisition = await getRequisitionService(userId, requisitionId);

    // status "LN" means linked; accounts then holds the GoCardless account
    // ids ready for /import.
    return res.status(HTTPSTATUS.OK).json({
      message: "Requisition fetched successfully",
      id: requisition.id,
      status: requisition.status,
      accounts: requisition.accounts,
    });
  }
);

export const importRequisitionAccountsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user?._id;
    const requisitionId = requisitionIdSchema.parse(req.params.id);

    const { accounts, skipped } = await importGoCardlessAccountsService(
      userId,
      requisitionId
    );

    return res.status(HTTPSTATUS.CREATED).json({
      message: "Bank accounts imported successfully",
      accounts,
      skipped,
    });
  }
);
