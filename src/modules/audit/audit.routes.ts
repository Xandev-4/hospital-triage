import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import * as auditController from "./audit.controller.js";

export const auditRoutes = Router();

/**
 * GET /api/cases/:id/audit
 * Append-only audit trail for one case (api-contract.md §8).
 *
 * STRICT ARCHITECTURAL CONSTRAINT:
 * Query-only route. There is NO write endpoint (POST, PUT, PATCH, DELETE) anywhere
 * in this module or across the API for audit logs.
 * Audit rows are written server-side exclusively as side effects of domain state transitions.
 */
auditRoutes.get("/:id/audit", requireAuth, auditController.getCaseAuditTrail);
