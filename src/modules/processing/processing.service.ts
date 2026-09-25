import { and, desc, eq } from "drizzle-orm";
import { db } from "../../shared/config/db.js";
import {
  caseReportVersions,
  caseUploads,
  triageCases,
} from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";
import { assertValidTransition } from "../cases/cases.state-machine.js";
import { logAuditEvent } from "../audit/audit-logger.js";
import {
  extractStructuredData,
  type ExtractedVitals,
} from "./ai-extraction.js";
import { evaluateRisk, type RiskLevel } from "./rules-engine.js";

export interface ProcessCaseActor {
  id: string;
  role: string;
}

export interface ProcessCaseOptions {
  skip_ai?: boolean;
  // Simulation hooks for test suites / Demo Scenario D
  simulateFailure?: boolean;
  simulateLowConfidence?: boolean;
  simulateTimeout?: boolean;
  simulateMalformedOutput?: boolean;
  aiSuggestedRisk?: RiskLevel;
}

export interface ProcessCaseResult {
  case_id: string;
  status: "queued" | "manual_fallback";
  risk_level: RiskLevel | null;
  ai_rules_disagreement: boolean;
}

/**
 * Gets the next report version number for a case.
 */
async function getNextVersionNumber(caseId: string): Promise<number> {
  const [latest] = await db
    .select({ versionNumber: caseReportVersions.versionNumber })
    .from(caseReportVersions)
    .where(eq(caseReportVersions.caseId, caseId))
    .orderBy(desc(caseReportVersions.versionNumber))
    .limit(1);

  return latest ? latest.versionNumber + 1 : 1;
}

/**
 * Orchestrator Service for AI Extraction + Rules-Based Risk Evaluation.
 *
 * Implements Section 5 of docs/api-contract.md:
 * - Order of operations:
 *   1. Assert legal transition to 'processing' and persist.
 *   2. Run extractStructuredData (or skip if skip_ai: true).
 *   3. If AI extraction fails/low confidence: transition to manual_fallback (Rule #5: Failures visible).
 *   4. If AI extraction succeeds: run evaluateRisk.
 *   5. Compare AI risk suggestion against rules engine. RULES ENGINE RESULT ALWAYS WINS.
 *   6. Write case_report_versions (source: 'ai', version: next).
 *   7. Transition case to 'queued' and persist.
 *   8. Append-only audit events recorded at every distinct milestone.
 * - Fault-tolerance: any unexpected runtime error while in 'processing' safely falls back
 *   to 'manual_fallback', preventing cases from being permanently orphaned in 'processing'.
 */
