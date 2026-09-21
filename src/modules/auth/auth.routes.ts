import { Router } from "express";
import * as controller from "./auth.controller.js";
import { requireAuth } from "./auth.middleware.js";

export const authRoutes = Router();

authRoutes.post("/register", controller.register);
authRoutes.post("/login", controller.login);
authRoutes.post("/logout", controller.logout);
authRoutes.get("/me", requireAuth, controller.me);
