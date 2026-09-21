import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import {
  caseReportVersions,
  triageCases,
  type riskLevelEnum,
} from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { logAuditEvent } from "../audit/audit-logger.js";
import {
  assertValidTransition,
  type CaseStatus,
} from "../cases/cases.state-machine.js";

export type RiskLevel = (typeof riskLevelEnum.enumValues)[number];

export interface DoctorActor {
  id: string;
  role: string;
}

export type DoctorActorInput = string | DoctorActor;

export interface EditReportContent {
  chief_complaint?: string;
  duration?: string;
  symptoms?: string;
  vitals?: Record<string, unknown>;
}

function resolveDoctorActor(actorOrId: DoctorActorInput): DoctorActor {
  if (typeof actorOrId === "string") {
    if (!actorOrId.trim()) {
      throw AppError.forbidden("Valid doctor identification is required");
    }
    return { id: actorOrId, role: "doctor" };
  }

  if (actorOrId.role && actorOrId.role !== "doctor") {
    throw AppError.forbidden("Doctor access required");
  }

  return { id: actorOrId.id, role: actorOrId.role ?? "doctor" };
}

/**
 * 1. getCaseForReview
 * Doctor-only superset of /report including missing-info and disagreement flags.
 * Per api-contract.md §7: no ownership filter needed (single facility V1).
 */
