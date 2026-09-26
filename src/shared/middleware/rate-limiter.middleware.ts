import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError.js";

/**
 * 1. Auth Rate Limiter (POST /api/auth/login specifically)
 *
 * Dedicated Brute-Force Defense:
 * - 5 attempts per 15 minutes per IP address.
 * - Keyed by IP (req.ip) because pre-auth requests do not have an authenticated req.user yet.
 * - Uses `skipSuccessfulRequests: true` so legitimate successful logins (200 OK) do not consume
 *   the brute-force budget, while repeated failed password attempts trigger 429 lockout.
 * - Returns a generic 429 error without disclosing exact remaining seconds or counters.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 failed attempts per window per IP
  standardHeaders: true, // Return standard RateLimit-* headers
  legacyHeaders: false, // Disable legacy X-RateLimit-* headers
  skipSuccessfulRequests: true, // Only count failed attempts (e.g. 401 wrong password)
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      AppError.rateLimitExceeded(
        "Too many login attempts. Please try again later."
      )
    );
  },
});

/**
 * 2. Registration Rate Limiter (POST /api/auth/register specifically)
 *
 * Anti-Abuse & Bot Account Flooding Defense:
 * - 10 registrations per hour per IP address.
 * - Keyed by IP because registration callers are unauthenticated.
 * - Prevents malicious mass creation of fake patient and user records.
 */
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 account registrations per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    return ipKeyGenerator(req.ip || "127.0.0.1");
  },
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      AppError.rateLimitExceeded(
        "Too many accounts created from this IP. Please try again later."
      )
    );
  },
});

/**
 * 3. Case Creation Rate Limiter (POST /api/cases specifically)
 *
 * Cost & Budget Defense for AI / OCR Pipeline:
 * - 20 submissions per hour per authenticated user account.
 * - Keyed by `req.user.id` (runs after `requireAuth`), falling back to `req.ip`.
 * - Prevents a single compromised or spamming user account from consuming upstream API budgets.
 * - Returns a generic 429 error without leaking excessive timing metadata.
 */
export const caseCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 requests per hour per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.user?.id) {
      return req.user.id;
    }
    return ipKeyGenerator(req.ip || "127.0.0.1");
  },
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      AppError.rateLimitExceeded(
        "Case creation limit reached. Please try again later."
      )
    );
  },
});

/**
 * 4. File Upload Rate Limiter (POST /api/cases/:id/upload specifically)
 *
 * Disk I/O & Compute Resource Protection:
 * - 20 file uploads per hour per authenticated user account.
 * - Placed before Multer disk storage and MIME validation to eliminate disk writes from spammers.
 * - Keyed by `req.user.id`.
 */
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 uploads per hour per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.user?.id) {
      return req.user.id;
    }
    return ipKeyGenerator(req.ip || "127.0.0.1");
  },
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      AppError.rateLimitExceeded(
        "File upload limit reached. Please try again later."
      )
    );
  },
});

/**
 * 5. Consent Rate Limiter (POST /api/consent specifically)
 *
 * Database Ingestion & State Flooding Defense:
 * - 20 consent submissions per hour per user account.
 * - Keyed by `req.user.id`.
 */
export const consentRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 consent submissions per hour per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    if (req.user?.id) {
      return req.user.id;
    }
    return ipKeyGenerator(req.ip || "127.0.0.1");
  },
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      AppError.rateLimitExceeded(
        "Consent submission limit reached. Please try again later."
      )
    );
  },
});
