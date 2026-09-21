import type { Request, Response } from "express";
import * as queueService from "./queue.service.js";

/**
 * GET /api/queue
 * Doctor-only endpoint to retrieve the active triage queue.
 *
 * Query params (optional):
 * - status: 'queued' | 'assigned'
 * - risk_level: 'low' | 'medium' | 'high' | 'critical'
 * - sort: 'asc' | 'desc'
 */
export async function getQueue(req: Request, res: Response): Promise<void> {
  const filters: queueService.QueueFilters = {
    status: req.query.status as queueService.QueueStatus | undefined,
    risk_level: req.query.risk_level as queueService.RiskLevel | undefined,
    sort: req.query.sort as "asc" | "desc" | undefined,
  };

  const result = await queueService.getQueue(req.user!, filters);
  res.status(200).json(result);
}
