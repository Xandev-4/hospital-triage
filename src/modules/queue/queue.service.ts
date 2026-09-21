import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import { patients, triageCases } from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type QueueStatus = "queued" | "assigned";

export interface QueueFilters {
  status?: QueueStatus;
  risk_level?: RiskLevel;
  sort?: "asc" | "desc";
}

export interface QueueItem {
  case_id: string;
  patient_display: string;
  chief_complaint: string;
  risk_level: RiskLevel | null;
  submitted_at: string;
  status: QueueStatus;
}

export interface QueueResponse {
  queue: QueueItem[];
}

export interface AuthenticatedActor {
  id: string;
  role: string;
  [key: string]: unknown;
}

const MAX_SUMMARY_COMPLAINT_LENGTH = 100;

/**
 * Truncates free-text chief complaints for high-density, scannable queue list views.
 */
function truncateChiefComplaint(
  text: string | null,
  maxLength = MAX_SUMMARY_COMPLAINT_LENGTH
): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

/**
 * Retrieves the prioritized active triage queue.
 *
 * Requirements & Invariants:
 * 1. Role Authorization: Doctor-only (docs/api-contract.md §7 & §10).
 * 2. Active Status Scoping: Status IN ('queued', 'assigned'). Cases that are
 *    'submitted' or 'processing' are not ready for clinical review; 'manual_fallback'
 *    requires intake resolution; 'closed' cases are completed and leave the active queue.
 * 3. Non-Alphabetical Clinical Priority: Orders cases strictly by risk level
 *    (critical -> high -> medium -> low), then by created_at (FIFO).
 * 4. Privacy & Payload Scoping: Explicitly selects ONLY scannable summary fields
 *    (case_id, patient_display, truncated chief_complaint, risk_level, submitted_at, status).
 *    Never leaks detailed symptom descriptions, vitals, or full intake narratives in list view.
 */
export async function getQueue(
  actor: AuthenticatedActor,
  filters?: QueueFilters
): Promise<QueueResponse> {
  // 1. Role Guard: Doctor-only per contract
  if (!actor || actor.role !== "doctor") {
    throw AppError.forbidden("Doctor access required to view the triage queue");
  }

  // 2. Build status conditions
  // Default to both 'queued' (waiting) and 'assigned' (currently being reviewed)
  const allowedStatuses: QueueStatus[] = ["queued", "assigned"];
  let statusCondition = inArray(triageCases.status, allowedStatuses);

  if (filters?.status) {
    if (!allowedStatuses.includes(filters.status)) {
      throw AppError.validation(
        `Invalid status filter. Must be one of: ${allowedStatuses.join(", ")}`
      );
    }
    statusCondition = eq(triageCases.status, filters.status);
  }

  // 3. Build risk_level conditions
  const conditions = [statusCondition];
  if (filters?.risk_level) {
    const validRiskLevels: RiskLevel[] = ["critical", "high", "medium", "low"];
    if (!validRiskLevels.includes(filters.risk_level)) {
      throw AppError.validation(
        `Invalid risk_level filter. Must be one of: ${validRiskLevels.join(", ")}`
      );
    }
    conditions.push(eq(triageCases.riskLevel, filters.risk_level));
  }

  // 4. Clinical Priority Ordering:
  // Non-alphabetical custom ranking: critical (1) -> high (2) -> medium (3) -> low (4) -> null (5)
  const riskPriorityOrder = sql`CASE 
    WHEN ${triageCases.riskLevel} = 'critical' THEN 1
    WHEN ${triageCases.riskLevel} = 'high' THEN 2
    WHEN ${triageCases.riskLevel} = 'medium' THEN 3
    WHEN ${triageCases.riskLevel} = 'low' THEN 4
    ELSE 5
  END`;

  // Secondary sort: FIFO by created_at (earlier submissions reviewed first within risk tier)
  const timeOrder =
    filters?.sort === "desc"
      ? desc(triageCases.createdAt)
      : asc(triageCases.createdAt);

  // 5. Query: Explicit projection of ONLY contract-specified summary fields
  // Joins patients to retrieve scannable display name without exposing sensitive clinical narratives
  const rows = await db
    .select({
      caseId: triageCases.id,
      patientName: patients.name,
      chiefComplaint: triageCases.chiefComplaint,
      riskLevel: triageCases.riskLevel,
      submittedAt: triageCases.createdAt,
      status: triageCases.status,
    })
    .from(triageCases)
    .innerJoin(patients, eq(triageCases.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(riskPriorityOrder, timeOrder);

  // 6. Format scannable response per docs/api-contract.md §7
  const queue: QueueItem[] = rows.map((row) => ({
    case_id: row.caseId,
    patient_display: row.patientName || "Unknown Patient",
    chief_complaint: truncateChiefComplaint(row.chiefComplaint),
    risk_level: (row.riskLevel as RiskLevel) ?? null,
    submitted_at: row.submittedAt.toISOString(),
    status: row.status as QueueStatus,
  }));

  return { queue };
}
