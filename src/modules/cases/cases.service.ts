import { and, desc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import {
  caseReportVersions,
  patients,
  triageCases,
  users,
} from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { checkValidConsent } from "../consent/consent.service.js";
import { logAuditEvent } from "../audit/audit-logger.js";
import { processCase } from "../processing/processing.service.js";
import type { CaseStatus } from "./cases.state-machine.js";
import type { UserRole } from "../../shared/types/express.d.js";
import type { RiskLevel } from "../processing/rules-engine.js";

const MAX_CHIEF_COMPLAINT_LENGTH = 1000;
const MAX_SYMPTOMS_LENGTH = 5000;
const MAX_DURATION_LENGTH = 100;

export interface CaseActor {
  id: string;
  role: UserRole | string;
}

export interface CreateCaseInput {
  patient_id?: string;
  mode?: "self" | "assisted";
  phone_number?: string;
  chief_complaint: string;
  duration?: string;
  symptoms?: string;
  vitals?: Record<string, unknown>;
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
 * Creates a new triage case.
 * Validates consent first, enforces server-side patient/creator resolution,
 * and sets initial status to 'submitted'.
 */
export async function createCase(input: CreateCaseInput, actor: CaseActor) {
  if (actor.role === "doctor") {
    throw AppError.forbidden("Doctors cannot create triage cases");
  }

  let resolvedPatientId: string;
  let mode: "self" | "assisted";

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

  // Validate free-text inputs & enforce length limits
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

  // 1. Validate consent FIRST — fails closed with 403 consent_required before touching triage_cases
  const activeConsent = await checkValidConsent(resolvedPatientId, mode);

  // Optional: Update patient contact phone number if provided during intake
  if (input.phone_number?.trim()) {
    await db
      .update(patients)
      .set({ phoneNumber: input.phone_number.trim() })
      .where(eq(patients.id, resolvedPatientId));
  }

  // 2. Insert case row with status 'submitted'
  const [createdCase] = await db
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

  if (!createdCase) {
    throw AppError.internal("Failed to create triage case");
  }

  // 3. Log intake_submitted audit event (Rule #3: append-only audit trail)
  await logAuditEvent({
    caseId: createdCase.id,
    actorId: actor.id,
    eventType: "intake_submitted",
    metadata: {
      mode,
      patient_id: resolvedPatientId,
    },
  });

  // 4. Trigger internal-only processing pipeline directly
  // NOTE: Per api-contract.md §5, /process is internal-only and NEVER exposed via an Express route.
  // We invoke processCase directly as a plain service function right after case creation.
  let finalStatus: CaseStatus = createdCase.status;
  try {
    const processResult = await processCase(createdCase.id, actor, {
      simulateFailure: input.simulate_failure,
      simulateLowConfidence: input.simulate_low_confidence,
      simulateTimeout: input.simulate_timeout,
      simulateMalformedOutput: input.simulate_malformed_output,
      aiSuggestedRisk: input.ai_suggested_risk,
    });
    finalStatus = processResult.status;
  } catch (err) {
    // Fail-safe: even if unexpected processing error occurs, never leak internals or crash intake
    console.error(
      `[Cases Service] Internal processing exception for case ${createdCase.id}:`,
      err
    );
  }

  // 5. Return minimal safe response per api-contract.md §4
  // Never expose internal AI provider errors, stack traces, or raw model output to the client.
  return {
    case_id: createdCase.id,
    status: finalStatus,
    consent_id: createdCase.consentId,
    mode: createdCase.mode,
  };
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
