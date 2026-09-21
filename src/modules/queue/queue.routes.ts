import { Router } from "express";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import * as queueController from "./queue.controller.js";

export const queueRoutes = Router();

// GET /api/queue
// Doctor-only per api-contract.md §7 & §10.
// no ownership filter: all doctors share the full queue, single-facility V1
queueRoutes.get(
  "/",
  requireAuth,
  requireRole("doctor"),
  queueController.getQueue
);
