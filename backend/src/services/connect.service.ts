import mongoose from "mongoose";
import RequisitionModel from "../models/requisition.model";
import {
  createRequisition,
  getRequisition,
  GoCardlessRequisition,
  GoCardlessRequisitionCreated,
} from "../connectors/gocardless.connector";
import { NotFoundException } from "../utils/app-error";

// Requisition ownership for the GoCardless onboarding dance. GoCardless
// authenticates the whole integration with one secret pair, so every
// requisition upstream is reachable with our token regardless of who created
// it — the user binding exists only here, in RequisitionModel, written at
// creation and checked on every subsequent get/import.

export const createRequisitionService = async (
  userId: string,
  institutionId: string,
  redirectUrl: string
): Promise<GoCardlessRequisitionCreated> => {
  const requisition = await createRequisition(institutionId, redirectUrl);

  // Bind the requisition to its creator BEFORE the id is ever handed back to
  // a client: from this point on, only this user can poll or import it.
  await RequisitionModel.create({
    userId: new mongoose.Types.ObjectId(userId),
    requisitionId: requisition.id,
    institutionId,
  });

  return requisition;
};

// Owner-scoped requisition check: a guessed or leaked requisition id must look
// identical to a missing one (the IDOR closure the account paths enforce —
// see getAccountByIdService).
export const assertRequisitionOwnership = async (
  userId: string,
  requisitionId: string
): Promise<void> => {
  const owned = await RequisitionModel.findOne({ requisitionId, userId });
  if (!owned) throw new NotFoundException("Requisition not found");
};

export const getRequisitionService = async (
  userId: string,
  requisitionId: string
): Promise<GoCardlessRequisition> => {
  await assertRequisitionOwnership(userId, requisitionId);
  return getRequisition(requisitionId);
};
