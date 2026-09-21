import { Router } from "express";
import * as controller from "./cases.controller.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";

export const casesRoutes = Router();

// POST /api/cases — strictly patient or receptionist (defense in depth: route guard)
casesRoutes.post(
  "/",
  requireAuth,
  requireRole("patient", "receptionist"),
  controller.createCase
);

// GET /api/cases — list cases (server-filtered by caller role)
casesRoutes.get("/", requireAuth, controller.listCases);

// GET /api/cases/:id — single case lookup (row-level ownership enforced in service)
casesRoutes.get("/:id", requireAuth, controller.getCaseById);

// GET /api/cases/:id/report — clinical report retrieval (row-level ownership enforced in service)
casesRoutes.get("/:id/report", requireAuth, controller.getCaseReport);
