import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import {
  auditLog,
  caseReportVersions,
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function buildCaseFormData(payload: Record<string, any>): FormData {
  const form = new FormData();
  for (const [key, val] of Object.entries(payload)) {
    if (key === "vitals" && typeof val === "object") {
      form.append(key, JSON.stringify(val));
    } else if (val !== undefined && val !== null) {
      form.append(key, String(val));
    }
  }
  form.append(
    "image",
    new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
    "report.png"
  );
  return form;
}

export async function runReviewFullLoopTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Full End-to-End Vertical Slice Loop     ");
  console.log("=======================================================");

  const timestamp = Date.now();
  const passwordHash = await bcrypt.hash("DoctorPass123!", 10);

  // 1. Setup Doctor in Database
  const doctorEmail = `dr_slice_${timestamp}@hospital.org`;
  const [doctorUser] = await db
    .insert(users)
    .values({
      name: "Dr. Slice Verifier",
      email: doctorEmail,
      passwordHash,
      role: "doctor",
    })
    .returning();

  let patientUserId: string | null = null;
  let patientProfileId: string | null = null;
  const createdCaseIds: string[] = [];

  try {
    // ========================================================================
    // Step A: Register Patient via HTTP
    // ========================================================================
    console.log("\n[Loop 1] Register Patient via POST /api/auth/register");
    const regEmail = `patient_slice_${timestamp}@example.com`;
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Samantha Slice",
        email: regEmail,
        password: "PatientPass123!",
        phone_number: "+919888877777",
      }),
    });

    assert.equal(regRes.status, 201, "Registration must succeed with 201");
    const regData = await regRes.json();
    patientUserId = regData.user_id;

    // Login patient to get JWT
    const pLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: regEmail,
        password: "PatientPass123!",
      }),
    });
    const { token: patientToken } = await pLoginRes.json();
    assert.ok(patientToken, "Patient JWT token acquired");

    // Login doctor to get JWT
    const docLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: doctorEmail,
        password: "DoctorPass123!",
      }),
    });
    const { token: doctorToken } = await docLoginRes.json();
    assert.ok(doctorToken, "Doctor JWT token acquired");

    // ========================================================================
    // Step B: Record Active Consent via POST /api/consent
    // ========================================================================
    console.log("\n[Loop 2] Record Consent via POST /api/consent");
    const consentRes = await fetch(`${BASE_URL}/api/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        policy_version: "v1.0",
        given_by: "self",
      }),
    });
    assert.equal(consentRes.status, 201, "Consent must succeed with 201");
    const consentData = await consentRes.json();
    assert.ok(consentData.consent_id, "Consent ID returned");

    // ========================================================================
    // Step C: Create Case & Auto-Process via POST /api/cases
    // ========================================================================
    console.log(
      "\n[Loop 3] Create Case via POST /api/cases (Auto-Triggers Pipeline)"
    );
    const caseRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${patientToken}`,
      },
      body: buildCaseFormData({
        chief_complaint: "Acute onset dyspnea and tachycardia",
        duration: "3 hours",
        symptoms: "Severe difficulty catching breath while sitting resting",
        vitals: {
          spo2: 87,
          heartRate: 118,
          temperature: 37.8,
        },
      }),
    });

    assert.equal(caseRes.status, 201, "Case creation must succeed with 201");
    const caseData = await caseRes.json();
    const caseId = caseData.case_id;
    createdCaseIds.push(caseId);

    assert.equal(
      caseData.status,
      "queued",
      "Auto-processing must transition status to 'queued'"
    );
    console.log(
      `✓ Case created and auto-processed into 'queued' state: ${caseId}`
    );

    // ========================================================================
    // Step D: Confirm Case Appears in Doctor Queue via GET /api/queue
    // ========================================================================
    console.log("\n[Loop 4] Confirm Case Appears in GET /api/queue");
    const queueRes = await fetch(`${BASE_URL}/api/queue`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(queueRes.status, 200);
    const queueData = await queueRes.json();
    const queuedItem = queueData.queue.find((q: any) => q.case_id === caseId);

    assert.ok(queuedItem, "Case must appear in active doctor queue");
    assert.equal(queuedItem.status, "queued");
    assert.equal(
      queuedItem.risk_level,
      "critical",
      "SpO2 87% must evaluate to critical risk"
    );
    assert.equal(queuedItem.patient_display, "Samantha Slice");
    console.log("✓ Verified in queue with critical risk priority");

    // ========================================================================
    // Step E: Doctor Reviews Case via GET /api/cases/:id/review
    // ========================================================================
    console.log("\n[Loop 5] Doctor Reviews Case via GET /api/cases/:id/review");
    const reviewRes = await fetch(`${BASE_URL}/api/cases/${caseId}/review`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(reviewRes.status, 200);
    const reviewData = await reviewRes.json();

    assert.equal(reviewData.case_id, caseId);
    assert.ok(reviewData.report, "Full report object present");
    assert.equal(reviewData.report.risk_level, "critical");
    assert.ok(
      Array.isArray(reviewData.missing_info),
      "missing_info list present"
    );
    assert.ok(
      reviewData.ai_rules_disagreement,
      "ai_rules_disagreement flag present"
    );
    console.log("✓ Review endpoint returned full clinical report superset");

    // ========================================================================
    // Step F: Override Risk Level Validation Guard & Success
    // ========================================================================
    console.log("\n[Loop 6] PATCH /api/cases/:id/risk-level Validation Checks");

    // 6a. Missing reason -> 400 validation_error
    const noReasonRes = await fetch(
      `${BASE_URL}/api/cases/${caseId}/risk-level`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({
          risk_level: "high",
          // reason missing!
        }),
      }
    );
    assert.equal(noReasonRes.status, 400, "Missing reason must return 400");
    const noReasonData = await noReasonRes.json();
    assert.equal(noReasonData.error.code, "validation_error");
    console.log("✓ Empty reason rejected with 400 validation_error");

    // 6b. Whitespace-only reason -> 400 validation_error
    const wsReasonRes = await fetch(
      `${BASE_URL}/api/cases/${caseId}/risk-level`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({
          risk_level: "high",
          reason: "     ",
        }),
      }
    );
    assert.equal(
      wsReasonRes.status,
      400,
      "Whitespace-only reason must return 400"
    );
    const wsReasonData = await wsReasonRes.json();
    assert.equal(wsReasonData.error.code, "validation_error");
    console.log("✓ Whitespace-only reason rejected with 400 validation_error");

    // 6c. Valid Override -> 200 OK
    const validOverrideRes = await fetch(
      `${BASE_URL}/api/cases/${caseId}/risk-level`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({
          risk_level: "high",
          reason:
            "Patient responded well to supplemental oxygen, desaturation stabilized",
        }),
      }
    );
    assert.equal(validOverrideRes.status, 200);
    const validOverrideData = await validOverrideRes.json();
    assert.equal(validOverrideData.risk_level, "high");
    console.log("✓ Valid risk override applied successfully with reason");

    // ========================================================================
    // Step G: Doctor Edits Report via PATCH /api/cases/:id/edit
    // ========================================================================
    console.log("\n[Loop 7] Doctor Edits Report via PATCH /api/cases/:id/edit");
    const editRes = await fetch(`${BASE_URL}/api/cases/${caseId}/edit`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        chief_complaint: "Acute asthma exacerbation — post bronchodilator",
        symptoms: "Bilateral wheeze reducing, speaking in full sentences",
        vitals: {
          spo2: 95,
          heartRate: 98,
          temperature: 37.5,
        },
      }),
    });
    assert.equal(editRes.status, 200);
    const editData = await editRes.json();
    assert.equal(
      editData.new_version_number,
      2,
      "Report edit must increment version to 2"
    );

    // Confirm Version 2 in database and check audit log
    const dbVersions = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, caseId))
      .orderBy(caseReportVersions.versionNumber);
    assert.equal(
      dbVersions.length,
      2,
      "Database must hold version 1 and version 2"
    );
    assert.equal(dbVersions[0].source, "ai");
    assert.equal(dbVersions[1].source, "doctor_edit");
    assert.equal(dbVersions[1].editedBy, doctorUser.id);
    console.log(
      "✓ Version 2 confirmed in DB with source 'doctor_edit' and doctor attribution"
    );

    // ========================================================================
    // Step H: State Machine Out-of-Order Transition Guard (Close before Approve)
    // ========================================================================
    console.log("\n[Loop 8] State Machine Guard: Attempt CLOSE before APPROVE");
    const earlyCloseRes = await fetch(`${BASE_URL}/api/cases/${caseId}/close`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
    });
    assert.equal(
      earlyCloseRes.status,
      409,
      "Closing from queued must be blocked with 409"
    );
    const earlyCloseData = await earlyCloseRes.json();
    assert.equal(earlyCloseData.error.code, "invalid_state_transition");
    assert.equal(earlyCloseData.error.details.from, "queued");
    assert.equal(earlyCloseData.error.details.to, "closed");
    console.log(
      "✓ Out-of-order close blocked with 409 invalid_state_transition ({from: 'queued', to: 'closed'})"
    );

    // ========================================================================
    // Step I: Approve Case (queued -> assigned) via POST /api/cases/:id/approve
    // ========================================================================
    console.log(
      "\n[Loop 9] Doctor Approves Case via POST /api/cases/:id/approve"
    );
    const approveRes = await fetch(`${BASE_URL}/api/cases/${caseId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.status, "assigned");
    console.log("✓ Case transitioned: queued -> assigned");

    // ========================================================================
    // Step J: Close Case (assigned -> closed) via POST /api/cases/:id/close
    // ========================================================================
    console.log("\n[Loop 10] Doctor Closes Case via POST /api/cases/:id/close");
    const closeRes = await fetch(`${BASE_URL}/api/cases/${caseId}/close`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
    });
    assert.equal(closeRes.status, 200);
    const closeData = await closeRes.json();
    assert.equal(closeData.status, "closed");
    console.log("✓ Case transitioned: assigned -> closed");

    // Confirm closed case no longer appears in active queue
    const postCloseQueueRes = await fetch(`${BASE_URL}/api/queue`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    const postCloseQueueData = await postCloseQueueRes.json();
    const closedInQueue = postCloseQueueData.queue.find(
      (q: any) => q.case_id === caseId
    );
    assert.equal(
      closedInQueue,
      undefined,
      "Closed case must no longer appear in active queue"
    );
    console.log("✓ Confirmed closed case is removed from active doctor queue");

    // Confirm audit logs cover the entire vertical slice
    const caseAuditLogs = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, caseId))
      .orderBy(auditLog.createdAt);

    const loggedEventTypes = caseAuditLogs.map((a) => a.eventType);
    assert.ok(
      loggedEventTypes.includes("intake_submitted"),
      "Must log intake_submitted"
    );
    assert.ok(
      loggedEventTypes.includes("ai_report_generated"),
      "Must log ai_report_generated"
    );
    assert.ok(
      loggedEventTypes.includes("risk_overridden"),
      "Must log risk_overridden"
    );
    assert.ok(
      loggedEventTypes.includes("report_edited"),
      "Must log report_edited"
    );
    assert.ok(loggedEventTypes.includes("assigned"), "Must log assigned");
    assert.ok(loggedEventTypes.includes("closed"), "Must log closed");
    console.log(
      `✓ Full audit trail verified with all ${loggedEventTypes.length} lifecycle events!`
    );

    console.log("\n=======================================================");
    console.log("✓ FULL VERTICAL SLICE END-TO-END TEST PASSED 100%!");
    console.log("=======================================================");
  } finally {
    // Cleanup
    if (createdCaseIds.length > 0) {
      await db
        .delete(caseReportVersions)
        .where(inArray(caseReportVersions.caseId, createdCaseIds));
      await db.delete(auditLog).where(inArray(auditLog.caseId, createdCaseIds));
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
    }
    if (patientUserId) {
      const [pUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, patientUserId));
      patientProfileId = pUser?.patientId ?? null;
      if (patientProfileId) {
        await db.delete(consent).where(eq(consent.patientId, patientProfileId));
      }
      await db.delete(users).where(eq(users.id, patientUserId));
      if (patientProfileId) {
        await db.delete(patients).where(eq(patients.id, patientProfileId));
      }
    }
    await db.delete(users).where(eq(users.id, doctorUser.id));
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("review-full-loop.test.ts") ||
    process.argv[1].endsWith("review-full-loop.test.js"))
) {
  runReviewFullLoopTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Full loop test failed:", err);
      process.exit(1);
    });
}
