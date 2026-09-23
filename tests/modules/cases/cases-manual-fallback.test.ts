import assert from "node:assert/strict";
import { db } from "../../../src/shared/config/db.js";
import {
  users,
  patients,
  consent,
  triageCases,
  caseReportVersions,
  auditLog,
} from "../../../src/shared/config/schema.js";
import { eq, inArray } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../../../src/shared/config/env.js";
import {
  submitManualFallback,
  type SubmitManualFallbackInput,
} from "../../../src/modules/cases/cases.service.js";
import { AppError } from "../../../src/shared/utils/AppError.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

// Minimal valid PNG (Image) buffer
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export async function runCasesManualFallbackTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Manual Fallback Submission (API §6)       ");
  console.log("========================================================");

  let patientAUserId = "";
  let patientBUserId = "";
  let doctorUserId = "";
  let receptionistUserId = "";
  let patientA: any = null;
  let patientConsent: any = null;
  const createdCaseIds: string[] = [];

  try {
    // 1. Setup Patient A
    const [pA] = await db
      .insert(patients)
      .values({ name: "Manual Fallback Patient A" })
      .returning();
    patientA = pA;

    const [uA] = await db
      .insert(users)
      .values({
        name: "User Fallback Patient A",
        email: `patient.fallback.a.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: pA.id,
      })
      .returning();
    patientAUserId = uA.id;

    // 2. Setup Patient B (non-owner)
    const [pB] = await db
      .insert(patients)
      .values({ name: "Manual Fallback Patient B" })
      .returning();

    const [uB] = await db
      .insert(users)
      .values({
        name: "User Fallback Patient B",
        email: `patient.fallback.b.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: pB.id,
      })
      .returning();
    patientBUserId = uB.id;

    // 3. Setup Doctor
    const [uDoc] = await db
      .insert(users)
      .values({
        name: "User Fallback Doctor",
        email: `doc.fallback.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "doctor",
      })
      .returning();
    doctorUserId = uDoc.id;

    // 4. Setup Receptionist
    const [uRecep] = await db
      .insert(users)
      .values({
        name: "User Fallback Receptionist",
        email: `recep.fallback.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "receptionist",
      })
      .returning();
    receptionistUserId = uRecep.id;

    // JWT tokens
    const tokenPatientA = jwt.sign(
      { sub: uA.id, role: "patient" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );
    const tokenPatientB = jwt.sign(
      { sub: uB.id, role: "patient" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );
    const tokenDoctor = jwt.sign(
      { sub: uDoc.id, role: "doctor" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );

    // Consent
    const [c] = await db
      .insert(consent)
      .values({
        patientId: pA.id,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
    patientConsent = c;

    // Create a base case in 'manual_fallback' status
    const [fbCase] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: c.id,
        mode: "self",
        status: "manual_fallback",
        chiefComplaint: "Initial complaint before fallback",
      })
      .returning();
    createdCaseIds.push(fbCase.id);

    // ------------------------------------------------------------------------
    // Test 1: Status Guard — Reject when status !== 'manual_fallback' (409)
    // ------------------------------------------------------------------------
    console.log("  → Test 1: Guard: only valid when status === 'manual_fallback' (409)");
    // Case in 'submitted' status
    const [subCase] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: c.id,
        mode: "self",
        status: "submitted",
        chiefComplaint: "Complaint in submitted state",
      })
      .returning();
    createdCaseIds.push(subCase.id);

    let submittedRejected = false;
    try {
      await submitManualFallback(
        subCase.id,
        { chief_complaint: "New complaint" },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) {
        submittedRejected = true;
      }
    }
    assert.ok(submittedRejected, "Must reject submission when status is 'submitted' with 409");

    // Case in 'queued' status
    const [queuedCase] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: c.id,
        mode: "self",
        status: "queued",
        chiefComplaint: "Complaint in queued state",
      })
      .returning();
    createdCaseIds.push(queuedCase.id);

    let queuedRejected = false;
    try {
      await submitManualFallback(
        queuedCase.id,
        { chief_complaint: "New complaint" },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) {
        queuedRejected = true;
      }
    }
    assert.ok(queuedRejected, "Must reject submission when status is 'queued' with 409");
    console.log("  ✓ Status guard confirmed: non-fallback statuses rejected with 409");

    // ------------------------------------------------------------------------
    // Test 2: Row-level Ownership Check (Anti-Enumeration 404 & Role 403)
    // ------------------------------------------------------------------------
    console.log("  → Test 2: Row-level ownership checks (404 anti-enumeration, 403 doctor)");
    // Patient B attempts on Patient A's case
    let nonOwnerRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Attacker complaint" },
        { id: uB.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        nonOwnerRejected = true;
      }
    }
    // Non-owner patient attempts on a case that is BOTH not theirs AND not in manual_fallback (e.g. 'submitted')
    // Anti-enumeration requirement: MUST return 404 not_found, NOT 409 invalid_state_transition
    let nonOwnerWrongStatusRejectedWith404 = false;
    try {
      await submitManualFallback(
        subCase.id, // status === 'submitted', belongs to Patient A
        { chief_complaint: "Attacker probing status" },
        { id: uB.id, role: "patient" } // Patient B (non-owner)
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        nonOwnerWrongStatusRejectedWith404 = true;
      }
    }
    assert.ok(
      nonOwnerWrongStatusRejectedWith404,
      "Anti-enumeration: Non-owner on a non-manual_fallback case must receive 404 not_found (never leak status via 409)"
    );

    // Doctor attempts fallback
    let docRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Doctor complaint" },
        { id: uDoc.id, role: "doctor" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 403) {
        docRejected = true;
      }
    }
    assert.ok(docRejected, "Doctor must receive 403 forbidden");
    console.log("  ✓ Ownership confirmed: non-owner gets 404 (even on non-fallback cases), doctor gets 403");

    // ------------------------------------------------------------------------
    // Test 3: Validation Rigor for Manually-Entered Vitals & Bounds
    // ------------------------------------------------------------------------
    console.log("  → Test 3: Validation rigor for free-text & physiological vitals");
    // Missing chief_complaint
    let emptyComplaintRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "   " },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        emptyComplaintRejected = true;
      }
    }
    assert.ok(emptyComplaintRejected, "Empty chief_complaint must be rejected with 400");

    // Negative heart rate (-5)
    let negativeHrRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Valid complaint", vitals: { heartRate: -5 } },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        negativeHrRejected = true;
      }
    }
    assert.ok(negativeHrRejected, "Negative heart rate must be rejected with 400");

    // Impossibly high heart rate (9999)
    let hugeHrRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Valid complaint", vitals: { heartRate: 9999 } },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        hugeHrRejected = true;
      }
    }
    assert.ok(hugeHrRejected, "Implausible heart rate (9999) must be rejected with 400");

    // Impossibly high SpO2 (150%)
    let highSpo2Rejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Valid complaint", vitals: { spo2: 150 } },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        highSpo2Rejected = true;
      }
    }
    assert.ok(highSpo2Rejected, "SpO2 > 100 must be rejected with 400");

    // Non-numeric vital value
    let nonNumericRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        { chief_complaint: "Valid complaint", vitals: { bloodSugar: "very_high" } },
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        nonNumericRejected = true;
      }
    }
    assert.ok(nonNumericRejected, "Non-numeric vital must be rejected with 400");
    console.log("  ✓ Validation rigor confirmed: implausible physiological numbers rejected with 400");

    // ------------------------------------------------------------------------
    // Test 4: Happy Path — Rules Engine Re-run & Version 1 Report
    // ------------------------------------------------------------------------
    console.log("  → Test 4: Happy Path: submitManualFallback runs rules engine & transitions to queued");
    const validFallbackInput: SubmitManualFallbackInput = {
      chief_complaint: "Severe shortness of breath and wheezing",
      duration: "3 hours",
      symptoms: "Labored breathing, inability to lie flat",
      vitals: {
        spo2: 88, // Triggers RR-CRIT-01 (< 90)
        heartRate: 115,
        temperature: 99.2,
      },
    };

    const fallbackResult = await submitManualFallback(
      fbCase.id,
      validFallbackInput,
      { id: uA.id, role: "patient" }
    );

    assert.equal(fallbackResult.case_id, fbCase.id);
    assert.equal(fallbackResult.status, "queued");
    assert.equal(fallbackResult.risk_level, "critical", "Rules engine must evaluate SpO2 < 90 as critical");
    assert.equal(fallbackResult.version, 1, "Must generate version 1 report");

    // Verify DB triageCases row
    const [dbUpdatedCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, fbCase.id));
    assert.equal(dbUpdatedCase.status, "queued");
    assert.equal(dbUpdatedCase.riskLevel, "critical");
    assert.equal(dbUpdatedCase.chiefComplaint, "Severe shortness of breath and wheezing");

    // Verify caseReportVersions row
    const [dbReport] = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, fbCase.id));
    assert.ok(dbReport, "Must write into case_report_versions");
    assert.equal(dbReport.source, "manual", "Report source must be 'manual'");
    assert.equal(dbReport.versionNumber, 1);
    const content = dbReport.content as any;
    assert.equal(content.risk_level, "critical");
    assert.ok(content.triggered_rules.includes("RR-CRIT-01"), "Must record triggered rule RR-CRIT-01");
    assert.equal(content.chief_complaint.source, "manual");

    // Verify status_changed audit log
    const auditEntries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, fbCase.id))
      .orderBy(auditLog.createdAt);
    const statusChanged = auditEntries.find((e) => e.eventType === "status_changed");
    assert.ok(statusChanged, "Must log status_changed event");
    assert.equal((statusChanged.metadata as any)?.from, "manual_fallback");
    assert.equal((statusChanged.metadata as any)?.to, "queued");
    assert.equal((statusChanged.metadata as any)?.reason, "manual_fallback_submitted");
    console.log("  ✓ Happy path passed: rules engine evaluated critical risk, report version written, audit logged");

    // ------------------------------------------------------------------------
    // Test 5: Idempotency Guard — Second Submission Attempt Fails (409)
    // ------------------------------------------------------------------------
    console.log("  → Test 5: Idempotency: second submission attempt rejected with 409");
    let duplicateRejected = false;
    try {
      await submitManualFallback(
        fbCase.id,
        validFallbackInput,
        { id: uA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) {
        duplicateRejected = true;
      }
    }
    assert.ok(duplicateRejected, "Duplicate submission on now-queued case must reject with 409");
    console.log("  ✓ Idempotency confirmed: double submission blocked with 409");

    // ------------------------------------------------------------------------
    // Test 6: HTTP PATCH /api/cases/:id/manual-fallback Route
    // ------------------------------------------------------------------------
    console.log("  → Test 6: HTTP PATCH /api/cases/:id/manual-fallback endpoint test");
    // Create another case in 'manual_fallback' for HTTP test
    const [httpCase] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: c.id,
        mode: "self",
        status: "manual_fallback",
        chiefComplaint: "HTTP test case before fallback",
      })
      .returning();
    createdCaseIds.push(httpCase.id);

    // Non-owner HTTP request -> 404
    const nonOwnerHttp = await fetch(`${BASE_URL}/api/cases/${httpCase.id}/manual-fallback`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenPatientB}`,
      },
      body: JSON.stringify({ chief_complaint: "Hacker attempt" }),
    });
    assert.equal(nonOwnerHttp.status, 404, "HTTP non-owner must get 404");
    const nonOwnerJson = await nonOwnerHttp.json();
    assert.equal(nonOwnerJson.error?.code, "not_found", "HTTP non-owner must get not_found code");

    // Anti-enumeration over HTTP: Non-owner patient B attempts on subCase.id
    // (case exists, belongs to Patient A, and is in status 'submitted' rather than 'manual_fallback')
    // MUST return 404 not_found, NOT 409 invalid_state_transition
    const nonOwnerWrongStatusHttp = await fetch(
      `${BASE_URL}/api/cases/${subCase.id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientB}`,
        },
        body: JSON.stringify({ chief_complaint: "Attacker probing status" }),
      }
    );
    assert.equal(
      nonOwnerWrongStatusHttp.status,
      404,
      "HTTP non-owner on non-manual_fallback case must return 404 (never leak case existence/status via 409)"
    );
    const nonOwnerWrongStatusJson = await nonOwnerWrongStatusHttp.json();
    assert.equal(
      nonOwnerWrongStatusJson.error?.code,
      "not_found",
      "Error code must be not_found"
    );

    // Doctor HTTP request -> 403
    const docHttp = await fetch(`${BASE_URL}/api/cases/${httpCase.id}/manual-fallback`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenDoctor}`,
      },
      body: JSON.stringify({ chief_complaint: "Doctor attempt" }),
    });
    assert.equal(docHttp.status, 403, "HTTP doctor must get 403");

    // Owner HTTP valid fallback -> 200
    const ownerHttp = await fetch(`${BASE_URL}/api/cases/${httpCase.id}/manual-fallback`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenPatientA}`,
      },
      body: JSON.stringify({
        chief_complaint: "Mild persistent cough and sore throat",
        duration: "4 days",
        vitals: {
          spo2: 98,
          heartRate: 72,
          temperature: 98.6,
        },
      }),
    });
    assert.equal(ownerHttp.status, 200, "Valid fallback must return 200");
    const ownerData = await ownerHttp.json();
    assert.equal(ownerData.case_id, httpCase.id);
    assert.equal(ownerData.status, "queued");
    assert.equal(ownerData.risk_level, "low");

    console.log("  ✓ HTTP endpoint confirmed: 404 non-owner, 403 doctor, 200 valid owner");

    // ------------------------------------------------------------------------
    // Test 7: Full Failure-Recovery Loop & Queue Integration
    // ------------------------------------------------------------------------
    console.log("  → Test 7: Full Failure-Recovery Loop (AI Failure -> manual_fallback -> queued -> Doctor Queue)");

    // Step A: Force case into manual_fallback by submitting deliberate unparseable input (BAD_INPUT) with image
    const badInputForm = new FormData();
    badInputForm.append("chief_complaint", "BAD_INPUT: Unparseable blurred handwritten notes on intake");
    badInputForm.append("duration", "2 days");
    badInputForm.append(
      "image",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "unreadable_document.png"
    );

    const badInputRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenPatientA}` },
      body: badInputForm,
    });
    assert.equal(badInputRes.status, 201, "Case creation must succeed");
    const badInputCase = await badInputRes.json();
    assert.ok(badInputCase.case_id, "Must return case_id");
    createdCaseIds.push(badInputCase.case_id);

    // Verify it automatically landed in 'manual_fallback' due to AI extraction failure/low confidence
    assert.equal(
      badInputCase.status,
      "manual_fallback",
      "Case must land in 'manual_fallback' when AI extraction encounters bad/unparseable input"
    );

    // Confirm DB record shows 'manual_fallback'
    const [dbBadCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, badInputCase.case_id));
    assert.equal(dbBadCase.status, "manual_fallback");

    // Step B: Malformed manual input attempts on this manual_fallback case
    // 1. Non-numeric vital string
    const malformedVitalsRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientA}`,
        },
        body: JSON.stringify({
          chief_complaint: "Chest discomfort",
          vitals: { heartRate: "one-hundred-twenty" },
        }),
      }
    );
    assert.equal(malformedVitalsRes.status, 400, "Malformed non-numeric vital must return 400");
    const malformedVitalsData = await malformedVitalsRes.json();
    assert.equal(malformedVitalsData.error?.code, "validation_error");

    // 2. Empty / whitespace-only chief complaint
    const emptyComplaintRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientA}`,
        },
        body: JSON.stringify({
          chief_complaint: "   ",
          vitals: { heartRate: 80 },
        }),
      }
    );
    assert.equal(emptyComplaintRes.status, 400, "Empty chief complaint must return 400");
    const emptyComplaintData = await emptyComplaintRes.json();
    assert.equal(emptyComplaintData.error?.code, "validation_error");

    // 3. Implausible physiological bounds (HR 9999)
    const impossibleVitalsRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientA}`,
        },
        body: JSON.stringify({
          chief_complaint: "Chest discomfort",
          vitals: { heartRate: 9999 },
        }),
      }
    );
    assert.equal(impossibleVitalsRes.status, 400, "Implausible vitals must return 400");

    // Confirm that after all malformed attempts, case status is still 'manual_fallback' and 0 report versions exist
    const [caseStillFallback] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, badInputCase.case_id));
    assert.equal(caseStillFallback.status, "manual_fallback");

    const preVersions = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, badInputCase.case_id));
    assert.equal(preVersions.length, 0, "No report version should be created on failed validation");

    // Step C: Valid manual fallback data driving rules engine to CRITICAL risk
    const criticalFallbackRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientA}`,
        },
        body: JSON.stringify({
          chief_complaint: "Severe crushing chest pain radiating to left arm and jaw",
          duration: "45 minutes",
          symptoms: "Profuse sweating, severe shortness of breath, dizziness",
          vitals: {
            heartRate: 145,
            systolicBp: 200,
            diastolicBp: 115,
            spo2: 87,
            temperature: 98.6,
          },
        }),
      }
    );
    assert.equal(criticalFallbackRes.status, 200, "Valid fallback must return 200");
    const criticalFallbackData = await criticalFallbackRes.json();
    assert.equal(criticalFallbackData.case_id, badInputCase.case_id);
    assert.equal(criticalFallbackData.status, "queued");
    assert.equal(
      criticalFallbackData.risk_level,
      "critical",
      "Manual data with severe vitals/symptoms must drive rules engine to 'critical'"
    );

    // Verify report version 1 created with source 'manual'
    const postVersions = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, badInputCase.case_id));
    assert.equal(postVersions.length, 1);
    assert.equal(postVersions[0].versionNumber, 1);
    assert.equal(postVersions[0].source, "manual");
    const reportContent = postVersions[0].content as any;
    assert.equal(reportContent.risk_level, "critical");
    assert.equal(reportContent.chief_complaint?.source, "manual");
    assert.equal(reportContent.vitals?.source, "manual");
    assert.equal(reportContent.vitals?.value?.heartRate, 145);
    assert.equal(reportContent.vitals?.value?.spo2, 87);

    // Step D: Double submission test (Idempotency)
    // Immediately attempt to submit fallback again on the same case
    const doubleSubmitRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/manual-fallback`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenPatientA}`,
        },
        body: JSON.stringify({
          chief_complaint: "Retry submission with modified text",
          duration: "1 hour",
          vitals: { heartRate: 80, spo2: 99 },
        }),
      }
    );
    assert.equal(
      doubleSubmitRes.status,
      409,
      "Double submission must be rejected with 409 invalid_state_transition"
    );
    const doubleSubmitData = await doubleSubmitRes.json();
    assert.equal(doubleSubmitData.error?.code, "invalid_state_transition");

    // Verify case_report_versions STILL has only 1 row (no duplicate row created)
    const postDoubleVersions = await db
      .select()
      .from(caseReportVersions)
      .where(eq(caseReportVersions.caseId, badInputCase.case_id));
    assert.equal(
      postDoubleVersions.length,
      1,
      "Duplicate submission attempt must not create additional case_report_versions rows"
    );

    // Step E: Doctor Queue Integration Check
    const queueRes = await fetch(`${BASE_URL}/api/queue`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(queueRes.status, 200, "Doctor queue request must succeed");
    const queueData = await queueRes.json();
    const queuedItems: any[] = queueData.cases ?? queueData.queue ?? (Array.isArray(queueData) ? queueData : []);
    const foundInQueue = queuedItems.find((item) => (item.id ?? item.case_id) === badInputCase.case_id);
    assert.ok(foundInQueue, "Recovered fallback case must appear in doctor queue");
    assert.equal(
      foundInQueue.risk_level ?? foundInQueue.riskLevel,
      "critical",
      "Case in queue must reflect critical risk level evaluated from manual fallback data"
    );
    assert.equal(
      foundInQueue.status,
      "queued",
      "Case in queue must be in 'queued' status"
    );

    // Doctor can view full case report for clinical review
    const reviewRes = await fetch(
      `${BASE_URL}/api/cases/${badInputCase.case_id}/review`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenDoctor}` },
      }
    );
    assert.equal(reviewRes.status, 200, "Doctor review request must return 200");
    const reviewData = await reviewRes.json();
    assert.equal(reviewData.report.risk_level, "critical");
    assert.equal(reviewData.report.chief_complaint.source, "manual");
    assert.equal(reviewData.report.vitals.source, "manual");

    console.log("  ✓ Failure-recovery loop passed: bad input -> manual_fallback -> rules re-run (critical) -> queued -> doctor queue");
    console.log("\n  ✓ ALL Manual Fallback tests passed successfully!\n");
  } finally {
    // Database cleanup
    if (createdCaseIds.length > 0) {
      await db
        .delete(caseReportVersions)
        .where(inArray(caseReportVersions.caseId, createdCaseIds));
      await db.delete(auditLog).where(inArray(auditLog.caseId, createdCaseIds));
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
    }
    if (patientAUserId) {
      await db.delete(users).where(eq(users.id, patientAUserId));
    }
    if (patientBUserId) {
      await db.delete(users).where(eq(users.id, patientBUserId));
    }
    if (doctorUserId) {
      await db.delete(users).where(eq(users.id, doctorUserId));
    }
    if (receptionistUserId) {
      await db.delete(users).where(eq(users.id, receptionistUserId));
    }
    if (patientConsent?.id) {
      await db.delete(consent).where(eq(consent.id, patientConsent.id));
    }
    if (patientA?.id) {
      await db.delete(patients).where(eq(patients.id, patientA.id));
    }
  }
}

// Direct execution support
if (process.argv[1]?.endsWith("cases-manual-fallback.test.ts")) {
  runCasesManualFallbackTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
