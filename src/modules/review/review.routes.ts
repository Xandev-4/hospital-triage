import { Router } from "express";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import * as reviewController from "./review.controller.js";

export const reviewRoutes = Router({ mergeParams: true });

// All review routes are doctor-only per api-contract.md §7 & §10.
// no ownership filter: all doctors share review capability, single-facility V1
const doctorGuard = [requireAuth, requireRole("doctor")];

// GET /api/cases/:id/review
reviewRoutes.get("/:id/review", doctorGuard, reviewController.getCaseForReview);

// PATCH /api/cases/:id/edit
reviewRoutes.patch("/:id/edit", doctorGuard, reviewController.editReport);

// PATCH /api/cases/:id/risk-level
reviewRoutes.patch(
  "/:id/risk-level",
  doctorGuard,
  reviewController.overrideRiskLevel
);

// POST /api/cases/:id/approve
reviewRoutes.post("/:id/approve", doctorGuard, reviewController.approveCase);

// POST /api/cases/:id/close
reviewRoutes.post("/:id/close", doctorGuard, reviewController.closeCase);
