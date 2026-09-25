import { asc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import {
  auditLog,
  type AuditLogEntry,
  type auditEventTypeEnum,
} from "../../shared/config/schema.js";

export type AuditEventType = (typeof auditEventTypeEnum.enumValues)[number];

export interface InsertAuditEventParams {
  caseId?: string | null;
  actorId: string;
  eventType: AuditEventType;
  metadata?: Record<string, unknown> | null;
}

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Inserts an append-only audit event into the audit_log table.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. Single Write Path: This function is the ONLY place in the entire codebase
 *    allowed to write to the audit_log table directly.
 * 2. Immutable Timestamps: Caller-supplied created_at/timestamp is explicitly forbidden.
 *    The DB's now() default is strictly used to guarantee chronological integrity and prevent backdating.
 * 3. Nullable caseId: Supported for non-case audit events (e.g., patient_search, patient_created).
 */
export async function insertAuditEvent(
  params: InsertAuditEventParams,
  executor: DbExecutor = db
): Promise<AuditLogEntry> {
  const [entry] = await executor
    .insert(auditLog)
    .values({
      caseId: params.caseId ?? null,
      actorId: params.actorId,
      eventType: params.eventType,
      metadata: params.metadata ?? null,
    })
    .returning();

  if (!entry) {
    throw new Error("Failed to insert audit event: database returned no inserted row");
  }

  return entry;
}

/**
 * Reads all audit log entries for a given case, ordered chronologically (created_at ASC).
 */
export async function getAuditEventsByCaseId(
  caseId: string
): Promise<AuditLogEntry[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.caseId, caseId))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
}
