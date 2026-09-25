import type { Request, Response, NextFunction } from "express";
import * as auditService from "./audit.service.js";

/**
 * GET /api/cases/:id/audit
 * Query-only audit trail endpoint per api-contract.md §8.
 * NOTE: There are strictly no write routes in the audit module.
 */
export async function getCaseAuditTrail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caseId = req.params.id as string;
    const actor = req.user!;

    const result = await auditService.getCaseAuditTrail(caseId, {
      id: actor.id,
      role: actor.role,
      patientId: (actor as { patientId?: string | null }).patientId ?? null,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
