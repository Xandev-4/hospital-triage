/**
 * Per-User / Per-IP Rate Limiting Middleware
 *
 * Implements Cost & Security Safeguards:
 * - Rate-limits case creation and external AI pipeline triggers.
 * - Keyed by authenticated user ID (`req.user.id`) with IP address fallback for unauthenticated requests.
 * - Protects cloud API budget and prevents single-user starvation attacks.
 * - Sets standard RateLimit headers (RateLimit-Limit, RateLimit-Remaining, Retry-After).
 * - Fails with HTTP 429 and clean AppError ('rate_limit_exceeded').
 */

import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError.js";

export interface RateLimiterOptions {
  /** Time window in milliseconds (default: 60,000 ms / 1 minute) */
  windowMs?: number;
  /** Maximum allowed requests per window (default: 15 requests/minute) */
  maxRequests?: number;
  /** Custom error message */
  message?: string;
  /** Key generator (defaults to req.user.id || req.ip) */
  keyGenerator?: (req: Request) => string;
}

interface ClientRecord {
  timestamps: number[];
}

export function createRateLimiter(options: RateLimiterOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 15;
  const message =
    options.message ??
    "Too many requests from this account. Please wait before creating another case.";
  const keyGen =
    options.keyGenerator ??
    ((req: Request) => req.user?.id || req.ip || "unknown");

  const clients = new Map<string, ClientRecord>();

  // Periodic cleanup of expired records every 2 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of clients.entries()) {
      record.timestamps = record.timestamps.filter((t) => now - t < windowMs);
      if (record.timestamps.length === 0) {
        clients.delete(key);
      }
    }
  }, Math.max(windowMs * 2, 60_000));

  // Allow Node to exit cleanly without keeping the timer ref alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const key = keyGen(req);
    const now = Date.now();

    let record = clients.get(key);
    if (!record) {
      record = { timestamps: [] };
      clients.set(key, record);
    }

    // Filter out timestamps outside the active window
    record.timestamps = record.timestamps.filter((t) => now - t < windowMs);

    const count = record.timestamps.length;

    // Set standard RateLimit headers
    res.setHeader("RateLimit-Limit", maxRequests);
    res.setHeader("RateLimit-Remaining", Math.max(0, maxRequests - count - 1));

    if (count >= maxRequests) {
      const oldest = record.timestamps[0] || now;
      const retryAfterMs = Math.max(1000, windowMs - (now - oldest));
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      res.setHeader("Retry-After", retryAfterSec);

      return next(
        AppError.rateLimitExceeded(message, {
          retry_after_seconds: retryAfterSec,
          max_requests: maxRequests,
          window_seconds: Math.ceil(windowMs / 1000),
        })
      );
    }

    record.timestamps.push(now);
    next();
  };
}

/**
 * Default rate limiter for case creation:
 * Allows 15 cases per minute per user.
 */
export const caseCreationRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 15,
  message:
    "Case creation rate limit reached (15 cases per minute). Please wait a moment before submitting.",
});
