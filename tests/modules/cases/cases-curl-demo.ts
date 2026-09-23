import { db } from "../../../src/shared/config/db.js";
import { triageCases, caseUploads } from "../../../src/shared/config/schema.js";
import { eq } from "drizzle-orm";

async function runLiveCurlVerification() {
  const BASE_URL = "http://localhost:8000";

  console.log("\n========================================================");
  console.log("  LIVE TEST: End-to-End Upload Verification             ");
  console.log("========================================================");

  // 1. Register and login Patient A
  const pAEmail = `live.patient.a.${Date.now()}@example.com`;
  await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Live Patient A", email: pAEmail, password: "password123", role: "patient" })
  });
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: pAEmail, password: "password123" })
  });
  const { token: tokenA } = await loginRes.json();

  // Give consent
  await fetch(`${BASE_URL}/api/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ given_by: "self", policy_version: "v1.0" })
  });

  // Create Case
  const createRes = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chief_complaint: "Acute onset palpitations and dizziness", duration: "1 hour" })
  });
  const caseData = await createRes.json();
  console.log("1. Case Created via POST /api/cases (status: submitted):", caseData);

  // Upload genuine PNG image
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const form = new FormData();
  form.append("modality", "image_ocr");
  form.append("file", new Blob([pngBuffer], { type: "image/png" }), "ecg.png");

  const uploadRes = await fetch(`${BASE_URL}/api/cases/${caseData.case_id}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}` },
    body: form
  });
  const uploadData = await uploadRes.json();
  console.log("2. Upload Response via POST /api/cases/:id/upload:", uploadRes.status, uploadData);

  // Verify DB upload row and status transition
  const [dbUpload] = await db.select().from(caseUploads).where(eq(caseUploads.id, uploadData.upload_id));
  console.log("3a. Confirmed row in case_uploads:", { id: dbUpload?.id, caseId: dbUpload?.caseId, modality: dbUpload?.modality });

  const [dbCase] = await db.select().from(triageCases).where(eq(triageCases.id, caseData.case_id));
  console.log("3b. Confirmed case status after upload (processing fired):", dbCase?.status);

  // 4. Test uploading a file with spoofed mimetype (text file renamed to .jpg)
  const c2Res = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ chief_complaint: "Second test case for spoofing" })
  });
  const c2 = await c2Res.json();

  const spoofForm = new FormData();
  spoofForm.append("modality", "image_ocr");
  spoofForm.append("file", new Blob(["#!/bin/bash\necho Malicious"], { type: "image/jpeg" }), "fake.jpg");

  const spoofRes = await fetch(`${BASE_URL}/api/cases/${c2.case_id}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}` },
    body: spoofForm
  });
  console.log("4. Spoofed text renamed to .jpg rejection status:", spoofRes.status, await spoofRes.json());

  // 5. Test uploading to a case that is not yours (Patient B -> Case 2)
  const pBEmail = `live.patient.b.${Date.now()}@example.com`;
  await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Live Patient B", email: pBEmail, password: "password123", role: "patient" })
  });
  const loginBRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: pBEmail, password: "password123" })
  });
  const { token: tokenB } = await loginBRes.json();

  const nonOwnerForm = new FormData();
  nonOwnerForm.append("modality", "image_ocr");
  nonOwnerForm.append("file", new Blob([pngBuffer], { type: "image/png" }), "ecg.png");

  const nonOwnerRes = await fetch(`${BASE_URL}/api/cases/${c2.case_id}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenB}` },
    body: nonOwnerForm
  });
  console.log("5. Non-owner upload status (anti-enumeration 404):", nonOwnerRes.status, await nonOwnerRes.json());

  // 6. Test uploading to a case that is already closed
  await db.update(triageCases).set({ status: "closed" }).where(eq(triageCases.id, c2.case_id));

  const closedForm = new FormData();
  closedForm.append("modality", "image_ocr");
  closedForm.append("file", new Blob([pngBuffer], { type: "image/png" }), "ecg.png");

  const closedRes = await fetch(`${BASE_URL}/api/cases/${c2.case_id}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}` },
    body: closedForm
  });
  console.log("6. Closed case upload status (status-gate 409):", closedRes.status, await closedRes.json());
}

runLiveCurlVerification().catch(console.error);
