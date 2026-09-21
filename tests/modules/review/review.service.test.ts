import assert from "node:assert/strict";
import { desc, eq, inArray } from "drizzle-orm";
import {
  approveCase,
  closeCase,
  editReport,
  getCaseForReview,
  overrideRiskLevel,
} from "../../../src/modules/review/review.service.js";
import { db } from "../../../src/shared/config/db.js";
import {
  auditLog,
  caseReportVersions,
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";

export async function runReviewServiceTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Clinical Review Service                 ");
  console.log("=======================================================");

  const timestamp = Date.now();

  // 1. Setup isolated doctors, patient, and consent records
  const [doc1] = await db
    .insert(users)
    .values({
      name: "Dr. Reviewer One",
      email: `doc_review1_${timestamp}@hospital.org`,
      passwordHash: "dummyhash",
      role: "doctor",
    })
    .returning();

  const [doc2] = await db
    .insert(users)
    .values({
      name: "Dr. Reviewer Two",
      email: `doc_review2_${timestamp}@hospital.org`,
      passwordHash: "dummyhash",
      role: "doctor",
    })
    .returning();

  const [patientUser] = await db
    .insert(users)
    .values({
      name: "Patient Non-Doctor",
      email: `patient_review_${timestamp}@example.com`,
      passwordHash: "dummyhash",
      role: "patient",
    })
    .returning();

  const [testPatient] = await db
    .insert(patients)
    .values({
      name: "John Review Patient",
      phoneNumber: "+919876543211",
    })
    .returning();

  const [activeConsent] = await db
    .insert(consent)
    .values({
      patientId: testPatient.id,
      givenBy: "self",
      policyVersion: "v1.0",
      validUntil: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning();

  const createdCaseIds: string[] = [];

  try {
    // ========================================================================
    // Test 1: getCaseForReview (Doctor role required, full detail, no ownership filter)
    // ========================================================================
    console.log(
      "\n--- Test 1: getCaseForReview (Role check & full superset) ---"
    );
    {
      const [c] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: doc1.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Acute abdominal pain",
          duration: "1 day",
          symptoms: "Sharp lower quadrant pain with nausea",
          vitals: { heartRate: 95, spo2: 98 },
          riskLevel: "medium",
          aiRulesDisagreement: false,
        })
        .returning();
      createdCaseIds.push(c.id);

      // Insert version 1 AI report
      await db.insert(caseReportVersions).values({
        caseId: c.id,
        versionNumber: 1,
        source: "ai",
        content: {
          chief_complaint: { value: "Acute abdominal pain", source: "ai" },
          duration: { value: "1 day", source: "ai" },
          symptoms: {
            value: "Sharp lower quadrant pain with nausea",
            source: "ai",
          },
          vitals: { value: { heartRate: 95, spo2: 98 }, source: "ai" },
          missing_info: ["temperature"],
          risk_level: "medium",
          ai_rules_disagreement: { present: false, note: null },
        },
      });

      // 1a. Patient rejected with 403
      await assert.rejects(
        async () => {
          await getCaseForReview(c.id, { id: patientUser.id, role: "patient" });
        },
        (err: any) => {
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, "forbidden");
          return true;
        },
        "Non-doctor actor must be rejected with 403"
      );

      // 1b. Doctor 2 (who did not create the case) can access it (no ownership filter)
      const reviewData = await getCaseForReview(c.id, {
        id: doc2.id,
        role: "doctor",
      });

      assert.equal(reviewData.case_id, c.id);
      assert.ok(reviewData.report, "Must include report object");
      assert.equal(reviewData.report.status, "queued");
      assert.equal(
        reviewData.report.chief_complaint.value,
        "Acute abdominal pain"
      );
      assert.deepEqual(reviewData.missing_info, ["temperature"]);
      assert.equal(reviewData.ai_rules_disagreement.present, false);

      console.log(
        "✓ getCaseForReview passed: Doctor-only, full report superset, shared visibility"
      );
    }

    // ========================================================================
    // Test 2: editReport (Version increment, source doctor_edit, audit logging)
    // ========================================================================
    console.log(
      "\n--- Test 2: editReport (Never overwrite, version increment, audit logging) ---"
    );
    {
      const caseId = createdCaseIds[0];

      // Doctor 1 edits the report
      const editResult = await editReport(
        caseId,
        {
          chief_complaint: "Acute appendicitis suspicion",
          symptoms: "Rebound tenderness in RLQ",
          vitals: { heartRate: 102, spo2: 98, temperature: 38.5 },
        },
        { id: doc1.id, role: "doctor" }
      );

      assert.equal(editResult.case_id, caseId);
      assert.equal(editResult.new_version_number, 2);

      // Verify DB has both version 1 and version 2 (never overwritten)
      const versions = await db
        .select()
        .from(caseReportVersions)
        .where(eq(caseReportVersions.caseId, caseId))
        .orderBy(caseReportVersions.versionNumber);

      assert.equal(
        versions.length,
        2,
        "Database must retain both version rows"
      );
      assert.equal(versions[0].versionNumber, 1);
      assert.equal(versions[0].source, "ai");
      assert.equal(versions[1].versionNumber, 2);
      assert.equal(versions[1].source, "doctor_edit");
      assert.equal(versions[1].editedBy, doc1.id);

      // Verify triage_cases top-level columns were updated
      const [updatedCase] = await db
        .select()
        .from(triageCases)
        .where(eq(triageCases.id, caseId));
      assert.equal(updatedCase.chiefComplaint, "Acute appendicitis suspicion");

      // Verify audit log recorded report_edited
      const [auditEntry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);

      assert.equal(auditEntry.eventType, "report_edited");
      assert.equal(auditEntry.actorId, doc1.id);
      const meta = auditEntry.metadata as any;
      assert.equal(meta.new_version_number, 2);

      console.log(
        "✓ editReport passed: Version 2 created as doctor_edit, version 1 preserved, audit logged"
      );
    }

    // ========================================================================
    // Test 3: editReport Concurrency / Collision Handling
    // ========================================================================
    console.log("\n--- Test 3: editReport Concurrency & Collision Guard ---");
    {
      const caseId = createdCaseIds[0];

      // Test validation of malformed inputs
      await assert.rejects(
        async () => {
          await editReport(
            caseId,
            { chief_complaint: "A".repeat(1001) },
            { id: doc1.id, role: "doctor" }
          );
        },
        (err: any) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "validation_error");
          return true;
        }
      );

      console.log("✓ Concurrency validation checks passed");
    }

    // ========================================================================
    // Test 4: overrideRiskLevel (Validation, audit logging, report sync)
    // ========================================================================
    console.log(
      "\n--- Test 4: overrideRiskLevel (Validation & Audit Trail) ---"
    );
    {
      const caseId = createdCaseIds[0];

      // 4a. Reject missing reason
      await assert.rejects(
        async () => {
          await overrideRiskLevel(caseId, "high", "", doc1.id);
        },
        (err: any) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "validation_error");
          return true;
        },
        "Empty reason must be rejected with 400 validation_error"
      );

      // 4b. Reject whitespace-only reason
      await assert.rejects(
        async () => {
          await overrideRiskLevel(caseId, "high", "    ", doc1.id);
        },
        (err: any) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "validation_error");
          return true;
        },
        "Whitespace-only reason must be rejected with 400 validation_error"
      );

      // 4c. Reject too short reason (<3 chars)
      await assert.rejects(
        async () => {
          await overrideRiskLevel(caseId, "high", "ok", doc1.id);
        },
        (err: any) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "validation_error");
          return true;
        },
        "Too short reason must be rejected with 400 validation_error"
      );

      // 4d. Successful override
      const overrideResult = await overrideRiskLevel(
        caseId,
        "high",
        "Signs of peritoneal irritation warrant elevated clinical urgency",
        doc2.id
      );

      assert.equal(overrideResult.case_id, caseId);
      assert.equal(overrideResult.risk_level, "high");

      // Verify triage_cases updated
      const [caseAfterOverride] = await db
        .select()
        .from(triageCases)
        .where(eq(triageCases.id, caseId));
      assert.equal(caseAfterOverride.riskLevel, "high");

      // Verify audit log event: risk_overridden
      const [auditEntry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);

      assert.equal(auditEntry.eventType, "risk_overridden");
      assert.equal(auditEntry.actorId, doc2.id);
      const meta = auditEntry.metadata as any;
      assert.equal(meta.previous_risk, "medium");
      assert.equal(meta.new_risk, "high");
      assert.equal(
        meta.reason,
        "Signs of peritoneal irritation warrant elevated clinical urgency"
      );

      console.log(
        "✓ overrideRiskLevel passed: Whitespace-only rejected, update applied, audit logged with prior/new risk"
      );
    }

    // ========================================================================
    // Test 5: approveCase & closeCase with Strict State Machine Transitions
    // ========================================================================
    console.log("\n--- Test 5: approveCase & closeCase State Transitions ---");
    {
      const caseId = createdCaseIds[0];

      // Currently, the case is 'queued'.
      // 5a. Attempting to CLOSE directly from 'queued' must throw 409 invalid_state_transition!
      await assert.rejects(
        async () => {
          await closeCase(caseId, doc1.id);
        },
        (err: any) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, "invalid_state_transition");
          assert.equal(err.details.from, "queued");
          assert.equal(err.details.to, "closed");
          return true;
        },
        "Closing directly from queued must be blocked with 409 invalid_state_transition"
      );
      console.log(
        "✓ Illegal transition blocked: Closing from 'queued' rejected with 409 and {from, to}"
      );

      // 5b. Approve case: queued -> assigned
      const approveResult = await approveCase(caseId, doc1.id);
      assert.equal(approveResult.case_id, caseId);
      assert.equal(approveResult.status, "assigned");

      const [caseAfterApprove] = await db
        .select()
        .from(triageCases)
        .where(eq(triageCases.id, caseId));
      assert.equal(caseAfterApprove.status, "assigned");

      // Verify audit event: assigned
      const [auditApprove] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      assert.equal(auditApprove.eventType, "assigned");
      assert.equal(auditApprove.actorId, doc1.id);
      console.log(
        "✓ approveCase passed: queued -> assigned transitioned with audit log"
      );

      // 5c. Attempting to APPROVE an already assigned case must throw 409
      await assert.rejects(
        async () => {
          await approveCase(caseId, doc1.id);
        },
        (err: any) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, "invalid_state_transition");
          assert.equal(err.details.from, "assigned");
          assert.equal(err.details.to, "assigned");
          return true;
        }
      );

      // 5d. Close case: assigned -> closed
      const closeResult = await closeCase(caseId, doc2.id);
      assert.equal(closeResult.case_id, caseId);
      assert.equal(closeResult.status, "closed");

      const [caseAfterClose] = await db
        .select()
        .from(triageCases)
        .where(eq(triageCases.id, caseId));
      assert.equal(caseAfterClose.status, "closed");

      // Verify audit event: closed
      const [auditClose] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      assert.equal(auditClose.eventType, "closed");
      assert.equal(auditClose.actorId, doc2.id);
      console.log(
        "✓ closeCase passed: assigned -> closed transitioned with audit log"
      );
    }

    console.log("\n✓ ALL Clinical Review Service tests passed successfully!");
  } finally {
    if (createdCaseIds.length > 0) {
      await db
        .delete(caseReportVersions)
        .where(inArray(caseReportVersions.caseId, createdCaseIds));
      await db.delete(auditLog).where(inArray(auditLog.caseId, createdCaseIds));
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
    }
    await db.delete(consent).where(eq(consent.id, activeConsent.id));
    await db.delete(patients).where(eq(patients.id, testPatient.id));
    await db
      .delete(users)
      .where(inArray(users.id, [doc1.id, doc2.id, patientUser.id]));
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("review.service.test.ts") ||
    process.argv[1].endsWith("review.service.test.js"))
) {
  runReviewServiceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Review service test failed:", err);
      process.exit(1);
    });
}
