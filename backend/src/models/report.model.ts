import mongoose from "mongoose";

export enum ReportStatusEnum {
  SENT = "SENT",
  PENDING = "PENDING",
  FAILED = "FAILED",
  NO_ACTIVITY = "NO_ACTIVITY",
}

export interface ReportTopCategory {
  name: string;
  amount: number;
  percent: number;
}

export interface ReportSummary {
  income: number;
  expenses: number;
  balance: number;
  savingsRate: number;
  topCategories: ReportTopCategory[];
}

export interface ReportDocument extends Document {
  userId: mongoose.Types.ObjectId;
  period: string;
  sentDate: Date;
  status: keyof typeof ReportStatusEnum;
  // The report content, kept so the app can show past reports instead of
  // emailing them once and throwing the (already paid-for) AI insights away.
  summary?: ReportSummary;
  insights?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const topCategorySchema = new mongoose.Schema<ReportTopCategory>(
  {
    name: String,
    amount: Number,
    percent: Number,
  },
  { _id: false }
);

const summarySchema = new mongoose.Schema<ReportSummary>(
  {
    income: Number,
    expenses: Number,
    balance: Number,
    savingsRate: Number,
    topCategories: [topCategorySchema],
  },
  { _id: false }
);

const reportSchema = new mongoose.Schema<ReportDocument>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    period: {
      type: String,
      required: true,
    },
    sentDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ReportStatusEnum),
      default: ReportStatusEnum.PENDING,
    },
    summary: {
      type: summarySchema,
      default: undefined,
    },
    insights: {
      type: [String],
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

const ReportModel = mongoose.model<ReportDocument>("Report", reportSchema);
export default ReportModel;
