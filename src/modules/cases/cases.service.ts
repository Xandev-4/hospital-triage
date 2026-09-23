import { and, desc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import {
  auditLog,
  caseReportVersions,
  caseUploads,
  patients,
  triageCases,
  users,
} from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { checkValidConsent } from "../consent/consent.service.js";
import { logAuditEvent } from "../audit/audit-logger.js";
import { cleanupFile } from "../../shared/config/upload.js";
import { processCase } from "../processing/processing.service.js";
import { assertValidTransition, type CaseStatus } from "./cases.state-machine.js";
import type { UserRole } from "../../shared/types/express.d.js";
import type { RiskLevel } from "../processing/rules-engine.js";

const MAX_CHIEF_COMPLAINT_LENGTH = 1000;
const MAX_SYMPTOMS_LENGTH = 5000;
const MAX_DURATION_LENGTH = 100;

export interface CaseActor {
  id: string;
  role: UserRole | string;
}

export interface AttachedFileInput {
  path: string;
  mimetype: string;
  size: number;
  originalname?: string;
}

export interface CreateCaseInput {
  patient_id?: string;
  mode?: "self" | "assisted";
  phone_number?: string;
  chief_complaint: string;
  duration?: string;
  symptoms?: string;
  vitals?: Record<string, unknown>;
  // Multipart attached files (Design 1: text + files in single request)
  voice_file?: AttachedFileInput | null;
  image_file?: AttachedFileInput | null;
  // Test simulation hooks for end-to-end testing
  simulate_low_confidence?: boolean;
  simulate_failure?: boolean;
  simulate_timeout?: boolean;
  simulate_malformed_output?: boolean;
  ai_suggested_risk?: RiskLevel;
}

export interface ListCasesFilters {
  status?: CaseStatus;
}

/**
 * Creates a new triage case with attached multimodal files (Design 1).
 * Validates consent, verifies at least one file ('voice' or 'image') is present,
 * and atomically commits the case row, case_uploads rows, status transition
 * ('submitted' -> 'processing'), and audit events in a single database transaction.
 */
export async function createCase(input: CreateCaseInput, actor: CaseActor) {
  if (actor.role === "doctor") {
    throw AppError.forbidden("Doctors cannot create triage cases");
  }

  let resolvedPatientId: string;
  let mode: "self" | "assisted";

  try {
    if (actor.role === "patient") {
      mode = "self";
      // Resolve patientId strictly from actor.id -> users.patientId
      const [userRecord] = await db
        .select({ patientId: users.patientId })
        .from(users)
        .where(eq(users.id, actor.id));

      if (!userRecord || !userRecord.patientId) {
        throw AppError.notFound("No patient profile linked to this account");
      }
      resolvedPatientId = userRecord.patientId;
    } else if (actor.role === "receptionist") {
      mode = "assisted";
      if (!input.patient_id) {
        throw AppError.validation("patient_id is required for assisted intake");
      }

      const [patientRecord] = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, input.patient_id));

      if (!patientRecord) {
        throw AppError.notFound("Patient not found");
      }
      resolvedPatientId = input.patient_id;
    } else {
      throw AppError.forbidden("Unauthorized role for case creation");
    }

    // 1. Validate consent FIRST — fails closed with 403 consent_required before touching triage_cases
    const activeConsent = await checkValidConsent(resolvedPatientId, mode);

    // 2. Validate that at least one file is attached (text alone is not a complete submission)
    if (!input.voice_file && !input.image_file) {
      throw AppError.validation(
        "At least one file upload ('voice' or 'image') is required for case intake"
      );
    }

    // 3. Validate free-text inputs & enforce length limits
    const chiefComplaint = input.chief_complaint?.trim();
    if (!chiefComplaint) {
      throw AppError.validation("chief_complaint is required");
    }
    if (chiefComplaint.length > MAX_CHIEF_COMPLAINT_LENGTH) {
      throw AppError.validation(
        `chief_complaint exceeds maximum length of ${MAX_CHIEF_COMPLAINT_LENGTH} characters`
      );
    }

    const symptoms = input.symptoms?.trim() || null;
    if (symptoms && symptoms.length > MAX_SYMPTOMS_LENGTH) {
      throw AppError.validation(
        `symptoms exceeds maximum length of ${MAX_SYMPTOMS_LENGTH} characters`
      );
    }

    const duration = input.duration?.trim() || null;
    if (duration && duration.length > MAX_DURATION_LENGTH) {
      throw AppError.validation(
        `duration exceeds maximum length of ${MAX_DURATION_LENGTH} characters`
      );
    }

    // Optional: Update patient contact phone number if provided during intake
    if (input.phone_number?.trim()) {
      await db
        .update(patients)
        .set({ phoneNumber: input.phone_number.trim() })
        .where(eq(patients.id, resolvedPatientId));
    }

    // 2. Atomic Database Transaction:
    // - Insert case row with status 'submitted'
    // - Insert case_uploads row(s) for whichever files arrived
    // - Transition status from 'submitted' -> 'processing' via assertValidTransition
    // - Write audit events (intake_submitted and status_changed)
    // All succeed together or roll back together.
    let createdCase: typeof triageCases.$inferSelect;
    const attachedUploads: (typeof caseUploads.$inferSelect)[] = [];

    await db.transaction(async (tx) => {
      // 2a. Insert case row (initial status 'submitted')
      const [newCase] = await tx
        .insert(triageCases)
        .values({
          patientId: resolvedPatientId,
          createdBy: actor.id,
          consentId: activeConsent.id,
          mode: mode,
          status: "submitted",
          chiefComplaint: chiefComplaint,
          duration: duration,
          symptoms: symptoms,
          vitals: input.vitals ?? null,
        })
        .returning();

      if (!newCase) {
        throw AppError.internal("Failed to create triage case");
      }

      // 2b. Insert upload row(s) for attached files
      if (input.voice_file) {
        const [voiceUpload] = await tx
          .insert(caseUploads)
          .values({
            caseId: newCase.id,
            modality: "voice",
            filePath: input.voice_file.path,
            mimeType: input.voice_file.mimetype,
            fileSize: input.voice_file.size,
          })
          .returning();
        if (voiceUpload) {
          attachedUploads.push(voiceUpload);
        }
      }

      if (input.image_file) {
        const [imageUpload] = await tx
          .insert(caseUploads)
          .values({
            caseId: newCase.id,
            modality: "image_ocr",
            filePath: input.image_file.path,
            mimeType: input.image_file.mimetype,
            fileSize: input.image_file.size,
          })
          .returning();
        if (imageUpload) {
          attachedUploads.push(imageUpload);
        }
      }

      // 2c. Atomic audit event for intake submission
      await tx.insert(auditLog).values({
        caseId: newCase.id,
        actorId: actor.id,
        eventType: "intake_submitted",
        metadata: {
          mode,
          patient_id: resolvedPatientId,
          upload_count: attachedUploads.length,
          modalities: attachedUploads.map((u) => u.modality),
        },
      });

      createdCase = newCase;
    });

    // NOTE (V1 KNOWN ACCEPTED GAP):
    // Cases require at least one upload ('voice' or 'image') during intake.
    // If a case were somehow created without uploads, it would remain in 'submitted'
    // indefinitely in V1. Automated reminders and timeout fallbacks are deferred to V3.

    // 3. Trigger internal-only processing pipeline directly
    let finalStatus: CaseStatus = createdCase!.status;
    try {
      const processResult = await processCase(createdCase!.id, actor, {
        simulateFailure: input.simulate_failure,
        simulateLowConfidence: input.simulate_low_confidence,
        simulateTimeout: input.simulate_timeout,
        simulateMalformedOutput: input.simulate_malformed_output,
        aiSuggestedRisk: input.ai_suggested_risk,
      });
      finalStatus = processResult.status;
    } catch (err) {
      console.error(
        `[Cases Service] Internal processing exception for case ${createdCase!.id}:`,
        err
      );
    }

    // 4. Return minimal safe response per api-contract.md §4
    return {
      case_id: createdCase!.id,
      status: finalStatus,
      consent_id: createdCase!.consentId,
      mode: createdCase!.mode,
      upload_ids: attachedUploads.map((u) => u.id),
    };
  } catch (err) {
    // Transaction failed or validation failed — cleanup disk files
    if (input.voice_file?.path) await cleanupFile(input.voice_file.path);
    if (input.image_file?.path) await cleanupFile(input.image_file.path);
    throw err;
  }
}

