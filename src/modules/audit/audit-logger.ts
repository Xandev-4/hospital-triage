import { db } from "../../shared/config/db.js";
import {
  auditLog,
  type auditEventTypeEnum,
} from "../../shared/config/schema.js";

export type AuditEventType = (typeof auditEventTypeEnum.enumValues)[number];

export interface RecordAuditParams {
  caseId?: string | null;
  actorId: string;
  eventType: AuditEventType;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends an audit event to the append-only audit_log table.
 * Enforces rule #3: "Every important action is logged in an append-only audit trail."
 */
export async function logAuditEvent(params: RecordAuditParams): Promise<void> {
  try {
    await db.insert(auditLog).values({
      caseId: params.caseId ?? null,
      actorId: params.actorId,
      eventType: params.eventType,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error(
      `[Audit Log Failure] Could not record audit event ${params.eventType} for case ${params.caseId}:`,
      err
    );
    // In dev/test or when audit logging fails, log but do not crash the primary operational flow
    // unless strictly required.
  }
}