export async function processCase(
  caseId: string,
  actor: ProcessCaseActor,
  options: ProcessCaseOptions = {}
): Promise<ProcessCaseResult> {
  // 1. Fetch case record
  const [caseRecord] = await db
    .select()
    .from(triageCases)
    .where(eq(triageCases.id, caseId));

  if (!caseRecord) {
    throw AppError.notFound("Case not found");
  }

  const shouldSkipAi = Boolean(options.skip_ai);

  // ==========================================================================
  // PATH A: Skip AI (Direct manual_fallback -> queued re-evaluation)
  // Per api-contract.md §11: manual_fallback transitions directly to queued.
  // ==========================================================================
  if (shouldSkipAi) {
    // Determine legal target transition from current state
    const targetStatus = "queued";
    assertValidTransition(caseRecord.status, targetStatus);

    const evaluatedRisk = evaluateRisk({
      chiefComplaint: caseRecord.chiefComplaint,
      duration: caseRecord.duration,
      symptoms: caseRecord.symptoms,
      vitals: (caseRecord.vitals as ExtractedVitals) ?? {},
    });

    const nextVersion = await getNextVersionNumber(caseId);

    // Write case_report_versions (source: 'manual')
    await db.insert(caseReportVersions).values({
      caseId,
      versionNumber: nextVersion,
      source: "manual",
      content: {
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
        missing_info: evaluatedRisk.missingCriticalInfo,
        risk_level: evaluatedRisk.riskLevel,
        ai_rules_disagreement: {
          present: false,
          ai_suggested: null,
          rules_result: evaluatedRisk.riskLevel,
          note: null,
        },
        triggered_rules: evaluatedRisk.triggeredRules,
        rule_details: evaluatedRisk.ruleDetails,
      },
      editedBy: actor.id,
    });

    await db
      .update(triageCases)
      .set({
        status: "queued",
        riskLevel: evaluatedRisk.riskLevel,
        aiRulesDisagreement: false,
        updatedAt: new Date(),
      })
      .where(eq(triageCases.id, caseId));

    await logAuditEvent({
      caseId,
      actorId: actor.id,
      eventType: "status_changed",
      metadata: {
        from: caseRecord.status,
        to: "queued",
        reason: "manual_evaluation_complete",
      },
    });

    return {
      case_id: caseId,
      status: "queued",
      risk_level: evaluatedRisk.riskLevel,
      ai_rules_disagreement: false,
    };
  }

  // ==========================================================================
  // PATH B: Standard AI Extraction + Rules Engine Pipeline
  // ==========================================================================

  // 2. Validate state transition to 'processing' (idempotent if already in processing)
  if (caseRecord.status !== "processing") {
    assertValidTransition(caseRecord.status, "processing");

    // Persist transition to 'processing'
    await db
      .update(triageCases)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(triageCases.id, caseId));

    await logAuditEvent({
      caseId,
      actorId: actor.id,
      eventType: "status_changed",
      metadata: {
        from: caseRecord.status,
        to: "processing",
      },
    });
  }

  let isInProcessingState = true;

  try {
    // ==========================================================================
    // PATH B: AI Extraction + Rules Engine Orchestration
    // ==========================================================================

    // Fetch case uploads (audio / images)
    const uploads = await db
      .select()
      .from(caseUploads)
      .where(eq(caseUploads.caseId, caseId));

    const rawInput = {
      caseId,
      chiefComplaint: caseRecord.chiefComplaint,
      duration: caseRecord.duration,
      symptoms: caseRecord.symptoms,
      vitals: (caseRecord.vitals as Record<string, unknown>) ?? null,
      uploadedFiles: uploads.map((u) => ({
        modality: u.modality,
        filePath: u.filePath,
        mimeType: u.mimeType,
      })),
      simulateFailure: options.simulateFailure,
      simulateLowConfidence: options.simulateLowConfidence,
      simulateTimeout: options.simulateTimeout,
      simulateMalformedOutput: options.simulateMalformedOutput,
    };

    const extraction = await extractStructuredData(rawInput);

    // B1. Handle AI Failure or Low Confidence (Demo Scenario D)
    if (!extraction.success) {
      assertValidTransition("processing", "manual_fallback");

      await db
        .update(triageCases)
        .set({
          status: "manual_fallback",
          updatedAt: new Date(),
        })
        .where(eq(triageCases.id, caseId));

      isInProcessingState = false;

      const isProviderFailure =
        extraction.reason === "provider_error" ||
        extraction.reason === "ai_extraction_timeout";
      const fallbackCategory = isProviderFailure ? "provider_failure" : "bad_input";

      // Log distinct AI failure event
      await logAuditEvent({
        caseId,
        actorId: actor.id,
        eventType: "ai_report_generated",
        metadata: {
          success: false,
          reason: extraction.reason,
          fallback_category: fallbackCategory,
          confidence: extraction.confidence,
          error: extraction.error ?? null,
          is_bug: false,
        },
      });

      // Log status transition event
      await logAuditEvent({
        caseId,
        actorId: actor.id,
        eventType: "status_changed",
        metadata: {
          from: "processing",
          to: "manual_fallback",
          reason: extraction.reason,
          fallback_category: fallbackCategory,
        },
      });

      return {
        case_id: caseId,
        status: "manual_fallback",
        risk_level: null,
        ai_rules_disagreement: false,
      };
    }

    // B2. Handle Successful AI Extraction
    const extractedData = extraction.data;

    // Run deterministic rules engine
    const evaluatedRisk = evaluateRisk({
      chiefComplaint: extractedData.chiefComplaint,
      duration: extractedData.duration,
      symptoms: extractedData.symptoms,
      vitals: extractedData.vitals,
    });

    // Determine risk disagreement
    // INVARIANT: The deterministic rules engine result ALWAYS wins.
    const aiSuggestedRisk =
      options.aiSuggestedRisk ?? extractedData.aiSuggestedRisk;
    const rulesResult = evaluatedRisk.riskLevel;
    const hasDisagreement = Boolean(
      aiSuggestedRisk && aiSuggestedRisk !== rulesResult
    );
    const finalRisk: RiskLevel = rulesResult;

    const nextVersion = await getNextVersionNumber(caseId);

    const combinedMissingInfo = Array.from(
      new Set([
        ...(extractedData.missingInfo || []),
        ...(evaluatedRisk.missingCriticalInfo || []),
      ])
    );

    // Write version 1 (or next) into case_report_versions
    await db.insert(caseReportVersions).values({
      caseId,
      versionNumber: nextVersion,
      source: "ai",
      content: {
        chief_complaint: {
          value: extractedData.chiefComplaint,
          source: "ai",
        },
        duration: {
          value: extractedData.duration,
          source: "ai",
        },
        symptoms: {
          value: extractedData.symptoms,
          source: "ai",
        },
        vitals: {
          value: extractedData.vitals,
          source: "ai",
        },
        missing_info: combinedMissingInfo,
        suggested_department: extractedData.suggestedDepartment,
        risk_level: finalRisk,
        ai_rules_disagreement: {
          present: hasDisagreement,
          ai_suggested: aiSuggestedRisk ?? null,
          rules_result: rulesResult,
          note: hasDisagreement ? "rules result applies" : null,
        },
        triggered_rules: evaluatedRisk.triggeredRules,
        rule_details: evaluatedRisk.ruleDetails,
      },
      editedBy: null,
    });

    // Transition state from 'processing' to 'queued'
    assertValidTransition("processing", "queued");

    // Update triage_cases with extracted structured fields, risk level, and disagreement flag
    await db
      .update(triageCases)
      .set({
        chiefComplaint: extractedData.chiefComplaint,
        duration: extractedData.duration,
        symptoms: extractedData.symptoms,
        vitals: extractedData.vitals,
        riskLevel: finalRisk,
        aiRulesDisagreement: hasDisagreement,
        status: "queued",
        updatedAt: new Date(),
      })
      .where(eq(triageCases.id, caseId));

    isInProcessingState = false;

    // Log AI report generation event
    await logAuditEvent({
      caseId,
      actorId: actor.id,
      eventType: "ai_report_generated",
      metadata: {
        success: true,
        risk_tag: finalRisk,
        department_suggested: extractedData.suggestedDepartment,
        ai_rules_disagreement: hasDisagreement,
        ai_suggested_risk: aiSuggestedRisk ?? null,
        rules_result: rulesResult,
        triggered_rules: evaluatedRisk.triggeredRules,
        confidence: extraction.confidence,
      },
    });

    // Log status transition event
    await logAuditEvent({
      caseId,
      actorId: actor.id,
      eventType: "status_changed",
      metadata: {
        from: "processing",
        to: "queued",
      },
    });

    return {
      case_id: caseId,
      status: "queued",
      risk_level: finalRisk,
      ai_rules_disagreement: hasDisagreement,
    };
  } catch (err) {
    // If the error occurred before the case entered 'processing', rethrow directly
    if (!isInProcessingState) {
      throw err;
    }

    // Fail-Safe Catch: prevent case from being orphaned in 'processing' forever
    console.error(
      `[Processing Orchestrator Error] Unexpected exception processing case ${caseId}:`,
      err
    );

    try {
      assertValidTransition("processing", "manual_fallback");

      await db
        .update(triageCases)
        .set({
          status: "manual_fallback",
          updatedAt: new Date(),
        })
        .where(eq(triageCases.id, caseId));

      await logAuditEvent({
        caseId,
        actorId: actor.id,
        eventType: "ai_report_generated",
        metadata: {
          success: false,
          reason: "unhandled_runtime_bug",
          is_bug: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });

      await logAuditEvent({
        caseId,
        actorId: actor.id,
        eventType: "status_changed",
        metadata: {
          from: "processing",
          to: "manual_fallback",
          reason: "recovered_from_unexpected_error",
        },
      });

      return {
        case_id: caseId,
        status: "manual_fallback",
        risk_level: null,
        ai_rules_disagreement: false,
      };
    } catch (recoveryErr) {
      console.error(
        `[Processing Orchestrator Fatal] Could not recover case ${caseId} to manual_fallback:`,
        recoveryErr
      );
      throw err;
    }
  }
}