export async function getCaseForReview(
  caseId: string,
  actor?: DoctorActorInput
) {
  if (actor) {
    resolveDoctorActor(actor);
  }

  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  const [latestReport] = await db
    .select()
    .from(caseReportVersions)
    .where(eq(caseReportVersions.caseId, caseId))
    .orderBy(desc(caseReportVersions.versionNumber))
    .limit(1);

  if (latestReport) {
    const content = (latestReport.content as Record<string, any>) ?? {};

    const reportShape = {
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

    return {
      case_id: caseRecord.id,
      report: reportShape,
      missing_info: reportShape.missing_info,
      ai_rules_disagreement: reportShape.ai_rules_disagreement,
    };
  }

  // Fallback for cases without an active version row
  const fallbackReport = {
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

  return {
    case_id: caseRecord.id,
    report: fallbackReport,
    missing_info: [],
    ai_rules_disagreement: fallbackReport.ai_rules_disagreement,
  };
}

/**
 * 2. editReport
 * Never overwrites — inserts a new case_report_versions row with an incremented
 * version_number and source: 'doctor_edit'.
 *
 * Wrapped in a transaction with unique constraint concurrency protection against
 * simultaneous doctor edits.
 */
export async function editReport(
  caseId: string,
  content: EditReportContent,
  actor: DoctorActorInput
) {
  const doctor = resolveDoctorActor(actor);

  if (!content || typeof content !== "object") {
    throw AppError.validation("Invalid report content payload");
  }

  // Sanity check lengths
  if (content.chief_complaint && content.chief_complaint.length > 1000) {
    throw AppError.validation(
      "Chief complaint must not exceed 1000 characters"
    );
  }
  if (content.symptoms && content.symptoms.length > 5000) {
    throw AppError.validation("Symptoms must not exceed 5000 characters");
  }
  if (content.duration && content.duration.length > 100) {
    throw AppError.validation("Duration must not exceed 100 characters");
  }

  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  let nextVersionNumber = 1;

  try {
    await db.transaction(async (tx) => {
      // 1. Fetch current max version number for this case
      const [versionResult] = await tx
        .select({
          maxVersion: sql<number>`COALESCE(MAX(${caseReportVersions.versionNumber}), 0)`,
        })
        .from(caseReportVersions)
        .where(eq(caseReportVersions.caseId, caseId));

      nextVersionNumber = Number(versionResult?.maxVersion ?? 0) + 1;

      // 2. Fetch latest version to merge existing structured fields safely
      const [latestVersionRow] = await tx
        .select()
        .from(caseReportVersions)
        .where(eq(caseReportVersions.caseId, caseId))
        .orderBy(desc(caseReportVersions.versionNumber))
        .limit(1);

      const prevContent =
        (latestVersionRow?.content as Record<string, any>) ?? {};

      const mergedContent = {
        chief_complaint:
          content.chief_complaint !== undefined
            ? { value: content.chief_complaint, source: "doctor_edit" }
            : (prevContent.chief_complaint ?? {
                value: caseRecord.chiefComplaint ?? "",
                source: "manual",
              }),
        duration:
          content.duration !== undefined
            ? { value: content.duration, source: "doctor_edit" }
            : (prevContent.duration ?? {
                value: caseRecord.duration ?? "",
                source: "manual",
              }),
        symptoms:
          content.symptoms !== undefined
            ? { value: content.symptoms, source: "doctor_edit" }
            : (prevContent.symptoms ?? {
                value: caseRecord.symptoms ?? "",
                source: "manual",
              }),
        vitals:
          content.vitals !== undefined
            ? { value: content.vitals, source: "doctor_edit" }
            : (prevContent.vitals ?? {
                value: caseRecord.vitals ?? {},
                source: "manual",
              }),
        missing_info: prevContent.missing_info ?? [],
        risk_level: prevContent.risk_level ?? caseRecord.riskLevel,
        ai_rules_disagreement: prevContent.ai_rules_disagreement ?? {
          present: caseRecord.aiRulesDisagreement,
          ai_suggested: null,
          rules_result: caseRecord.riskLevel,
          note: null,
        },
        triggered_rules: prevContent.triggered_rules ?? [],
        rule_details: prevContent.rule_details ?? [],
      };

      // 3. Insert new version row
      await tx.insert(caseReportVersions).values({
        caseId,
        versionNumber: nextVersionNumber,
        source: "doctor_edit",
        content: mergedContent,
        editedBy: doctor.id,
      });

      // 4. Keep top-level summary columns on triage_cases in sync
      const updates: Partial<typeof triageCases.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (content.chief_complaint !== undefined)
        updates.chiefComplaint = content.chief_complaint;
      if (content.duration !== undefined) updates.duration = content.duration;
      if (content.symptoms !== undefined) updates.symptoms = content.symptoms;
      if (content.vitals !== undefined) updates.vitals = content.vitals;

      await tx
        .update(triageCases)
        .set(updates)
        .where(eq(triageCases.id, caseId));
    });
  } catch (err: any) {
    if (
      err?.code === "23505" ||
      err?.message?.includes("case_version_unique") ||
      err?.constraint === "case_version_unique"
    ) {
      throw AppError.conflict(
        "This report was just edited by someone else, please refresh and retry.",
        { reason: "version_conflict" }
      );
    }
    throw err;
  }

  // 5. Append-only audit logging for report_edited
  await logAuditEvent({
    caseId,
    actorId: doctor.id,
    eventType: "report_edited",
    metadata: {
      new_version_number: nextVersionNumber,
      edited_by: doctor.id,
      edited_fields: Object.keys(content),
    },
  });

  return {
    case_id: caseId,
    new_version_number: nextVersionNumber,
  };
}

/**
 * 3. overrideRiskLevel
 * Doctor-only risk level override. Reason is required and validated.
 * Per api-contract.md §7: sets triage_cases.risk_level and writes audit log.
 */
export async function overrideRiskLevel(
  caseId: string,
  newLevel: string,
  reason: string,
  actor: DoctorActorInput
) {
  const doctor = resolveDoctorActor(actor);

  if (!reason || typeof reason !== "string" || !reason.trim()) {
    throw AppError.validation(
      "Override reason is required and cannot be empty"
    );
  }

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 1000) {
    throw AppError.validation(
      "Override reason must be between 3 and 1000 characters"
    );
  }

  const validLevels: RiskLevel[] = ["low", "medium", "high", "critical"];
  if (!validLevels.includes(newLevel as RiskLevel)) {
    throw AppError.validation(
      `Invalid risk level '${newLevel}'. Must be one of: low, medium, high, critical.`
    );
  }

  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  const previousRisk = caseRecord.riskLevel;

  await db
    .update(triageCases)
    .set({
      riskLevel: newLevel as RiskLevel,
      updatedAt: new Date(),
    })
    .where(eq(triageCases.id, caseId));

  // Sync risk_level on latest version row if one exists
  const [latestReport] = await db
    .select()
    .from(caseReportVersions)
    .where(eq(caseReportVersions.caseId, caseId))
    .orderBy(desc(caseReportVersions.versionNumber))
    .limit(1);

  if (latestReport) {
    const updatedContent = {
      ...(latestReport.content as Record<string, any>),
      risk_level: newLevel,
    };
    await db
      .update(caseReportVersions)
      .set({ content: updatedContent })
      .where(eq(caseReportVersions.id, latestReport.id));
  }

  // Record audit log event: risk_overridden
  await logAuditEvent({
    caseId,
    actorId: doctor.id,
    eventType: "risk_overridden",
    metadata: {
      previous_risk: previousRisk,
      new_risk: newLevel,
      reason: trimmedReason,
      overridden_by: doctor.id,
    },
  });

  return {
    case_id: caseId,
    risk_level: newLevel,
  };
}

/**
 * 4. approveCase
 * Doctor assigns case to themselves: transitions 'queued' -> 'assigned'.
 * Validates transition strictly via state machine (rejects with 409 if not queued).
 */
export async function approveCase(caseId: string, actor: DoctorActorInput) {
  const doctor = resolveDoctorActor(actor);

  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  // State machine transition validation: queued -> assigned
  assertValidTransition(caseRecord.status as CaseStatus, "assigned");

  await db
    .update(triageCases)
    .set({
      status: "assigned",
      updatedAt: new Date(),
    })
    .where(eq(triageCases.id, caseId));

  // Record audit log event: assigned
  await logAuditEvent({
    caseId,
    actorId: doctor.id,
    eventType: "assigned",
    metadata: {
      assigned_to: doctor.id,
      previous_status: caseRecord.status,
      new_status: "assigned",
    },
  });

  return {
    case_id: caseId,
    status: "assigned",
  };
}

/**
 * 5. closeCase
 * Doctor closes case: transitions 'assigned' -> 'closed'.
 * Validates transition strictly via state machine (rejects with 409 if not assigned).
 */
export async function closeCase(caseId: string, actor: DoctorActorInput) {
  const doctor = resolveDoctorActor(actor);

  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  // State machine transition validation: assigned -> closed
  assertValidTransition(caseRecord.status as CaseStatus, "closed");

  await db
    .update(triageCases)
    .set({
      status: "closed",
      updatedAt: new Date(),
    })
    .where(eq(triageCases.id, caseId));

  // Record audit log event: closed
  await logAuditEvent({
    caseId,
    actorId: doctor.id,
    eventType: "closed",
    metadata: {
      closed_by: doctor.id,
      previous_status: caseRecord.status,
      new_status: "closed",
    },
  });

  return {
    case_id: caseId,
    status: "closed",
  };
}
