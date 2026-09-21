import { and, desc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import { patients, triageCases, users } from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { checkValidConsent } from "../consent/consent.service.js";
import type { CaseStatus } from "./cases.state-machine.js";
import type { UserRole } from "../../shared/types/express.d.js";

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
    })
    .returning();

  if (!createdCase) {
    throw AppError.internal("Failed to create triage case");
  }

  return {
    case_id: createdCase.id,
    status: createdCase.status,
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