/**
 * Retrieves a single case by ID with strict row-level ownership enforcement.
 */
export async function getCaseById(id: string, actor: CaseActor) {
  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, id));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  // Row-level ownership check (anti-enumeration: return 404 if not authorized)
  if (actor.role === "doctor") {
    // Doctors have access to all cases
  } else if (actor.role === "receptionist") {
    if (caseRecord.createdBy !== actor.id) {
      throw AppError.notFound("Case not found");
    }
  } else if (actor.role === "patient") {
    const [userRecord] = await db
      .select({ patientId: users.patientId })
      .from(users)
      .where(eq(users.id, actor.id));

    if (!userRecord || userRecord.patientId !== caseRecord.patientId) {
      throw AppError.notFound("Case not found");
    }
  } else {
    throw AppError.forbidden();
  }

  return {
    case_id: caseRecord.id,
    patient_id: caseRecord.patientId,
    status: caseRecord.status,
    mode: caseRecord.mode,
    case_type: caseRecord.caseType,
    chief_complaint: caseRecord.chiefComplaint,
    duration: caseRecord.duration,
    symptoms: caseRecord.symptoms,
    vitals: caseRecord.vitals,
    risk_level: caseRecord.riskLevel,
    created_at: caseRecord.createdAt.toISOString(),
    updated_at: caseRecord.updatedAt.toISOString(),
  };
}

