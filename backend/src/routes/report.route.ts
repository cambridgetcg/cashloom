import { Router } from "express";
import {
  getAllReportsController,
  updateReportSettingController,
} from "../controllers/report.controller";

const reportRoutes = Router();

reportRoutes.get("/all", getAllReportsController);
reportRoutes.put("/update-setting", updateReportSettingController);

export default reportRoutes;
