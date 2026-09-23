import express from "express";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { consentRoutes } from "./modules/consent/consent.routes.js";
import { casesRoutes } from "./modules/cases/cases.routes.js";
import { queueRoutes } from "./modules/queue/queue.routes.js";
import { errorHandler } from "./shared/middleware/error-handler.js";

export const app = express();

// Global Middlewares
// Explicit payload limit to prevent unbounded JSON/body request exhaustion
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// SECURITY ARCHITECTURE:
// The 'uploads/' directory is purposely NEVER served statically (no express.static('uploads')).
// Serving patient uploads directly would bypass authentication and expose PHI.
// Any file retrieval must go through an authenticated, role-verified endpoint.

// Health Check
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Feature Routes
app.use("/api/auth", authRoutes);
app.use("/api/consent", consentRoutes);
app.use("/api/cases", casesRoutes);
app.use("/api/queue", queueRoutes);
// app.use("/api/patients", patientsRoutes);
// app.use("/api/review", reviewRoutes);
// app.use("/api/audit", auditRoutes);

// Central Error Handling Middleware (must be registered last)
app.use(errorHandler);
