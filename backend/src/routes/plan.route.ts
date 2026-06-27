import { Router } from "express";
import { getPlansController, getMyPlanController } from "../controllers/plan.controller";

const planRoutes = Router();

// Public — the pricing page. No auth.
planRoutes.get("/", getPlansController);

export default planRoutes;
