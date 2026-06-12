import mongoose, { Schema, Document } from "mongoose";

// Binds a GoCardless requisition to the user who created it. Upstream,
// requisitions are INTEGRATION-WIDE — the whole deployment authenticates with
// one fixed secret pair, so GoCardless itself cannot tell users apart. Without
// this record, any authenticated user who learned a requisition id could poll
// it and import someone else's bank accounts into their own treasury. Every
// requisition get/import is therefore owner-scoped against this collection —
// the same IDOR closure the account paths enforce.
export interface RequisitionDocument extends Document {
  userId: mongoose.Types.ObjectId;
  requisitionId: string;
  institutionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const requisitionSchema = new Schema<RequisitionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
      index: true,
    },
    // GoCardless's own id for the requisition. Unique: exactly one creator
    // owns a requisition, ever.
    requisitionId: {
      type: String,
      required: true,
      unique: true,
    },
    // Which bank was linked — kept for display/debugging, never trusted.
    institutionId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const RequisitionModel = mongoose.model<RequisitionDocument>(
  "Requisition",
  requisitionSchema
);

export default RequisitionModel;