/**
 * Lists cases filtered by caller role and optional status query param.
 */
export async function listCases(actor: CaseActor, filters?: ListCasesFilters) {
  const conditions = [];

  if (filters?.status) {
    conditions.push(eq(triageCases.status, filters.status));
  }

  if (actor.role === "doctor") {
    // Doctor sees all cases in the queue/system
  } else if (actor.role === "receptionist") {
    // Receptionist sees only cases they created
    conditions.push(eq(triageCases.createdBy, actor.id));
  } else if (actor.role === "patient") {
    // Patient sees only their own cases
    const [userRecord] = await db
      .select({ patientId: users.patientId })
      .from(users)
      .where(eq(users.id, actor.id));

    if (!userRecord || !userRecord.patientId) {
      return { cases: [] };
    }
    conditions.push(eq(triageCases.patientId, userRecord.patientId));
  } else {
    throw AppError.forbidden();
  }

  const query = db
    .select({
      id: triageCases.id,
      status: triageCases.status,
      chiefComplaint: triageCases.chiefComplaint,
      riskLevel: triageCases.riskLevel,
      createdAt: triageCases.createdAt,
    })
    .from(triageCases)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(triageCases.createdAt));

  const rows = await query;

  return {
    cases: rows.map((row) => ({
      case_id: row.id,
      status: row.status,
      chief_complaint: row.chiefComplaint
        ? row.chiefComplaint.length > 100
          ? `${row.chiefComplaint.slice(0, 97)}...`
          : row.chiefComplaint
        : "",
      risk_level: row.riskLevel,
      created_at: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Retrieves the latest clinical report for a case.
 * Enforces row-level ownership and returns anti-enumeration 404 if unauthorized.
 */
export async function getCaseReport(id: string, actor: CaseActor) {
  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, id));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  // Row-level ownership check (anti-enumeration: return 404 if not authorized)
  if (actor.role === "doctor") {
    // Doctors have access to all cases
  } else if (actor.role === "receptionist") {
    if (caseRecord.createdBy !== actor.id) {
      throw AppError.notFound("Case not found");
    }
  } else if (actor.role === "patient") {
    const [userRecord] = await db
      .select({ patientId: users.patientId })
      .from(users)
      .where(eq(users.id, actor.id));

    if (!userRecord || userRecord.patientId !== caseRecord.patientId) {
      throw AppError.notFound("Case not found");
    }
  } else {
    throw AppError.forbidden();
  }

  // Fetch latest version from case_report_versions
  const [latestReport] = await db
    .select()
    .from(caseReportVersions)
    .where(eq(caseReportVersions.caseId, id))
    .orderBy(desc(caseReportVersions.versionNumber))
    .limit(1);

  if (latestReport) {
    const content = latestReport.content as any;
    return {
      case_id: caseRecord.id,
      status: caseRecord.status,
      chief_complaint: content.chief_complaint ?? {
        value: caseRecord.chiefComplaint ?? "",
        source: latestReport.source,
      },
      duration: content.duration ?? {
        value: caseRecord.duration ?? "",
        source: latestReport.source,
      },
      symptoms: content.symptoms ?? {
        value: caseRecord.symptoms ?? "",
        source: latestReport.source,
      },
      vitals: content.vitals ?? {
        value: caseRecord.vitals ?? {},
        source: latestReport.source,
      },
      missing_info: content.missing_info ?? [],
      risk_level: content.risk_level ?? caseRecord.riskLevel,
      ai_rules_disagreement: content.ai_rules_disagreement ?? {
        present: caseRecord.aiRulesDisagreement,
        ai_suggested: null,
        rules_result: caseRecord.riskLevel,
        note: null,
      },
    };
  }

  // Fallback if no version exists yet (e.g. submitted or failed)
  return {
    case_id: caseRecord.id,
    status: caseRecord.status,
    chief_complaint: {
      value: caseRecord.chiefComplaint ?? "",
      source: "manual",
    },
    duration: {
      value: caseRecord.duration ?? "",
      source: "manual",
    },
    symptoms: {
      value: caseRecord.symptoms ?? "",
      source: "manual",
    },
    vitals: {
      value: caseRecord.vitals ?? {},
      source: "manual",
    },
    missing_info: [],
    risk_level: caseRecord.riskLevel ?? null,
    ai_rules_disagreement: {
      present: caseRecord.aiRulesDisagreement,
      ai_suggested: null,
      rules_result: caseRecord.riskLevel,
      note: null,
    },
  };
}

export interface UploadFileInfo {
  path: string;
  mimetype: string;
  size: number;
  originalname?: string;
}

export interface AttachUploadResponse {
  upload_id: string;
  case_id: string;
  modality: "voice" | "image_ocr";
  file_path: string;
}

const ALLOWED_UPLOAD_STATUSES: CaseStatus[] = [
  "submitted",
  "processing",
  "manual_fallback",
];

/**
 * Attaches a voice or image_ocr upload to an existing triage case.
 * Enforces:
 * 1. Allowed modality validation ('voice' | 'image_ocr').
 * 2. File presence validation.
 * 3. Row-level ownership check (anti-enumeration 404 if unauthorized).
 * 4. Early-pipeline status guard (rejects uploads to assigned/closed cases).
 * 5. Insert into case_uploads table.
 * 6. Audit logging ('intake_submitted' with file details).
 * 7. Orphan file cleanup if DB insertion or validation fails.
 */
export async function attachUpload(
  caseId: string,
  modality: "voice" | "image_ocr",
  file: UploadFileInfo,
  actor: CaseActor
): Promise<AttachUploadResponse> {
  // Validate modality parameter
  if (modality !== "voice" && modality !== "image_ocr") {
    if (file?.path) {
      await cleanupFile(file.path);
    }
    throw AppError.validation(
      "Invalid modality. Allowed values: 'voice', 'image_ocr'",
      { provided_modality: modality }
    );
  }

  // Validate uploaded file information
  if (!file || !file.path) {
    throw AppError.validation("Uploaded file is required");
  }

  try {
    // 1. Fetch case record
    const [caseRecord] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, caseId));

    if (!caseRecord) {
      throw AppError.notFound("Case not found");
    }

    // 2. Row-level ownership check (anti-enumeration pattern)
    if (actor.role === "doctor") {
      throw AppError.forbidden("Doctors cannot attach intake uploads to cases");
    } else if (actor.role === "receptionist") {
      if (caseRecord.createdBy !== actor.id) {
        throw AppError.notFound("Case not found");
      }
    } else if (actor.role === "patient") {
      const [userRecord] = await db
        .select({ patientId: users.patientId })
        .from(users)
        .where(eq(users.id, actor.id));

      if (!userRecord || userRecord.patientId !== caseRecord.patientId) {
        throw AppError.notFound("Case not found");
      }
    } else {
      throw AppError.forbidden("Unauthorized role for case upload");
    }

    // 3. Status lifecycle guard: only allow uploads in early-pipeline intake states
    if (!ALLOWED_UPLOAD_STATUSES.includes(caseRecord.status as CaseStatus)) {
      throw AppError.invalidStateTransition(
        `Cannot attach upload to case in '${caseRecord.status}' status. Uploads are only accepted while in early intake states (${ALLOWED_UPLOAD_STATUSES.join(", ")}).`,
        {
          current_status: caseRecord.status,
          allowed_statuses: ALLOWED_UPLOAD_STATUSES,
        }
      );
    }

    // 4. Insert into case_uploads table
    const [createdUpload] = await db
      .insert(caseUploads)
      .values({
        caseId: caseRecord.id,
        modality,
        filePath: file.path,
        mimeType: file.mimetype,
        fileSize: file.size,
      })
      .returning();

    if (!createdUpload) {
      throw AppError.internal("Failed to save case upload record");
    }

    // 5. Append audit event
    await logAuditEvent({
      caseId: caseRecord.id,
      actorId: actor.id,
      eventType: "intake_submitted",
      metadata: {
        action: "file_uploaded",
        upload_id: createdUpload.id,
        modality,
        file_path: createdUpload.filePath,
        mime_type: createdUpload.mimeType,
        file_size: createdUpload.fileSize,
      },
    });

    // 6. Return response matching api-contract.md §POST /api/cases/:id/upload
    return {
      upload_id: createdUpload.id,
      case_id: createdUpload.caseId,
      modality: createdUpload.modality,
      file_path: createdUpload.filePath,
    };
  } catch (err) {
    // Orphan protection: clean up file from disk if DB write or validation fails
    if (file?.path) {
      console.warn(
        `[Upload Orphan Guard] Cleaning up orphaned file on disk at '${file.path}' due to failure:`,
        err instanceof Error ? err.message : err
      );
      await cleanupFile(file.path);
    }
    throw err;
  }
}

