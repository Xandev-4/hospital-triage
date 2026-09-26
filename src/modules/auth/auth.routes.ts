import { Router } from "express";
import * as controller from "./auth.controller.js";
import { requireAuth } from "./auth.middleware.js";
import {
  authRateLimiter,
  registerRateLimiter,
} from "../../shared/middleware/rate-limiter.middleware.js";

export const authRoutes = Router();

authRoutes.post("/register", registerRateLimiter, controller.register);
authRoutes.post("/login", authRateLimiter, controller.login);
authRoutes.post("/logout", controller.logout);
authRoutes.get("/me", requireAuth, controller.me);
