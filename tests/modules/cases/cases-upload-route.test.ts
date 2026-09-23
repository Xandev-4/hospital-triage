import assert from "node:assert/strict";
import { db } from "../../../src/shared/config/db.js";
import {
  users,
  patients,
  consent,
  triageCases,
  caseUploads,
  auditLog,
  caseReportVersions,
} from "../../../src/shared/config/schema.js";
import { eq, inArray } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../../../src/shared/config/env.js";
import { cleanupFile } from "../../../src/shared/config/upload.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

// Minimal valid PNG buffer
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export async function runCasesUploadRouteTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: POST /api/cases/:id/upload Route & Auth   ");
  console.log("========================================================");

  let patientAUserId = "";
  let patientBUserId = "";
  let doctorUserId = "";
  let patientA: any = null;
  let patientB: any = null;
  let patientConsent: any = null;
  let createdCaseId = "";
  const createdCaseIds: string[] = [];
  const filesToCleanup: string[] = [];

  try {
    // 1. Create Patient A
    const [pA] = await db
      .insert(patients)
      .values({ name: "Route Test Patient A" })
      .returning();
    patientA = pA;

    const [uA] = await db
      .insert(users)
      .values({
        name: "User Route Patient A",
        email: `patient.route.a.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: patientA.id,
      })
      .returning();
    patientAUserId = uA.id;

    // 2. Create Patient B (non-owner)
    const [pB] = await db
      .insert(patients)
      .values({ name: "Route Test Patient B" })
      .returning();
    patientB = pB;

    const [uB] = await db
      .insert(users)
      .values({
        name: "User Route Patient B",
        email: `patient.route.b.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: patientB.id,
      })
      .returning();
    patientBUserId = uB.id;

    // 3. Create Doctor
    const [uDoc] = await db
      .insert(users)
      .values({
        name: "User Route Doctor",
        email: `doctor.route.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "doctor",
      })
      .returning();
    doctorUserId = uDoc.id;

    // Tokens
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

    // Consent & Case for Patient A
    const [c] = await db
      .insert(consent)
      .values({
        patientId: patientA.id,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
    patientConsent = c;

    const [tCase] = await db
      .insert(triageCases)
      .values({
        patientId: patientA.id,
        createdBy: uA.id,
        consentId: patientConsent.id,
        mode: "self",
        status: "submitted",
        chiefComplaint: "Route test complaint",
      })
      .returning();
    createdCaseId = tCase.id;
    createdCaseIds.push(createdCaseId);

    // ------------------------------------------------------------------------
    // Step 1: Unauthenticated request -> 401 unauthorized
    // ------------------------------------------------------------------------
    console.log("  → Step 1: Reject unauthenticated request (401)");
    const noAuthForm = new FormData();
    noAuthForm.append("modality", "image_ocr");
    noAuthForm.append(
      "file",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "test.png"
    );

    const noAuthRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        body: noAuthForm,
      }
    );
    assert.equal(noAuthRes.status, 401);
    const noAuthData = await noAuthRes.json();
    assert.equal(noAuthData.error?.code, "unauthorized");
    console.log("  ✓ Unauthenticated upload blocked with 401 before parsing");

    // ------------------------------------------------------------------------
    // Step 2: Doctor role -> 403 forbidden
    // ------------------------------------------------------------------------
    console.log("  → Step 2: Reject doctor role upload (403)");
    const docForm = new FormData();
    docForm.append("modality", "image_ocr");
    docForm.append(
      "file",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "test.png"
    );

    const docRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenDoctor}` },
        body: docForm,
      }
    );
    assert.equal(docRes.status, 403);
    const docData = await docRes.json();
    assert.equal(docData.error?.code, "forbidden");
    console.log("  ✓ Doctor role blocked with 403 before parsing");

    // ------------------------------------------------------------------------
    // Step 3: Non-owner patient -> 404 not_found (anti-enumeration)
    // ------------------------------------------------------------------------
    console.log("  → Step 3: Reject non-owner patient upload (404 anti-enumeration)");
    const nonOwnerForm = new FormData();
    nonOwnerForm.append("modality", "image_ocr");
    nonOwnerForm.append(
      "file",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "test.png"
    );

    const nonOwnerRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPatientB}` },
        body: nonOwnerForm,
      }
    );
    assert.equal(nonOwnerRes.status, 404);
    const nonOwnerData = await nonOwnerRes.json();
    assert.equal(noOwnerDataCode(nonOwnerData), "not_found");
    console.log("  ✓ Non-owner blocked with 404 anti-enumeration before parsing");

    // ------------------------------------------------------------------------
    // Step 4: Happy path — Patient A uploads genuine image
    // ------------------------------------------------------------------------
    console.log("  → Step 4: Successful multipart upload by case owner (201 Created)");
    const validForm = new FormData();
    validForm.append("modality", "image_ocr");
    validForm.append(
      "file",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "valid_scan.png"
    );

    const validRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPatientA}` },
        body: validForm,
      }
    );
    assert.equal(validRes.status, 201);
    const validData = await validRes.json();
    assert.ok(validData.upload_id, "Response must contain upload_id");
    assert.equal(validData.case_id, createdCaseId);
    assert.equal(validData.modality, "image_ocr");
    assert.ok(validData.file_path, "Response must contain file_path");
    filesToCleanup.push(validData.file_path);
    console.log("  ✓ Multipart file upload successfully attached (201 Created)");

    // ------------------------------------------------------------------------
    // Step 5: Spoofed content upload -> 400 validation_error (magic bytes rejection)
    // ------------------------------------------------------------------------
    console.log("  → Step 5: Spoofed script disguised as image rejected (400)");
    const spoofForm = new FormData();
    spoofForm.append("modality", "image_ocr");
    spoofForm.append(
      "file",
      new Blob(["#!/bin/bash\necho 'malicious'"], { type: "image/jpeg" }),
      "exploit.jpg"
    );

    const spoofRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPatientA}` },
        body: spoofForm,
      }
    );
    assert.equal(spoofRes.status, 400);
    const spoofData = await spoofRes.json();
    assert.equal(spoofData.error?.code, "validation_error");
    console.log("  ✓ Spoofed binary rejected by magic bytes inspection with 400");

    // ------------------------------------------------------------------------
    // Step 6: Closed case rejection -> 409 invalid_state_transition
    // ------------------------------------------------------------------------
    console.log("  → Step 6: Upload on closed case rejected (409)");
    await db
      .update(triageCases)
      .set({ status: "closed" })
      .where(eq(triageCases.id, createdCaseId));

    const closedForm = new FormData();
    closedForm.append("modality", "image_ocr");
    closedForm.append(
      "file",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "test.png"
    );

    const closedRes = await fetch(
      `${BASE_URL}/api/cases/${createdCaseId}/upload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPatientA}` },
        body: closedForm,
      }
    );
    assert.equal(closedRes.status, 409);
    const closedData = await closedRes.json();
    assert.equal(closedData.error?.code, "invalid_state_transition");
    console.log("  ✓ Closed case upload blocked with 409 before parsing");

    console.log("  ✓ All POST /api/cases/:id/upload route tests passed!\n");
  } finally {
    for (const f of filesToCleanup) {
      await cleanupFile(f);
    }
    if (createdCaseIds.length > 0) {
      await db
        .delete(caseUploads)
        .where(inArray(caseUploads.caseId, createdCaseIds));
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
    if (patientConsent?.id) {
      await db.delete(consent).where(eq(consent.id, patientConsent.id));
    }
    if (patientA?.id) {
      await db.delete(patients).where(eq(patients.id, patientA.id));
    }
    if (patientB?.id) {
      await db.delete(patients).where(eq(patients.id, patientB.id));
    }
  }
}

function noOwnerDataCode(data: any): string {
  return data?.error?.code || "";
}

// Direct execution support
if (process.argv[1]?.endsWith("cases-upload-route.test.ts")) {
  runCasesUploadRouteTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
