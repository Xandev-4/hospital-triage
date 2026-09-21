import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../shared/config/env.js";
import { AppError } from "../../shared/utils/AppError.js";

export type UserRole = "patient" | "receptionist" | "doctor";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(AppError.unauthorized());
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret) as {
      sub: string;
      role: UserRole;
    };
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch {
    return next(AppError.unauthorized());
  }
}

export function requireRole(...allowedRoles: (UserRole | string)[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(AppError.forbidden());
    }
    return next();
  };
}
