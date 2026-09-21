import type { Request, Response } from "express";
import * as authService from "./auth.service.js";

export async function register(req: Request, res: Response) {
  const result = await authService.register(req.body);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response) {
  const result = await authService.login(req.body);
  res.status(200).json(result);
}

export async function logout(_req: Request, res: Response) {
  res.status(200).json({ ok: true });
}

export async function me(req: Request, res: Response) {
  const result = await authService.getCurrentUser(req.user!.id);
  res.status(200).json(result);
}
