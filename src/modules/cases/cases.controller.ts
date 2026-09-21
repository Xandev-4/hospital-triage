import type { Request, Response } from "express";
import * as casesService from "./cases.service.js";
import type { CaseStatus } from "./cases.state-machine.js";

export async function createCase(req: Request, res: Response) {
  const result = await casesService.createCase(req.body, req.user!);
  res.status(201).json(result);
}

export async function getCaseById(req: Request, res: Response) {
  const caseId = req.params.id as string;
  const result = await casesService.getCaseById(caseId, req.user!);
  res.status(200).json(result);
}

export async function listCases(req: Request, res: Response) {
  const status = req.query.status as CaseStatus | undefined;
  const result = await casesService.listCases(req.user!, { status });
  res.status(200).json(result);
}
