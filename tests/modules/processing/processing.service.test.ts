import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import {
  auditLog,
  caseReportVersions,
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";
import { processCase } from "../../../src/modules/processing/processing.service.js";

export async function runProcessingServiceTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Processing Orchestrator (Step 26)       ");
  console.log("=======================================================");

  // 1. Setup test patient, user, and consent
  let [testUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "processing-test@example.com"));

  let patientId: string;
  let userId: string;

  if (!testUser) {
    const [newPatient] = await db
      .insert(patients)
      .values({ name: "Processing Test Patient", phoneNumber: "+919876543210" })
      .returning();
    patientId = newPatient.id;

    const [newUser] = await db
      .insert(users)
      .values({
        name: "Processing Test User",
        email: "processing-test@example.com",
        passwordHash: "hash",
        role: "patient",
        patientId,
      })
      .returning();
    userId = newUser.id;
  } else {
    userId = testUser.id;
    patientId = testUser.patientId!;
  }

  // Ensure active consent
  let [activeConsent] = await db
    .select()
    .from(consent)
    .where(eq(consent.patientId, patientId))
    .limit(1);

  if (!activeConsent) {
    [activeConsent] = await db
      .insert(consent)
      .values({
        patientId,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
  }

  const actor = { id: userId, role: "patient" };

  // Helper to create a submitted case
  async function createSubmittedCase(
    overrides: Partial<typeof triageCases.$inferInsert> = {}
  ) {
    const [c] = await db
      .insert(triageCases)
      .values({
        patientId,
        createdBy: userId,
        consentId: activeConsent.id,
        mode: "self",
        status: "submitted",
        chiefComplaint: overrides.chiefComplaint ?? "Mild cold and sore throat",
        duration: overrides.duration ?? "2 days",
        symptoms: overrides.symptoms ?? "runny nose, mild sore throat",
        vitals: overrides.vitals ?? {
          spo2: 99,
          heartRate: 75,
          temperature: 98.6,
        },
        ...overrides,
      })
      .returning();
    return c;
  }

  // ==========================================================================
  // Test 1: Happy Path Processing Orchestration
  // ==========================================================================
  console.log("\n--- Test 1: Happy Path AI Extraction + Rules Engine ---");
  {
    const testCase = await createSubmittedCase();

    const result = await processCase(testCase.id, actor);

    assert.equal(result.case_id, testCase.id);
    assert.equal(result.status, "queued");
    assert.equal(result.risk_level, "low");
    assert.equal(result.ai_rules_disagreement, false);

    // Verify DB case row
    const [updatedCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, testCase.id));

    assert.equal(updatedCase.status, "queued");
    assert.equal(updatedCase.riskLevel, "low");
    assert.equal(updatedCase.aiRulesDisagreement, false);

    // Verify report version 1 was written
    const [reportVersion] = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, testCase.id));

    assert.ok(reportVersion !== undefined, "Report version 1 must be created");
    assert.equal(reportVersion.versionNumber, 1);
    assert.equal(reportVersion.source, "ai");

    const content = reportVersion.content as Record<string, unknown>;
    assert.equal(content.risk_level, "low");

    // Verify audit log entries
    const logs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, testCase.id));

    assert.ok(
      logs.some((l) => l.eventType === "status_changed"),
      "status_changed audit event must exist"
    );
    assert.ok(
      logs.some((l) => l.eventType === "ai_report_generated"),
      "ai_report_generated audit event must exist"
    );

    console.log(
      "✓ Happy path passed: Case moved submitted -> processing -> queued with version 1 report and audit logs"
    );
  }

  // ==========================================================================
  // Test 2: AI vs Rules Disagreement Safety Invariant (Core Pitch Defense)
  // ==========================================================================
  console.log(
    "\n--- Test 2: AI vs Rules Disagreement (Rules Engine Always Wins) ---"
  );
  {
    // Patient has severe hypoxemia (SpO2: 86) -> Rules engine flags CRITICAL.
    // We simulate AI suggesting "low".
    const severeCase = await createSubmittedCase({
      chiefComplaint: "Shortness of breath",
      symptoms: "difficulty breathing",
      vitals: { spo2: 86, heartRate: 110 },
    });

    const result = await processCase(severeCase.id, actor, {
      aiSuggestedRisk: "low",
    });

    assert.equal(result.status, "queued");
    // SAFETY INVARIANT CHECK:
    assert.equal(
      result.risk_level,
      "critical",
      "Rules engine result (critical) MUST win over AI suggested risk (low)"
    );
    assert.equal(result.ai_rules_disagreement, true);

    // Check DB row
    const [dbCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, severeCase.id));

    assert.equal(dbCase.riskLevel, "critical");
    assert.equal(dbCase.aiRulesDisagreement, true);

    // Check report version content
    const [reportVersion] = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, severeCase.id));

    const content = reportVersion.content as any;
    assert.equal(content.risk_level, "critical");
    assert.equal(content.ai_rules_disagreement.present, true);
    assert.equal(content.ai_rules_disagreement.ai_suggested, "low");
    assert.equal(content.ai_rules_disagreement.rules_result, "critical");
    assert.equal(content.ai_rules_disagreement.note, "rules result applies");

    console.log(
      "✓ Disagreement passed: AI said 'low', rules engine said 'critical', final stored risk is 'critical' with disagreement: true"
    );
  }

  // ==========================================================================
  // Test 3: AI Failure / Low-Confidence Routing (Demo Scenario D)
  // ==========================================================================
  console.log(
    "\n--- Test 3: AI Failure / Low-Confidence Routing (Demo Scenario D) ---"
  );
  {
    const lowConfCase = await createSubmittedCase({
      chiefComplaint: "unreadable handwriting",
    });

    const result = await processCase(lowConfCase.id, actor, {
      simulateLowConfidence: true,
    });

    assert.equal(result.status, "manual_fallback");
    assert.equal(result.risk_level, null);
    assert.equal(result.ai_rules_disagreement, false);

    // Verify DB case row status is manual_fallback (never queued!)
    const [dbCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, lowConfCase.id));

    assert.equal(dbCase.status, "manual_fallback");

    // Verify audit log explicitly flags the low confidence without marking as bug
    const logs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, lowConfCase.id));

    const aiReportLog = logs.find((l) => l.eventType === "ai_report_generated");
    assert.ok(aiReportLog, "ai_report_generated log must be recorded");
    const meta = aiReportLog.metadata as any;
    assert.equal(meta.success, false);
    assert.equal(meta.reason, "low_confidence");
    assert.equal(meta.is_bug, false);

    console.log(
      "✓ Demo Scenario D passed: Low confidence routed cleanly to manual_fallback with distinct audit log"
    );
  }

  // ==========================================================================
  // Test 4: Skip AI Path (Manual Fallback Re-evaluation)
  // ==========================================================================
  console.log("\n--- Test 4: Skip AI Path (Manual Fallback Re-evaluation) ---");
  {
    // Start with a case in manual_fallback
    const manualCase = await createSubmittedCase({
      chiefComplaint: "Severe headache and elevated BP",
      symptoms: "dizziness and throbbing pain",
      vitals: { systolic_bp: 190, diastolic_bp: 115 },
    });

    // Move to manual_fallback first
    await processCase(manualCase.id, actor, { simulateLowConfidence: true });

    // Doctor reviews and triggers re-run with skip_ai: true
    const reEvalResult = await processCase(
      manualCase.id,
      { id: userId, role: "doctor" },
      { skip_ai: true }
    );

    assert.equal(reEvalResult.status, "queued");
    assert.equal(reEvalResult.risk_level, "high"); // Hypertensive emergency threshold
    assert.equal(reEvalResult.ai_rules_disagreement, false);

    // Check version 2 was created with source: 'manual'
    const versions = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, manualCase.id))
      .orderBy(caseReportVersions.versionNumber);

    const latestVersion = versions[versions.length - 1];
    assert.ok(latestVersion, "Manual report version must exist");
    assert.equal(latestVersion.source, "manual");

    console.log(
      "✓ Skip AI passed: manual_fallback re-evaluation transitioned directly to queued with source: 'manual'"
    );
  }

  // ==========================================================================
  // Test 5: Fault-Tolerance (Prevent Orphaned Cases in 'processing')
  // ==========================================================================
  console.log(
    "\n--- Test 5: Fault-Tolerance Against Unexpected Exceptions ---"
  );
  {
    const buggyCase = await createSubmittedCase();

    // Trigger unexpected provider failure
    const result = await processCase(buggyCase.id, actor, {
      simulateFailure: true,
    });

    // Should fall back safely to manual_fallback
    assert.equal(result.status, "manual_fallback");

    const [dbCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, buggyCase.id));

    assert.equal(
      dbCase.status,
      "manual_fallback",
      "Case must not be orphaned in 'processing'"
    );

    console.log(
      "✓ Fault-tolerance passed: Unexpected exception safely caught and routed to manual_fallback"
    );
  }

  console.log("\n✓ ALL Step 26 Processing Service tests passed!");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("processing.service.test.ts") ||
    process.argv[1].endsWith("processing.service.test.js"))
) {
  runProcessingServiceTests()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Processing service test failed:", err);
      process.exit(1);
    });
}
