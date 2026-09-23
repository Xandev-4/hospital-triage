import { desc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import { consent, patients, triageCases, users } from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";

const CONSENT_VALIDITY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export interface GiveConsentInput {
  patient_id: string;
  given_by: "self" | "staff";
  staff_id?: string | null;
  policy_version: string;
  timestamp?: string | Date;
}

export async function giveConsent(input: GiveConsentInput) {
  const { patient_id, given_by, policy_version } = input;
  let { staff_id } = input;

  if (!patient_id || !given_by || !policy_version) {
    throw AppError.validation(
      "patient_id, given_by ('self' | 'staff'), and policy_version are required"
    );
  }

  if (given_by !== "self" && given_by !== "staff") {
    throw AppError.validation("given_by must be either 'self' or 'staff'");
  }

  if (given_by === "staff") {
    if (!staff_id) {
      throw AppError.validation(
        "staff_id is required when consent is given by staff"
      );
    }
  } else {
    staff_id = null; // Enforce null staff_id for self-consent
  }

  // Ensure patient exists
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patient_id));

  if (!patient) {
    throw AppError.notFound("Patient not found");
  }

  const givenAtDate = input.timestamp ? new Date(input.timestamp) : new Date();
  if (isNaN(givenAtDate.getTime())) {
    throw AppError.validation("Invalid timestamp provided");
  }

  const [created] = await db
    .insert(consent)
    .values({
      patientId: patient_id,
      givenBy: given_by,
      staffId: staff_id,
      policyVersion: policy_version,
      givenAt: givenAtDate,
    })
    .returning();

  if (!created) {
    throw AppError.internal("Failed to record consent");
  }

  const validUntil = new Date(
    created.givenAt.getTime() + CONSENT_VALIDITY_WINDOW_MS
  );

  return {
    consent_id: created.id,
    patient_id: created.patientId,
    given_by: created.givenBy,
    valid_until: validUntil.toISOString(),
  };
}

export async function checkValidConsent(
  patientId: string,
  mode: "self" | "assisted"
) {
  const [latestConsent] = await db
    .select()
    .from(consent)
    .where(eq(consent.patientId, patientId))
    .orderBy(desc(consent.givenAt))
    .limit(1);

  if (!latestConsent) {
    throw AppError.consentRequired("No consent record found for this patient");
  }

  // Confirm given_by matches submission mode
  if (mode === "self" && latestConsent.givenBy !== "self") {
    throw AppError.consentRequired("Self-intake requires self-given consent");
  }

  if (mode === "assisted" && latestConsent.givenBy !== "staff") {
    throw AppError.consentRequired(
      "Assisted intake requires staff-recorded consent"
    );
  }

  // Confirm within 30-minute window
  const elapsed = Date.now() - new Date(latestConsent.givenAt).getTime();
  if (elapsed < 0 || elapsed > CONSENT_VALIDITY_WINDOW_MS) {
    throw AppError.consentRequired(
      "Consent has expired (must be given within 30 minutes of intake)"
    );
  }

  return latestConsent;
}

export interface ConsentActor {
  id: string;
  role: string;
  patientId?: string | null;
}

/**
 * Fetches the consent record linked to a case via case.consent_id FK.
 *
 * Enforces row-level ownership:
 * - patient: case.patient_id matches their own patient id
 * - receptionist: case.created_by matches their user id
 * - doctor: no restriction (authorized for review/audit)
 *
 * Anti-enumeration: returns 404 not_found if non-existent or not owned (never 403).
 * Looks up consent via case.consent_id FK, not fresh patient_id lookup,
 * preventing fishing for other patients' consents.
 *
 * Returns api-contract.md §2 shape:
 * { consent_id, patient_id, given_by, staff_id, policy_version, given_at }
 */
export async function getConsentByCase(
  caseId: string,
  actor: ConsentActor
) {
  const [caseRecord] = await db
    .select({
      id: triageCases.id,
      patientId: triageCases.patientId,
      createdBy: triageCases.createdBy,
      consentId: triageCases.consentId,
    })
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  // 1. Ownership check on the case itself (anti-enumeration: 404, not 403)
  if (actor.role === "doctor") {
    // Doctors have no restriction
  } else if (actor.role === "receptionist") {
    if (caseRecord.createdBy !== actor.id) {
      throw AppError.notFound("Case not found");
    }
  } else if (actor.role === "patient") {
    let patientId = actor.patientId;
    if (!patientId) {
      const [userRecord] = await db
        .select({ patientId: users.patientId })
        .from(users)
        .where(eq(users.id, actor.id));
      patientId = userRecord?.patientId ?? null;
    }

    if (!patientId || caseRecord.patientId !== patientId) {
      throw AppError.notFound("Case not found");
    }
  } else {
    throw AppError.forbidden("Unauthorized role for viewing consent");
  }

  if (!caseRecord.consentId) {
    throw AppError.notFound("Consent record not found");
  }

  // 2. Look up consent via case.consent_id (FK link, not searching consent directly)
  const [consentRecord] = await db
    .select()
    .from(consent)
    .where(eq(consent.id, caseRecord.consentId));

  if (!consentRecord) {
    throw AppError.notFound("Consent record not found");
  }

  // 3. Return shape matching api-contract.md §2
  return {
    consent_id: consentRecord.id,
    patient_id: consentRecord.patientId,
    given_by: consentRecord.givenBy,
    staff_id: consentRecord.staffId,
    policy_version: consentRecord.policyVersion,
    given_at: consentRecord.givenAt.toISOString(),
  };
}

export const getConsentByCaseId = getConsentByCase;
