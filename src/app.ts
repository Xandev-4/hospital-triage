import express from "express";
import cors from "cors";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { consentRoutes } from "./modules/consent/consent.routes.js";
import { casesRoutes } from "./modules/cases/cases.routes.js";
import { queueRoutes } from "./modules/queue/queue.routes.js";
import { errorHandler } from "./shared/middleware/error-handler.js";
import { env } from "./shared/config/env.js";

export const app = express();

// Global Middlewares
// CORS: Restricted to configured FRONTEND_URL (default http://localhost:5173 for Vite dev server).
// Note: credentials is kept false because the API uses Bearer JWT tokens in Authorization headers,
// not cookies. Avoiding credentials: true minimizes the cross-origin attack surface.
const allowedOrigins = env.frontendUrl
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
  })
);

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

// Non-Diagnostic Clinical Disclaimer (api-contract.md §9)
export const NON_DIAGNOSTIC_DISCLAIMER_TEXT =
  "This system is an automated triage intake assistant and is explicitly non-diagnostic. It organizes information and highlights urgency signals — it never prescribes treatment, never diagnoses, and never replaces a qualified healthcare professional. A licensed medical provider always makes the final clinical decision.";

app.get("/api/disclaimer", (_req, res) => {
  res.status(200).json({ text: NON_DIAGNOSTIC_DISCLAIMER_TEXT });
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
