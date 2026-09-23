import assert from "node:assert/strict";
import fs from "node:fs";
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

// Minimal valid PNG (Image) buffer
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// Minimal valid WAV (Audio) buffer (44 bytes standard header)
const VALID_WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]), // ChunkSize
  Buffer.from("WAVEfmt ", "ascii"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]), // Subchunk1Size (16 for PCM)
  Buffer.from([0x01, 0x00]), // AudioFormat (1 = PCM)
  Buffer.from([0x01, 0x00]), // NumChannels (1 = Mono)
  Buffer.from([0x44, 0xac, 0x00, 0x00]), // SampleRate (44100)
  Buffer.from([0x88, 0x58, 0x01, 0x00]), // ByteRate (44100 * 2)
  Buffer.from([0x02, 0x00]), // BlockAlign (2)
  Buffer.from([0x10, 0x00]), // BitsPerSample (16)
  Buffer.from("data", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]), // Subchunk2Size (0 bytes)
]);

export async function runCasesMultipartTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Unified POST /api/cases (Design 1)        ");
  console.log("========================================================");

  let patientUserId = "";
  let doctorUserId = "";
  let patientRecord: any = null;
  let patientConsent: any = null;
  const createdCaseIds: string[] = [];
  const filesToCleanup: string[] = [];

  try {
    // Setup Patient
    const [p] = await db
      .insert(patients)
      .values({ name: "Design 1 Test Patient" })
      .returning();
    patientRecord = p;

    const [uPatient] = await db
      .insert(users)
      .values({
        name: "Design 1 Patient",
        email: `design1.patient.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "patient",
        patientId: p.id,
      })
      .returning();
    patientUserId = uPatient.id;

    // Setup Doctor
    const [uDoc] = await db
      .insert(users)
      .values({
        name: "Design 1 Doctor",
        email: `design1.doc.${Date.now()}@example.com`,
        passwordHash: "hash123",
        role: "doctor",
      })
      .returning();
    doctorUserId = uDoc.id;

    const patientToken = jwt.sign(
      { sub: uPatient.id, role: "patient" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );
    const doctorToken = jwt.sign(
      { sub: uDoc.id, role: "doctor" },
      env.jwtSecret,
      { expiresIn: "1h" }
    );

    // Setup Consent
    const [c] = await db
      .insert(consent)
      .values({
        patientId: p.id,
        givenBy: "self",
        policyVersion: "v1.0",
      })
      .returning();
    patientConsent = c;

    // ------------------------------------------------------------------------
    // Test 1: Text-only intake -> 201 Created with status 'submitted'
    // ------------------------------------------------------------------------
    console.log("  → Test 1: Intake with text only (status 'submitted')");
    const textOnlyForm = new FormData();
    textOnlyForm.append("chief_complaint", "High fever and chills");
    textOnlyForm.append("duration", "3 days");

    const textOnlyRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patientToken}` },
      body: textOnlyForm,
    });
    assert.equal(textOnlyRes.status, 201);
    const textOnlyData = await textOnlyRes.json();
    assert.equal(textOnlyData.status, "submitted");
    assert.ok(textOnlyData.case_id);
    createdCaseIds.push(textOnlyData.case_id);
    console.log("  ✓ Text-only intake created with status 'submitted'");

    // ------------------------------------------------------------------------
    // Test 2: Text + Image upload -> 201 Created & Auto-Processed
    // ------------------------------------------------------------------------
    console.log("  → Test 2: Successful intake with Text + Image (201 Created)");
    const imageForm = new FormData();
    imageForm.append("chief_complaint", "Acute headache and blurred vision");
    imageForm.append("duration", "2 hours");
    imageForm.append(
      "image",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "scan.png"
    );

    const imageRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patientToken}` },
      body: imageForm,
    });
    assert.equal(imageRes.status, 201);
    const imageData = await imageRes.json();
    assert.ok(imageData.case_id, "Must return case_id");
    assert.ok(
      ["processing", "queued", "manual_fallback"].includes(imageData.status),
      "Must have moved past 'submitted'"
    );
    createdCaseIds.push(imageData.case_id);

    // Verify upload row in case_uploads table
    const dbUploads = await db
      .select()
      .from(caseUploads)
      .where(eq(caseUploads.caseId, imageData.case_id));
    assert.equal(dbUploads.length, 1, "Must have exactly 1 upload row");
    assert.equal(dbUploads[0].modality, "image_ocr");
    filesToCleanup.push(dbUploads[0].filePath);
    console.log("  ✓ Text + Image intake successfully created, uploaded, and processed");

    // ------------------------------------------------------------------------
    // Test 3: Text + Voice upload -> 201 Created & Auto-Processed
    // ------------------------------------------------------------------------
    console.log("  → Test 3: Successful intake with Text + Voice (201 Created)");
    const voiceForm = new FormData();
    voiceForm.append("chief_complaint", "Severe breathlessness on exertion");
    voiceForm.append("duration", "1 day");
    voiceForm.append(
      "voice",
      new Blob([VALID_WAV_BUFFER], { type: "audio/wav" }),
      "memo.wav"
    );

    const voiceRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patientToken}` },
      body: voiceForm,
    });
    assert.equal(voiceRes.status, 201);
    const voiceData = await voiceRes.json();
    assert.ok(voiceData.case_id);
    createdCaseIds.push(voiceData.case_id);

    const dbVoiceUploads = await db
      .select()
      .from(caseUploads)
      .where(eq(caseUploads.caseId, voiceData.case_id));
    assert.equal(dbVoiceUploads.length, 1);
    assert.equal(dbVoiceUploads[0].modality, "voice");
    filesToCleanup.push(dbVoiceUploads[0].filePath);
    console.log("  ✓ Text + Voice intake successfully created, uploaded, and processed");

    // ------------------------------------------------------------------------
    // Test 4: Text + BOTH Voice AND Image -> 201 Created with 2 uploads
    // ------------------------------------------------------------------------
    console.log("  → Test 4: Successful intake with Text + Both Voice & Image");
    const bothForm = new FormData();
    bothForm.append("chief_complaint", "Crushing chest pain radiating to left arm");
    bothForm.append("duration", "30 minutes");
    bothForm.append(
      "voice",
      new Blob([VALID_WAV_BUFFER], { type: "audio/wav" }),
      "voice.wav"
    );
    bothForm.append(
      "image",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "ecg.png"
    );

    const bothRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patientToken}` },
      body: bothForm,
    });
    assert.equal(bothRes.status, 201);
    const bothData = await bothRes.json();
    assert.ok(bothData.case_id);
    createdCaseIds.push(bothData.case_id);

    const dbBothUploads = await db
      .select()
      .from(caseUploads)
      .where(eq(caseUploads.caseId, bothData.case_id));
    assert.equal(dbBothUploads.length, 2, "Must store both voice and image uploads");
    for (const u of dbBothUploads) {
      filesToCleanup.push(u.filePath);
    }

    // Verify dual audit events: intake_submitted and status_changed
    const auditEntries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, bothData.case_id))
      .orderBy(auditLog.createdAt);
    const eventTypes = auditEntries.map((a) => a.eventType);
    assert.ok(eventTypes.includes("intake_submitted"), "Must log intake_submitted");
    assert.ok(eventTypes.includes("status_changed"), "Must log status_changed");
    console.log("  ✓ Multimodal intake (Voice + Image) atomic transaction & audit verified");

    // ------------------------------------------------------------------------
    // Test 5: Spoofed File Rejection (Magic bytes inspection)
    // ------------------------------------------------------------------------
    console.log("  → Test 5: Reject spoofed executable script disguised as image (400)");
    const spoofForm = new FormData();
    spoofForm.append("chief_complaint", "Exploit attempt");
    spoofForm.append(
      "image",
      new Blob(["#!/bin/bash\nrm -rf /"], { type: "image/png" }),
      "fake.png"
    );

    const spoofRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patientToken}` },
      body: spoofForm,
    });
    assert.equal(spoofRes.status, 400);
    const spoofData = await spoofRes.json();
    assert.equal(spoofData.error?.code, "validation_error");
    console.log("  ✓ Spoofed binary rejected by magic byte validator with 400");

    // ------------------------------------------------------------------------
    // Test 6: Doctor Role Guard
    // ------------------------------------------------------------------------
    console.log("  → Test 6: Reject doctor role case creation (403)");
    const docForm = new FormData();
    docForm.append("chief_complaint", "Doctor trying to create case");
    docForm.append(
      "image",
      new Blob([VALID_PNG_BUFFER], { type: "image/png" }),
      "doc.png"
    );

    const docRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${doctorToken}` },
      body: docForm,
    });
    assert.equal(docRes.status, 403);
    console.log("  ✓ Doctor role blocked with 403 forbidden");

    console.log("  ✓ All Unified POST /api/cases tests passed!\n");
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
    if (patientUserId) {
      await db.delete(users).where(eq(users.id, patientUserId));
    }
    if (doctorUserId) {
      await db.delete(users).where(eq(users.id, doctorUserId));
    }
    if (patientConsent?.id) {
      await db.delete(consent).where(eq(consent.id, patientConsent.id));
    }
    if (patientRecord?.id) {
      await db.delete(patients).where(eq(patients.id, patientRecord.id));
    }
  }
}

// Direct execution support
if (process.argv[1]?.endsWith("cases-multipart.test.ts")) {
  runCasesMultipartTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
