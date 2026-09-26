import { Router } from "express";
import * as controller from "./consent.controller.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { consentRateLimiter } from "../../shared/middleware/rate-limiter.middleware.js";

export const consentRoutes = Router();

consentRoutes.post(
  "/",
  requireAuth,
  consentRateLimiter,
  controller.createConsent
);
consentRoutes.get("/:caseId", requireAuth, controller.getConsent);
