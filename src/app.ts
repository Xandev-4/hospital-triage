import express from "express";
import { errorHandler } from "./shared/middleware/error-handler.js";

export const app = express();

// Global Middlewares
app.use(express.json());

// Routes will be mounted here as each module is built:
// app.use("/api/auth", authRoutes);
// app.use("/api/patients", patientsRoutes);
// app.use("/api/consent", consentRoutes);
// app.use("/api/cases", casesRoutes);
// app.use("/api/queue", queueRoutes);
// app.use("/api/review", reviewRoutes);
// app.use("/api/audit", auditRoutes);

// Central Error Handling Middleware (must be registered last)
app.use(errorHandler);
