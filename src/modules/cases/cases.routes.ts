import { Router, type Request, type Response, type NextFunction } from "express";
import * as controller from "./cases.controller.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { reviewRoutes } from "../review/review.routes.js";
import { upload, uploadCaseFiles } from "../../shared/config/upload.js";
import { db } from "../../shared/config/db.js";
import { triageCases, users } from "../../shared/config/schema.js";
import { eq } from "drizzle-orm";
import { AppError } from "../../shared/utils/AppError.js";

export const casesRoutes = Router();

// POST /api/cases — multipart/form-data carrying text fields + voice/image attachments in one atomic call (Design 1)
casesRoutes.post(
  "/",
  requireAuth,
  requireRole("patient", "receptionist"),
  uploadCaseFiles,
  controller.createCase
);

// GET /api/cases — list cases (server-filtered by caller role)
casesRoutes.get("/", requireAuth, controller.listCases);

// GET /api/cases/:id — single case lookup (row-level ownership enforced in service)
casesRoutes.get("/:id", requireAuth, controller.getCaseById);

// GET /api/cases/:id/report/versions — report version history (doctor-only per api-contract.md §5)
casesRoutes.get(
  "/:id/report/versions",
  requireAuth,
  requireRole("doctor"),
  controller.getReportVersions
);

// GET /api/cases/:id/report — clinical report retrieval (row-level ownership enforced in service)
casesRoutes.get("/:id/report", requireAuth, controller.getCaseReport);

/**
 * Fast pre-flight check running BEFORE Multer middleware.
 * Prevents disk I/O, multipart parsing, and temp file creation if:
 * 1. Case does not exist.
 * 2. Caller does not own / did not create the case.
 * 3. Case is already past intake (assigned, closed, etc.).
 */
async function canUploadToCase(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caseId = req.params.id as string;
    const actor = req.user!;

    const [caseRecord] = await db
      .select({
        id: triageCases.id,
        patientId: triageCases.patientId,
        createdBy: triageCases.createdBy,
        status: triageCases.status,
      })
      .from(triageCases)
      .where(eq(triageCases.id, caseId));

    if (!caseRecord) {
      throw AppError.notFound("Case not found");
    }

    if (actor.role === "patient") {
      const [userRecord] = await db
        .select({ patientId: users.patientId })
        .from(users)
        .where(eq(users.id, actor.id));

      if (!userRecord || userRecord.patientId !== caseRecord.patientId) {
        throw AppError.notFound("Case not found");
      }
    } else if (actor.role === "receptionist") {
      if (caseRecord.createdBy !== actor.id) {
        throw AppError.notFound("Case not found");
      }
    } else {
      throw AppError.forbidden("Unauthorized role for case upload");
    }

    const ALLOWED_UPLOAD_STATUSES = ["submitted", "processing", "manual_fallback"];
    if (!ALLOWED_UPLOAD_STATUSES.includes(caseRecord.status)) {
      throw AppError.invalidStateTransition(
        `Cannot attach upload to case in '${caseRecord.status}' status. Uploads are only accepted while in early intake states (${ALLOWED_UPLOAD_STATUSES.join(", ")}).`,
        {
          current_status: caseRecord.status,
          allowed_statuses: ALLOWED_UPLOAD_STATUSES,
        }
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}

// POST /api/cases/:id/upload — multipart/form-data
// Middleware order strictly enforced:
// 1. requireAuth (verifies JWT)
// 2. requireRole("patient", "receptionist") (blocks unauthorized roles before parsing)
// 3. canUploadToCase (checks existence, ownership, and intake status before disk write)
// 4. upload.single("file") (Multer streams/parses file only for verified requests)
// 5. controller.attachUpload (magic byte deep verification, DB record, audit event)
casesRoutes.post(
  "/:id/upload",
  requireAuth,
  requireRole("patient", "receptionist"),
  canUploadToCase,
  upload.single("file"),
  controller.attachUpload
);

// PATCH /api/cases/:id/manual-fallback — manual fallback submission for failed/low-confidence cases
casesRoutes.patch(
  "/:id/manual-fallback",
  requireAuth,
  requireRole("patient", "receptionist"),
  controller.submitManualFallback
);

// Mount doctor review sub-routes under /api/cases
// GET /:id/review, PATCH /:id/edit, PATCH /:id/risk-level, POST /:id/approve, POST /:id/close
casesRoutes.use("/", reviewRoutes);

