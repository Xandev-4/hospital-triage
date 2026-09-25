import { eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import { triageCases, users } from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { getAuditEventsByCaseId } from "./audit.repository.js";
import type { UserRole } from "../../shared/types/express.d.js";

export interface AuditActor {
  id: string;
  role: UserRole | string;
  patientId?: string | null;
}

export interface AuditEventResponseItem {
  event_type: string;
  actor_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CaseAuditTrailResponse {
  events: AuditEventResponseItem[];
}

/**
 * Retrieves the append-only audit trail for a case, enforcing anti-enumeration ownership.
 *
 * DESIGN NOTE ON AUDIT ACCESS & FUTURE GRANULARITY:
 * GET /api/cases/:id/audit returns the full event history for the case. Currently, all recorded
 * event types (consent, intake, status changes, edits, assignments, closures) are appropriate
 * for authorized case viewers (patient, creating receptionist, reviewing doctor).
 *
 * However, if future event types or metadata contain sensitive internal physician deliberations
 * or coordinator flags, the case-level ownership check alone may need to be augmented with
 * event-type level filtering (e.g. patients seeing patient-visible events only).
 * Do not assume case ownership is permanently granular enough as more event types are added.
 */
export async function getCaseAuditTrail(
  caseId: string,
  actor: AuditActor
): Promise<CaseAuditTrailResponse> {
  // 1. Fetch case record for ownership verification
  const [caseRecord] = await db
    .select({
      id: triageCases.id,
      patientId: triageCases.patientId,
      createdBy: triageCases.createdBy,
    })
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  // Anti-enumeration pattern: return 404 not_found (never 403) if case does not exist
  if (!caseRecord) {
    throw AppError.notFound("Case not found", { case_id: caseId });
  }

  // 2. Ownership verification
  // Doctor: unrestricted clinical access
  // Patient: must be their own case
  // Receptionist: must be a case they created
  if (actor.role === "patient") {
    let patientId = actor.patientId;
    if (!patientId) {
      const [userRecord] = await db
        .select({ patientId: users.patientId })
        .from(users)
        .where(eq(users.id, actor.id));
      patientId = userRecord?.patientId ?? null;
    }

    if (!patientId || caseRecord.patientId !== patientId) {
      throw AppError.notFound("Case not found", { case_id: caseId });
    }
  } else if (actor.role === "receptionist") {
    if (caseRecord.createdBy !== actor.id) {
      throw AppError.notFound("Case not found", { case_id: caseId });
    }
  } else if (actor.role !== "doctor") {
    throw AppError.forbidden("Not allowed to access this case's audit trail");
  }

  // 3. Query audit trail from repository ordered ascending by created_at
  const auditEntries = await getAuditEventsByCaseId(caseId);

  // 4. Transform to api-contract.md §8 shape
  const events: AuditEventResponseItem[] = auditEntries.map((entry) => ({
    event_type: entry.eventType,
    actor_id: entry.actorId,
    metadata: (entry.metadata as Record<string, unknown>) ?? {},
    created_at: entry.createdAt.toISOString(),
  }));

  return { events };
}
