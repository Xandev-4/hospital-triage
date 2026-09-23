import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
import { attachUpload } from "../../../src/modules/cases/cases.service.js";
import { UPLOAD_DIR, cleanupFile } from "../../../src/shared/config/upload.js";
import { AppError } from "../../../src/shared/utils/AppError.js";

export async function runCasesUploadServiceTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: cases.service.ts — attachUpload & Guards  ");
  console.log("========================================================");

  let patientAUserId = "";
  let patientBUserId = "";
  let doctorUserId = "";
  let createdCaseId = "";
  let patientA: any = null;
  let patientB: any = null;
  let patientConsent: any = null;
  const createdCaseIds: string[] = [];

  try {
    // 1. Setup Test Users and Patients
    const [pA] = await db
      .insert(patients)
      .values({ name: "Patient A Upload Test" })
      .returning();
    patientA = pA;
    const [userA] = await db
      .insert(users)
      .values({
        name: "User Patient A",
        email: `patient.upload.a.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: patientA.id,
      })
      .returning();
    patientAUserId = userA.id;

    const [pB] = await db
      .insert(patients)
      .values({ name: "Patient B Upload Test" })
      .returning();
    patientB = pB;
    const [userB] = await db
      .insert(users)
      .values({
        name: "User Patient B",
        email: `patient.upload.b.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: patientB.id,
      })
      .returning();
    patientBUserId = userB.id;

    const [userDoc] = await db
      .insert(users)
      .values({
        name: "Doctor Upload Test",
        email: `doc.upload.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "doctor",
      })
      .returning();
    doctorUserId = userDoc.id;

    // 2. Insert consent record for Patient A
    const [pConsent] = await db
      .insert(consent)
      .values({
        patientId: patientA.id,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
    patientConsent = pConsent;

    // 3. Create a test case owned by Patient A in 'submitted' status
    const [testCase] = await db
      .insert(triageCases)
      .values({
        patientId: patientA.id,
        createdBy: userA.id,
        consentId: patientConsent.id,
        mode: "self",
        status: "submitted",
        chiefComplaint: "Severe leg pain and swelling",
      })
      .returning();
    createdCaseId = testCase.id;
    createdCaseIds.push(createdCaseId);

    // ------------------------------------------------------------------------
    // Test 1: Happy Path — Owner patient attaches upload
    // ------------------------------------------------------------------------
    console.log("  → Test 1: Happy Path upload attachment");
    const fakeFilePath = path.join(UPLOAD_DIR, `test-upload-${Date.now()}.jpg`);
    fs.writeFileSync(fakeFilePath, "dummy binary image bytes");

    const uploadRes = await attachUpload(
      createdCaseId,
      "image_ocr",
      {
        path: fakeFilePath,
        mimetype: "image/jpeg",
        size: 26,
      },
      { id: userA.id, role: "patient" }
    );

    assert.ok(uploadRes.upload_id, "Must return upload_id");
    assert.equal(uploadRes.case_id, createdCaseId);
    assert.equal(uploadRes.modality, "image_ocr");
    assert.equal(uploadRes.file_path, fakeFilePath);

    // Verify row in database
    const [dbUpload] = await db
      .select()
      .from(caseUploads)
      .where(eq(caseUploads.id, uploadRes.upload_id));
    assert.ok(dbUpload, "Upload row must exist in case_uploads table");
    assert.equal(dbUpload.caseId, createdCaseId);
    assert.equal(dbUpload.modality, "image_ocr");

    // Verify processing triggered and moved case to queued
    const [dbCase] = await db
      .select()
      .from(triageCases)
      .where(eq(triageCases.id, createdCaseId));
    assert.equal(dbCase?.status, "queued", "Processing trigger must transition case to queued");

    // Verify audit event
    const [auditEntry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, createdCaseId))
      .orderBy(auditLog.createdAt);
    assert.ok(auditEntry, "Audit event must be logged");
    assert.equal(auditEntry.eventType, "intake_submitted");
    assert.equal((auditEntry.metadata as any)?.action, "file_uploaded");
    console.log("  ✓ Happy path passed: Upload attached, stored in DB, and auto-processed to queued");

    // ------------------------------------------------------------------------
    // Test 2: Row-level Ownership Check (Anti-Enumeration) & Orphan Cleanup
    // ------------------------------------------------------------------------
    console.log("  → Test 2: Non-owner patient upload rejection (anti-enumeration 404)");
    const orphanFilePath1 = path.join(
      UPLOAD_DIR,
      `test-orphan-nonowner-${Date.now()}.wav`
    );
    fs.writeFileSync(orphanFilePath1, "dummy audio bytes");

    let nonOwnerRejected = false;
    try {
      await attachUpload(
        createdCaseId,
        "voice",
        {
          path: orphanFilePath1,
          mimetype: "audio/wav",
          size: 17,
        },
        { id: userB.id, role: "patient" } // Patient B does not own this case
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        nonOwnerRejected = true;
      }
    }
    assert.ok(nonOwnerRejected, "Non-owner patient must receive 404 not_found");
    assert.ok(
      !fs.existsSync(orphanFilePath1),
      "Orphan guard must delete file from disk when ownership check fails"
    );
    console.log("  ✓ Anti-enumeration passed: 404 returned & orphaned file removed");

    // ------------------------------------------------------------------------
    // Test 3: Doctor Role Guard & Orphan Cleanup
    // ------------------------------------------------------------------------
    console.log("  → Test 3: Doctor role blocked from attaching intake upload");
    const orphanFilePath2 = path.join(
      UPLOAD_DIR,
      `test-orphan-doc-${Date.now()}.wav`
    );
    fs.writeFileSync(orphanFilePath2, "dummy audio bytes");

    let docRejected = false;
    try {
      await attachUpload(
        createdCaseId,
        "voice",
        {
          path: orphanFilePath2,
          mimetype: "audio/wav",
          size: 17,
        },
        { id: userDoc.id, role: "doctor" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 403) {
        docRejected = true;
      }
    }
    assert.ok(docRejected, "Doctor must receive 403 forbidden");
    assert.ok(
      !fs.existsSync(orphanFilePath2),
      "Orphan guard must delete file from disk when role check fails"
    );
    console.log("  ✓ Doctor role guard passed: 403 returned & orphaned file removed");

    // ------------------------------------------------------------------------
    // Test 4: Status Lifecycle Guard (Reject uploads on assigned/closed cases)
    // ------------------------------------------------------------------------
    console.log("  → Test 4: Reject upload attachment once case is closed");
    await db
      .update(triageCases)
      .set({ status: "closed" })
      .where(eq(triageCases.id, createdCaseId));

    const orphanFilePath3 = path.join(
      UPLOAD_DIR,
      `test-orphan-closed-${Date.now()}.jpg`
    );
    fs.writeFileSync(orphanFilePath3, "dummy bytes");

    let statusRejected = false;
    try {
      await attachUpload(
        createdCaseId,
        "image_ocr",
        {
          path: orphanFilePath3,
          mimetype: "image/jpeg",
          size: 11,
        },
        { id: userA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) {
        statusRejected = true;
      }
    }
    assert.ok(
      statusRejected,
      "Closed case upload must be rejected with 409 invalid_state_transition"
    );
    assert.ok(
      !fs.existsSync(orphanFilePath3),
      "Orphan guard must delete file from disk when status check fails"
    );
    console.log("  ✓ Status lifecycle guard passed: 409 returned & orphaned file removed");

    // ------------------------------------------------------------------------
    // Test 5: Invalid Modality Guard
    // ------------------------------------------------------------------------
    console.log("  → Test 5: Reject invalid modality");
    const orphanFilePath4 = path.join(
      UPLOAD_DIR,
      `test-orphan-modality-${Date.now()}.bin`
    );
    fs.writeFileSync(orphanFilePath4, "dummy binary");

    let modalityRejected = false;
    try {
      await attachUpload(
        createdCaseId,
        "video" as any,
        {
          path: orphanFilePath4,
          mimetype: "video/mp4",
          size: 12,
        },
        { id: userA.id, role: "patient" }
      );
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400) {
        modalityRejected = true;
      }
    }
    assert.ok(modalityRejected, "Invalid modality must be rejected with 400 validation_error");
    assert.ok(
      !fs.existsSync(orphanFilePath4),
      "Orphan guard must clean up file on invalid modality"
    );
    console.log("  ✓ Modality guard passed: 400 returned & file cleaned up");

    // Cleanup fake file from Test 1
    await cleanupFile(fakeFilePath);

    console.log("  ✓ All cases.service.ts attachUpload tests passed!\n");
  } finally {
    // Database cleanup
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

// Direct execution support
if (process.argv[1]?.endsWith("cases-upload.test.ts")) {
  runCasesUploadServiceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
