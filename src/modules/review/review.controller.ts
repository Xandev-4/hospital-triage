import type { Request, Response } from "express";
import * as reviewService from "./review.service.js";

/**
 * GET /api/cases/:id/review
 * Doctor-only: Retrieves case review superset (report, missing-info, disagreement).
 */
export async function getCaseForReview(
  req: Request,
  res: Response
): Promise<void> {
  const id = req.params.id as string;
  const result = await reviewService.getCaseForReview(id, req.user!);
  res.status(200).json(result);
}

/**
 * PATCH /api/cases/:id/edit
 * Doctor-only: Non-destructively inserts a new report version row (doctor_edit).
 */
export async function editReport(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const result = await reviewService.editReport(id, req.body, req.user!);
  res.status(200).json(result);
}

/**
 * PATCH /api/cases/:id/risk-level
 * Doctor-only: Overrides case risk level with required justification reason.
 */
export async function overrideRiskLevel(
  req: Request,
  res: Response
): Promise<void> {
  const id = req.params.id as string;
  const { risk_level, reason } = req.body;
  const result = await reviewService.overrideRiskLevel(
    id,
    risk_level,
    reason,
    req.user!
  );
  res.status(200).json(result);
}

/**
 * POST /api/cases/:id/approve
 * Doctor-only: Transitions case from 'queued' to 'assigned'.
 */
export async function approveCase(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const result = await reviewService.approveCase(id, req.user!);
  res.status(200).json(result);
}

/**
 * POST /api/cases/:id/close
 * Doctor-only: Transitions case from 'assigned' to 'closed'.
 */
export async function closeCase(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const result = await reviewService.closeCase(id, req.user!);
  res.status(200).json(result);
}
