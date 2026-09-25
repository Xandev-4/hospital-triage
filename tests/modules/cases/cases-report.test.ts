import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
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
import { env } from "../../../src/shared/config/env.js";
import { processCase } from "../../../src/modules/processing/processing.service.js";
import {
  evaluateRisk,
  validateDuration,
  CANONICAL_MISSING_INFO_KEYS,
} from "../../../src/modules/processing/rules-engine.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runCasesReportTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Clinical Report & Version History (API §5) ");
  console.log("========================================================");

  let patientAUserId = "";
  let patientBUserId = "";
  let doctorUserId = "";
  let receptionistUserId = "";
  let patientA: any = null;
  let patientB: any = null;
  let consentA: any = null;
  const createdCaseIds: string[] = [];

  try {
    // ------------------------------------------------------------------------
    // SETUP: Users, Patients, and Consents
    // ------------------------------------------------------------------------
    const [pA] = await db
      .insert(patients)
      .values({ name: "Report Test Patient A", phoneNumber: "+919111111111" })
      .returning();
    patientA = pA;

    const [uA] = await db
      .insert(users)
      .values({
        name: "User Report Patient A",
        email: `patient.report.a.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: pA.id,
      })
      .returning();
    patientAUserId = uA.id;

    const [pB] = await db
      .insert(patients)
      .values({ name: "Report Test Patient B", phoneNumber: "+919222222222" })
      .returning();
    patientB = pB;

    const [uB] = await db
      .insert(users)
      .values({
        name: "User Report Patient B",
        email: `patient.report.b.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: pB.id,
      })
      .returning();
    patientBUserId = uB.id;

    const [uDoc] = await db
      .insert(users)
      .values({
        name: "User Report Doctor",
        email: `doctor.report.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "doctor",
      })
      .returning();
    doctorUserId = uDoc.id;

    const [uRecep] = await db
      .insert(users)
      .values({
        name: "User Report Receptionist",
        email: `recep.report.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "receptionist",
      })
      .returning();
    receptionistUserId = uRecep.id;

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
    const tokenReceptionist = jwt.sign(
      { sub: uRecep.id, role: "receptionist" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );

    const [cA] = await db
      .insert(consent)
      .values({
        patientId: pA.id,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
    consentA = cA;

    // ------------------------------------------------------------------------
    // CASE 1: Single version case (AI processed, never edited)
    // ------------------------------------------------------------------------
    const [c1] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: cA.id,
        mode: "self",
        status: "queued",
        chiefComplaint: "Severe migraine and photophobia",
        duration: "3 days",
        symptoms: "Throbbing temporal pain, nausea, sensitive to light",
        vitals: { heartRate: 88, bloodPressureSystolic: 125, bloodPressureDiastolic: 82 },
        riskLevel: "medium",
        aiRulesDisagreement: false,
      })
      .returning();
    createdCaseIds.push(c1.id);

    await db.insert(caseReportVersions).values({
      caseId: c1.id,
      versionNumber: 1,
      source: "ai",
      content: {
        chief_complaint: { value: "Severe migraine and photophobia", source: "ai" },
        duration: { value: "3 days", source: "ai" },
        symptoms: { value: "Throbbing temporal pain, nausea, sensitive to light", source: "ai" },
        vitals: {
          value: { heartRate: 88, bloodPressureSystolic: 125, bloodPressureDiastolic: 82 },
          source: "ai",
        },
        missing_info: ["temperature"],
        risk_level: "medium",
        ai_rules_disagreement: {
          present: false,
          ai_suggested: null,
          rules_result: "medium",
          note: null,
        },
      },
      editedBy: null,
    });

    // ------------------------------------------------------------------------
    // CASE 2: Multi-version case (AI initial -> manual fallback / edit, 2+ versions)
    // Created by receptionist for Patient A
    // ------------------------------------------------------------------------
    const [c2] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uRecep.id,
        consentId: cA.id,
        mode: "assisted",
        status: "queued",
        chiefComplaint: "Crushing chest pain radiating to left jaw",
        duration: "45 minutes",
        symptoms: "Diaphoresis, shortness of breath, crushing retrosternal pain",
        vitals: { heartRate: 115, bloodPressureSystolic: 165, bloodPressureDiastolic: 98, spO2: 91 },
        riskLevel: "critical",
        aiRulesDisagreement: true,
      })
      .returning();
    createdCaseIds.push(c2.id);

    // Version 1 (AI extraction before fallback or edit)
    await db.insert(caseReportVersions).values({
      caseId: c2.id,
      versionNumber: 1,
      source: "ai",
      content: {
        chief_complaint: { value: "Chest pain", source: "ai" },
        duration: { value: "1 hour", source: "ai" },
        symptoms: { value: "Chest discomfort", source: "ai" },
        vitals: { value: { heartRate: 100 }, source: "ai" },
        missing_info: ["spO2", "bloodPressure"],
        risk_level: "medium",
        ai_rules_disagreement: {
          present: false,
          ai_suggested: null,
          rules_result: "medium",
          note: null,
        },
      },
      editedBy: null,
    });

    // Version 2 (Manual fallback / clinician edit with per-field tracking)
    await db.insert(caseReportVersions).values({
      caseId: c2.id,
      versionNumber: 2,
      source: "manual",
      content: {
        chief_complaint: { value: "Crushing chest pain radiating to left jaw", source: "manual" },
        duration: { value: "45 minutes", source: "manual" },
        symptoms: { value: "Diaphoresis, shortness of breath, crushing retrosternal pain", source: "manual" },
        vitals: {
          value: { heartRate: 115, bloodPressureSystolic: 165, bloodPressureDiastolic: 98, spO2: 91 },
          source: "manual",
        },
        missing_info: [],
        risk_level: "critical",
        ai_rules_disagreement: {
          present: true,
          ai_suggested: "medium",
          rules_result: "critical",
          note: "rules result applies",
        },
      },
      editedBy: uRecep.id,
    });

    // ------------------------------------------------------------------------
    // CASE 3: Fresh case with no report versions yet
    // ------------------------------------------------------------------------
    const [c3] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: cA.id,
        mode: "self",
        status: "submitted",
        chiefComplaint: "Mild rash on forearm",
        duration: "1 day",
        symptoms: "Redness, slight itching",
        vitals: {},
        riskLevel: null,
        aiRulesDisagreement: false,
      })
      .returning();
    createdCaseIds.push(c3.id);

    // ========================================================================
    // PART 1: GET /api/cases/:id/report (Clinical Report Read Endpoint)
    // ========================================================================
    console.log("\n--- Part 1: GET /api/cases/:id/report (Ownership & Payload Verification) ---");

    // 1.1 Patient A fetches their own Case 1
    console.log("  → Test 1.1: Patient A fetches own case report (200 OK)");
    const resOwnReport = await fetch(`${BASE_URL}/api/cases/${c1.id}/report`, {
      headers: { Authorization: `Bearer ${tokenPatientA}` },
    });
    assert.equal(resOwnReport.status, 200, "Patient A must be allowed to fetch own report");
    const dataOwnReport = await resOwnReport.json();

    assert.equal(dataOwnReport.case_id, c1.id);
    assert.equal(typeof dataOwnReport.chief_complaint, "object");
    assert.equal(dataOwnReport.chief_complaint.value, "Severe migraine and photophobia");
    assert.equal(dataOwnReport.chief_complaint.source, "ai", "Field source must be 'ai'");
    assert.equal(dataOwnReport.duration.value, "3 days");
    assert.equal(dataOwnReport.duration.source, "ai");
    assert.equal(dataOwnReport.symptoms.value, "Throbbing temporal pain, nausea, sensitive to light");
    assert.equal(dataOwnReport.symptoms.source, "ai");
    assert.equal(typeof dataOwnReport.vitals.value, "object");
    assert.equal(dataOwnReport.vitals.value.heartRate, 88);
    assert.equal(dataOwnReport.vitals.source, "ai");
    assert.ok(Array.isArray(dataOwnReport.missing_info));
    assert.equal(dataOwnReport.missing_info[0], "temperature");
    assert.equal(dataOwnReport.risk_level, "medium");
    assert.equal(dataOwnReport.ai_rules_disagreement.present, false);

    // 1.2 Patient B (non-owner) attempts to fetch Case 1 report -> 404 anti-enumeration
    console.log("  → Test 1.2: Patient B (non-owner) fetches Case 1 report -> 404 not_found (anti-enumeration)");
    const resOtherPatient = await fetch(`${BASE_URL}/api/cases/${c1.id}/report`, {
      headers: { Authorization: `Bearer ${tokenPatientB}` },
    });
    assert.equal(
      resOtherPatient.status,
      404,
      "Non-owner patient must receive 404 not_found (never 403, preventing ID enumeration)"
    );
    const errOtherPatient = await resOtherPatient.json();
    assert.equal(errOtherPatient.error.code, "not_found");

    // 1.3 Receptionist fetches Case 1 (not created by receptionist) -> 404 anti-enumeration
    console.log("  → Test 1.3: Receptionist fetches Case 1 (not created by them) -> 404 not_found");
    const resOtherRecep = await fetch(`${BASE_URL}/api/cases/${c1.id}/report`, {
      headers: { Authorization: `Bearer ${tokenReceptionist}` },
    });
    assert.equal(
      resOtherRecep.status,
      404,
      "Receptionist viewing case created by another user must receive 404 not_found"
    );

    // 1.4 Receptionist fetches Case 2 (created by this receptionist) -> 200 OK
    console.log("  → Test 1.4: Receptionist fetches Case 2 (created by them) -> 200 OK");
    const resRecepOwnCase = await fetch(`${BASE_URL}/api/cases/${c2.id}/report`, {
      headers: { Authorization: `Bearer ${tokenReceptionist}` },
    });
    assert.equal(resRecepOwnCase.status, 200, "Receptionist must be allowed to fetch case they created");
    const dataRecepOwnCase = await resRecepOwnCase.json();
    assert.equal(dataRecepOwnCase.case_id, c2.id);
    assert.equal(dataRecepOwnCase.risk_level, "critical");
    assert.equal(dataRecepOwnCase.chief_complaint.source, "manual", "Must reflect latest version source");
    assert.equal(dataRecepOwnCase.ai_rules_disagreement.present, true);

    // 1.5 Doctor fetches both Case 1 and Case 2 -> 200 OK
    console.log("  → Test 1.5: Doctor fetches Case 1 and Case 2 -> 200 OK (no ownership gate)");
    const resDocC1 = await fetch(`${BASE_URL}/api/cases/${c1.id}/report`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resDocC1.status, 200, "Doctor must have access to Case 1");
    const resDocC2 = await fetch(`${BASE_URL}/api/cases/${c2.id}/report`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resDocC2.status, 200, "Doctor must have access to Case 2");

    // 1.6 Non-existent case ID -> 404 not_found for all roles
    console.log("  → Test 1.6: Fetch report for non-existent case ID -> 404 not_found");
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const resFakeDoc = await fetch(`${BASE_URL}/api/cases/${fakeId}/report`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resFakeDoc.status, 404, "Non-existent case ID must return 404");

    // 1.7 Fetch report for Case 3 (case without version rows yet) -> 200 fallback
    console.log("  → Test 1.7: Fetch report for case with no report versions yet -> 200 fallback");
    const resC3 = await fetch(`${BASE_URL}/api/cases/${c3.id}/report`, {
      headers: { Authorization: `Bearer ${tokenPatientA}` },
    });
    assert.equal(resC3.status, 200, "Case without version row must fallback gracefully");
    const dataC3 = await resC3.json();
    assert.equal(dataC3.case_id, c3.id);
    assert.equal(dataC3.chief_complaint.value, "Mild rash on forearm");
    assert.equal(dataC3.chief_complaint.source, "manual");
    assert.equal(dataC3.risk_level, null);

    // 1.8 Explicit Incomplete Case: Missing duration & vitals returned in missing_info
    console.log("  → Test 1.8: Incomplete case (no duration, no vitals) -> non-empty specific missing_info");
    const [c4] = await db
      .insert(triageCases)
      .values({
        patientId: pA.id,
        createdBy: uA.id,
        consentId: cA.id,
        mode: "self",
        status: "processing",
        chiefComplaint: "Acute crushing chest pain",
        duration: "", // deliberately omitted
        symptoms: "heaviness in chest",
        vitals: {}, // deliberately omitted
        riskLevel: null,
      })
      .returning();
    createdCaseIds.push(c4.id);

    // Run processing pipeline directly
    await processCase(c4.id, { id: uA.id, role: "patient" });

    // Fetch report via HTTP endpoint
    const resC4 = await fetch(`${BASE_URL}/api/cases/${c4.id}/report`, {
      headers: { Authorization: `Bearer ${tokenPatientA}` },
    });
    assert.equal(resC4.status, 200, "Report fetch for incomplete case must succeed");
    const dataC4 = await resC4.json();

    assert.ok(Array.isArray(dataC4.missing_info), "missing_info must be an array");
    assert.ok(
      dataC4.missing_info.length > 0,
      "missing_info must NOT be empty for an incomplete case"
    );
    assert.ok(
      dataC4.missing_info.includes("duration"),
      "missing_info must explicitly identify 'duration' as missing"
    );
    assert.ok(
      dataC4.missing_info.includes("vitals"),
      "missing_info must explicitly identify 'vitals' as missing"
    );
    // Confirm every element belongs to the fixed canonical enum-like list
    for (const key of dataC4.missing_info) {
      assert.ok(
        (CANONICAL_MISSING_INFO_KEYS as readonly string[]).includes(key) ||
          key === "fever_duration" ||
          key === "radiation_pattern",
        `Field '${key}' must be from the known canonical enum list`
      );
    }
    console.log(
      `    ✓ Confirmed missing_info contains specific canonical items: ${JSON.stringify(dataC4.missing_info)}`
    );

    // 1.9 Distinct Signal Verification: "Missing Info" vs "Malformed Info"
    console.log("  → Test 1.9: Distinct signals: absent duration ('') vs malformed duration ('the color blue')");
    // Case A: Absent duration -> missing_info flagged, no anomaly
    const resAbsent = evaluateRisk({
      chief_complaint: "fever",
      duration: "", // absent
      vitals: { temperature: 101 },
    });
    assert.ok(
      resAbsent.missingCriticalInfo.includes("duration"),
      "Absent duration must be in missingCriticalInfo"
    );
    assert.equal(
      resAbsent.anomaliesDetected.length,
      0,
      "Absent duration must NOT trigger an anomaly"
    );
    assert.equal(
      resAbsent.riskLevel,
      "medium",
      "Missing duration on fever must enforce medium floor"
    );

    // Case B: Malformed duration -> anomaly flagged, NOT in missing_info, fails closed to medium
    const resMalformed = evaluateRisk({
      chief_complaint: "fever",
      duration: "the color blue", // present but garbage non-temporal string
      vitals: { temperature: 101 },
    });
    assert.ok(
      !resMalformed.missingCriticalInfo.includes("duration"),
      "Malformed duration was provided, so it must NOT be flagged as absent 'missing_info'"
    );
    assert.ok(
      resMalformed.anomaliesDetected.some((a) => a.includes("the color blue")),
      "Malformed duration must be recorded in anomaliesDetected"
    );
    assert.equal(
      resMalformed.riskLevel,
      "medium",
      "Malformed duration must fail closed to medium risk via anomaly guard (cannot slip through to low)"
    );

    // Case C: Direct validateDuration helper tests
    assert.equal(validateDuration(null).status, "absent");
    assert.equal(validateDuration("").status, "absent");
    assert.equal(validateDuration("unknown").status, "absent");
    assert.equal(validateDuration("n/a").status, "absent");
    assert.equal(validateDuration("the color blue").status, "malformed");
    assert.equal(validateDuration("banana").status, "malformed");
    assert.equal(validateDuration("3 days").status, "valid");
    assert.equal(validateDuration("since yesterday").status, "valid");
    assert.equal(validateDuration("sudden onset").status, "valid");
    console.log(
      "    ✓ Confirmed missing info and malformed info do not collapse into the same signal"
    );

    // ========================================================================
    // PART 2: GET /api/cases/:id/report/versions (Doctor-Only Version History)
    // ========================================================================
    console.log("\n--- Part 2: GET /api/cases/:id/report/versions (Doctor-Only & History Integrity) ---");

    // 2.1 Patient token directly calling /report/versions -> 403 Forbidden
    console.log("  → Test 2.1: Patient token calling /report/versions -> 403 Forbidden");
    const resPatientVersions = await fetch(`${BASE_URL}/api/cases/${c1.id}/report/versions`, {
      headers: { Authorization: `Bearer ${tokenPatientA}` },
    });
    assert.equal(
      resPatientVersions.status,
      403,
      "Patient must be rejected with 403 Forbidden on /report/versions"
    );
    const errPatientVersions = await resPatientVersions.json();
    assert.equal(errPatientVersions.error.code, "forbidden");

    // 2.2 Receptionist token calling /report/versions -> 403 Forbidden
    console.log("  → Test 2.2: Receptionist token calling /report/versions -> 403 Forbidden");
    const resRecepVersions = await fetch(`${BASE_URL}/api/cases/${c2.id}/report/versions`, {
      headers: { Authorization: `Bearer ${tokenReceptionist}` },
    });
    assert.equal(
      resRecepVersions.status,
      403,
      "Receptionist must be rejected with 403 Forbidden on /report/versions"
    );
    const errRecepVersions = await resRecepVersions.json();
    assert.equal(errRecepVersions.error.code, "forbidden");

    // 2.3 Unauthenticated request -> 401 Unauthorized
    console.log("  → Test 2.3: Unauthenticated calling /report/versions -> 401 Unauthorized");
    const resUnauthVersions = await fetch(`${BASE_URL}/api/cases/${c1.id}/report/versions`);
    assert.equal(resUnauthVersions.status, 401, "Unauthenticated request must return 401");

    // 2.4 Doctor calls /report/versions for non-existent case -> 404 not_found
    console.log("  → Test 2.4: Doctor calls /report/versions for non-existent case -> 404 not_found");
    const resDocFake = await fetch(`${BASE_URL}/api/cases/${fakeId}/report/versions`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resDocFake.status, 404, "Non-existent case ID must return 404 not_found");

    // 2.5 Single-version case (Case 1, never edited): returns array with exactly 1 item
    console.log("  → Test 2.5: Doctor calls /report/versions on 1-version case (never edited) -> array of 1 item");
    const resSingleVersion = await fetch(`${BASE_URL}/api/cases/${c1.id}/report/versions`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resSingleVersion.status, 200, "Doctor must receive 200 OK");
    const dataSingleVersion = await resSingleVersion.json();
    assert.ok(Array.isArray(dataSingleVersion.versions), "Must contain 'versions' array");
    assert.equal(dataSingleVersion.versions.length, 1, "Must return exactly 1 version");
    assert.equal(dataSingleVersion.versions[0].version_number, 1);
    assert.equal(dataSingleVersion.versions[0].source, "ai");
    assert.equal(dataSingleVersion.versions[0].edited_by, null);
    assert.ok(dataSingleVersion.versions[0].created_at);
    assert.equal(
      dataSingleVersion.versions[0].content.chief_complaint.value,
      "Severe migraine and photophobia"
    );

    // 2.6 Multi-version case (Case 2, 2 versions after manual fallback): returns 2 items in ascending order
    console.log("  → Test 2.6: Doctor calls /report/versions on multi-version case -> 2 items ordered ascending");
    const resMultiVersion = await fetch(`${BASE_URL}/api/cases/${c2.id}/report/versions`, {
      headers: { Authorization: `Bearer ${tokenDoctor}` },
    });
    assert.equal(resMultiVersion.status, 200, "Doctor must receive 200 OK");
    const dataMultiVersion = await resMultiVersion.json();
    assert.ok(Array.isArray(dataMultiVersion.versions), "Must contain 'versions' array");
    assert.equal(dataMultiVersion.versions.length, 2, "Must return exactly 2 versions");

    const [v1, v2] = dataMultiVersion.versions;
    assert.equal(v1.version_number, 1, "First item must be version 1");
    assert.equal(v1.source, "ai", "Version 1 source must be 'ai'");
    assert.equal(v1.content.chief_complaint.value, "Chest pain");
    assert.equal(v1.content.chief_complaint.source, "ai");
    assert.equal(v1.edited_by, null);

    assert.equal(v2.version_number, 2, "Second item must be version 2");
    assert.equal(v2.source, "manual", "Version 2 source must be 'manual'");
    assert.equal(
      v2.content.chief_complaint.value,
      "Crushing chest pain radiating to left jaw"
    );
    assert.equal(v2.content.chief_complaint.source, "manual");
    assert.equal(v2.edited_by, uRecep.id);

    console.log("\n✓ All Clinical Report and Version History tests passed successfully!");
  } finally {
    // ------------------------------------------------------------------------
    // CLEANUP
    // ------------------------------------------------------------------------
    if (createdCaseIds.length > 0) {
      await db
        .delete(caseReportVersions)
        .where(inArray(caseReportVersions.caseId, createdCaseIds));
      await db
        .delete(auditLog)
        .where(inArray(auditLog.caseId, createdCaseIds));
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
    }
    if (consentA) {
      await db.delete(consent).where(eq(consent.id, consentA.id));
    }
    const userIds = [patientAUserId, patientBUserId, doctorUserId, receptionistUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (patientA) {
      await db.delete(patients).where(eq(patients.id, patientA.id));
    }
    if (patientB) {
      await db.delete(patients).where(eq(patients.id, patientB.id));
    }
  }
}

// Allow direct CLI execution: npx tsx tests/modules/cases/cases-report.test.ts
if (process.argv[1]?.endsWith("cases-report.test.ts")) {
  runCasesReportTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}
