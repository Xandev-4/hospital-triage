import {
  insertAuditEvent,
  type DbExecutor,
  type InsertAuditEventParams,
} from "./audit.repository.js";

/**
 * Canonical 10 Audit Event Types matching the Postgres audit_event_type enum.
 * Enforces compile-time typo prevention across all consuming modules:
 * consent_given, intake_submitted, ai_report_generated, status_changed,
 * report_edited, risk_overridden, assigned, closed, patient_search, patient_created.
 */
export const AUDIT_EVENT_TYPES = [
  "consent_given",
  "intake_submitted",
  "ai_report_generated",
  "status_changed",
  "report_edited",
  "risk_overridden",
  "assigned",
  "closed",
  "patient_search",
  "patient_created",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface RecordAuditParams {
  caseId?: string | null;
  actorId: string;
  eventType: AuditEventType;
  metadata?: Record<string, unknown> | null;
}

/**
 * Sanitizes metadata to ensure sensitive credentials or credentials accidentally
 * passed by callers are redacted before reaching the audit log.
 */
function sanitizeAuditMetadata(
  metadata?: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;

  const SENSITIVE_KEYS = new Set([
    "password",
    "passwordhash",
    "password_hash",
    "token",
    "secret",
    "jwt",
    "authorization",
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Appends an audit event to the append-only audit_log table.
 *
 * DESIGN DECISION (Fail-Open for Audit Logging):
 * Audit logging write failures are caught internally and logged to stderr with [AUDIT WRITE FAILED].
 * They intentionally DO NOT throw or bubble up to the caller to prevent operational disruption.
 * For example, a doctor approving a patient discharge, an intake submission, or triage review
 * must not fail or roll back simply because the secondary audit write encountered an issue.
 *
 * TRADEOFF: While this prevents operational downtime for clinical workflows, it creates a potential
 * audit gap during DB write errors. To ensure visibility, all failures are logged with a standardized,
 * easily-greppable prefix: `[AUDIT WRITE FAILED]`.
 *
 * DATA PRIVACY & BOUNDARY:
 * Metadata must contain only small, structural facts and delta attributes (e.g. `{ from, to }`,
 * `{ reason }`, `{ disposition }`, `{ version_number }`). It must NEVER contain full entity objects
 * (e.g., full patient profile, passwordHash, full case record). Duplicating full records into the
 * audit_log table violates the principle of least privilege, as audit logs are designed for
 * provenance tracking and have different retention/access patterns than primary clinical tables.
 */
export async function logAuditEvent(
  params: RecordAuditParams,
  executor?: DbExecutor
): Promise<void> {
  try {
    const sanitizedMetadata = sanitizeAuditMetadata(params.metadata);

    await insertAuditEvent(
      {
        caseId: params.caseId ?? null,
        actorId: params.actorId,
        eventType: params.eventType,
        metadata: sanitizedMetadata,
      },
      executor
    );
  } catch (err) {
    // Grep-friendly prefix for observability, log monitoring, and alerting
    console.error(
      `[AUDIT WRITE FAILED] Failed to record event_type='${params.eventType}' actor_id='${params.actorId}' case_id='${params.caseId ?? "null"}':`,
      err
    );
  }
}
