import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../../../src/shared/config/db.js";
import { users, patients, consent, triageCases } from "../../../src/shared/config/schema.js";
import { eq, inArray } from "drizzle-orm";
import {
  giveConsent,
  checkValidConsent,
  getConsentByCase,
} from "../../../src/modules/consent/consent.service.js";
import { AppError } from "../../../src/shared/utils/AppError.js";
import { env } from "../../../src/shared/config/env.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

async function ensureStandardTestPatient() {
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "test@example.com"));

  if (!existingUser) {
    const passwordHash = await bcrypt.hash("password123", 10);
    const [p] = await db
      .insert(patients)
      .values({
        name: "Test Patient",
        phoneNumber: "+919876543210",
      })
      .returning();

    await db.insert(users).values({
      name: "Test Patient",
      email: "test@example.com",
      passwordHash,
      role: "patient",
      patientId: p.id,
    });
  }
}

export async function runConsentTests() {
  await ensureStandardTestPatient();
  console.log("\n========================================================");
  console.log("  TEST SUITE: Consent Module (api-contract.md §2)       ");
  console.log("========================================================");

  // 1. Setup a test patient
  const [patient] = await db
    .insert(patients)
    .values({ name: "Consent Test Subject" })
    .returning();

  if (!patient) throw new Error("Could not create test patient");

  // Part A: Domain Service Logic Tests
  console.log("\n--- Part A: Domain Service & Edge Case Verification ---");

  // 1. giveConsent
  const consentRecord = await giveConsent({
    patient_id: patient.id,
    given_by: "self",
    policy_version: "v1.0",
  });
  console.log(
    "✓ giveConsent created record with valid_until:",
    consentRecord.valid_until
  );

  // 2. checkValidConsent matching mode
  const valid = await checkValidConsent(patient.id, "self");
  if (valid.id !== consentRecord.consent_id)
    throw new Error("Consent ID mismatch");
  console.log("✓ checkValidConsent verified active self consent");

  // 3. Mode mismatch check (assisted vs self)
  try {
    await checkValidConsent(patient.id, "assisted");
    throw new Error("Expected mode mismatch to throw");
  } catch (err: any) {
    if (err instanceof AppError && err.code === "consent_required") {
      console.log(
        "✓ checkValidConsent rejected mode mismatch with 403 consent_required"
      );
    } else {
      throw err;
    }
  }

  // 4. Expired consent check
  await db.delete(consent).where(eq(consent.patientId, patient.id));
  const pastDate = new Date(Date.now() - 35 * 60 * 1000);
  await giveConsent({
    patient_id: patient.id,
    given_by: "self",
    policy_version: "v1.0",
    timestamp: pastDate,
  });

  try {
    await checkValidConsent(patient.id, "self");
    throw new Error("Expected expired consent to throw");
  } catch (err: any) {
    if (err instanceof AppError && err.code === "consent_required") {
      console.log(
        "✓ checkValidConsent rejected expired consent with 403 consent_required"
      );
    } else {
      throw err;
    }
  }

  // Part B: HTTP Controller & Anti-Tampering Verification
  console.log("\n--- Part B: HTTP API & Anti-Tampering Verification ---");

  // Login as standard test patient
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "password123",
    }),
  });
  const { token } = await loginRes.json();

  // 5. POST /api/consent with omitted patient_id (auto-resolved from token)
  const httpRes = await fetch(`${BASE_URL}/api/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ given_by: "self", policy_version: "v1.0" }),
  });
  const httpData = await httpRes.json();
  if (httpRes.status !== 201 || !httpData.patient_id) {
    throw new Error(`HTTP consent failed: ${JSON.stringify(httpData)}`);
  }
  console.log(
    "✓ HTTP self-consent auto-resolved patient_id server-side:",
    httpData.patient_id
  );

  // 6. Security: Anti-tampering (trying to submit for someone else's ID)
  const tamperRes = await fetch(`${BASE_URL}/api/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      patient_id: "00000000-0000-0000-0000-000000000000",
      given_by: "self",
      policy_version: "v1.0",
    }),
  });
  if (tamperRes.status !== 403) {
    throw new Error(
      `Tampering was not rejected with 403, got ${tamperRes.status}`
    );
  }
  console.log(
    "✓ Anti-tampering confirmed: forged patient_id rejected with 403 forbidden"
  );

  // Part C: getConsentByCase & GET /api/consent/:caseId Verification
  console.log("\n--- Part C: getConsentByCase & Anti-Enumeration Verification ---");

  // 1. Setup entities for getConsentByCase tests
  const [pA] = await db.insert(patients).values({ name: "Patient Alpha" }).returning();
  const [pB] = await db.insert(patients).values({ name: "Patient Beta" }).returning();

  const [uA] = await db.insert(users).values({
    name: "User Alpha",
    email: `patient.alpha.${Date.now()}@example.com`,
    passwordHash: "hash123",
    role: "patient",
    patientId: pA.id,
  }).returning();

  const [uB] = await db.insert(users).values({
    name: "User Beta",
    email: `patient.beta.${Date.now()}@example.com`,
    passwordHash: "hash123",
    role: "patient",
    patientId: pB.id,
  }).returning();

  const [uRecep] = await db.insert(users).values({
    name: "Receptionist Alpha",
    email: `recep.alpha.${Date.now()}@example.com`,
    passwordHash: "hash123",
    role: "receptionist",
  }).returning();

  const [uDoc] = await db.insert(users).values({
    name: "Doctor Alpha",
    email: `doctor.alpha.${Date.now()}@example.com`,
    passwordHash: "hash123",
    role: "doctor",
  }).returning();

  const tokenA = jwt.sign({ sub: uA.id, role: "patient" }, env.jwtSecret, { expiresIn: "1h" });
  const tokenB = jwt.sign({ sub: uB.id, role: "patient" }, env.jwtSecret, { expiresIn: "1h" });
  const tokenRecep = jwt.sign({ sub: uRecep.id, role: "receptionist" }, env.jwtSecret, { expiresIn: "1h" });
  const tokenDoc = jwt.sign({ sub: uDoc.id, role: "doctor" }, env.jwtSecret, { expiresIn: "1h" });

  // 2. Create distinct consents for Patient A
  // Consent 1 (Self): earlier timestamp
  const [consentA] = await db.insert(consent).values({
    patientId: pA.id,
    givenBy: "self",
    policyVersion: "v1.0-alpha",
    givenAt: new Date(Date.now() - 10 * 60 * 1000), // 10m ago
  }).returning();

  // Consent 2 (Staff): later timestamp
  const [consentAStaff] = await db.insert(consent).values({
    patientId: pA.id,
    givenBy: "staff",
    staffId: uRecep.id,
    policyVersion: "v2.0-staff",
    givenAt: new Date(Date.now() - 2 * 60 * 1000), // 2m ago (latest)
  }).returning();

  // 3. Create cases
  // Case 1: Created by Patient A, specifically linked to earlier consentA via consent_id FK
  const [case1] = await db.insert(triageCases).values({
    patientId: pA.id,
    createdBy: uA.id,
    consentId: consentA.id,
    mode: "self",
    status: "submitted",
    chiefComplaint: "Case 1 self complaint",
  }).returning();

  // Case 2: Created by Receptionist, specifically linked to consentAStaff via consent_id FK
  const [case2] = await db.insert(triageCases).values({
    patientId: pA.id,
    createdBy: uRecep.id,
    consentId: consentAStaff.id,
    mode: "assisted",
    status: "submitted",
    chiefComplaint: "Case 2 assisted complaint",
  }).returning();

  try {
    // 4. Service Level: Patient A retrieves consent for own Case 1
    const resA = await getConsentByCase(case1.id, { id: uA.id, role: "patient" });
    assert.equal(resA.consent_id, consentA.id);
    assert.equal(resA.patient_id, pA.id);
    assert.equal(resA.given_by, "self");
    assert.equal(resA.staff_id, null);
    assert.equal(resA.policy_version, "v1.0-alpha");
    assert.ok(resA.given_at);

    // Critical FK Check: Verify it retrieved consentA (linked via FK), NOT the newer consentAStaff
    assert.equal(
      resA.consent_id,
      consentA.id,
      "Must fetch consent via case.consent_id FK, not fresh patient_id lookup"
    );
    console.log("✓ getConsentByCase: Patient can view own case consent via FK link");

    // 5. Service Level Anti-Enumeration: Patient B attempts on Case 1
    let nonOwnerRejected = false;
    try {
      await getConsentByCase(case1.id, { id: uB.id, role: "patient" });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        nonOwnerRejected = true;
      }
    }
    assert.ok(nonOwnerRejected, "Patient B on Case 1 must receive 404 not_found, NOT 403");
    console.log("✓ Anti-enumeration: Non-owner patient gets 404 not_found");

    // 6. Service Level: Receptionist on case they created (Case 2)
    const resRecep = await getConsentByCase(case2.id, { id: uRecep.id, role: "receptionist" });
    assert.equal(resRecep.consent_id, consentAStaff.id);
    assert.equal(resRecep.staff_id, uRecep.id);
    assert.equal(resRecep.given_by, "staff");
    console.log("✓ getConsentByCase: Receptionist can view consent for case they created");

    // 7. Service Level Anti-Enumeration: Receptionist attempts on Case 1 (created by Patient A)
    let recepNonOwnerRejected = false;
    try {
      await getConsentByCase(case1.id, { id: uRecep.id, role: "receptionist" });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        recepNonOwnerRejected = true;
      }
    }
    assert.ok(recepNonOwnerRejected, "Receptionist on non-created case must receive 404 not_found, NOT 403");
    console.log("✓ Anti-enumeration: Receptionist on un-created case gets 404 not_found");

    // 8. Service Level: Doctor on any case (Case 1 and Case 2)
    const docRes1 = await getConsentByCase(case1.id, { id: uDoc.id, role: "doctor" });
    assert.equal(docRes1.consent_id, consentA.id);
    const docRes2 = await getConsentByCase(case2.id, { id: uDoc.id, role: "doctor" });
    assert.equal(docRes2.consent_id, consentAStaff.id);
    console.log("✓ getConsentByCase: Doctor can view consent for any case without restriction");

    // 9. HTTP Endpoint: GET /api/consent/:caseId
    // 9a. Patient A accessing own case -> 200
    const httpResA = await fetch(`${BASE_URL}/api/consent/${case1.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(httpResA.status, 200);
    const httpDataA = await httpResA.json();
    assert.equal(httpDataA.consent_id, consentA.id);
    assert.equal(httpDataA.policy_version, "v1.0-alpha");

    // 9b. Patient B accessing Patient A's case -> 404 anti-enumeration
    const httpResB = await fetch(`${BASE_URL}/api/consent/${case1.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(httpResB.status, 404, "HTTP non-owner must get 404 not_found");
    const httpDataB = await httpResB.json();
    assert.equal(httpDataB.error?.code, "not_found");

    // 9c. Receptionist accessing case they created -> 200
    const httpResRecep = await fetch(`${BASE_URL}/api/consent/${case2.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenRecep}` },
    });
    assert.equal(httpResRecep.status, 200);
    const httpDataRecep = await httpResRecep.json();
    assert.equal(httpDataRecep.consent_id, consentAStaff.id);

    // 9d. Receptionist accessing case created by someone else -> 404 anti-enumeration
    const httpResRecepDenied = await fetch(`${BASE_URL}/api/consent/${case1.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenRecep}` },
    });
    assert.equal(httpResRecepDenied.status, 404, "HTTP receptionist non-creator must get 404");
    const httpDataRecepDenied = await httpResRecepDenied.json();
    assert.equal(httpDataRecepDenied.error?.code, "not_found");

    // 9e. Doctor accessing any case -> 200
    const httpResDoc = await fetch(`${BASE_URL}/api/consent/${case1.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenDoc}` },
    });
    assert.equal(httpResDoc.status, 200);
    const httpDataDoc = await httpResDoc.json();
    assert.equal(httpDataDoc.consent_id, consentA.id);

    console.log("✓ HTTP GET /api/consent/:caseId confirmed: 200 for authorized, 404 for anti-enumeration");
  } finally {
    // Cleanup test cases & users
    await db.delete(triageCases).where(inArray(triageCases.id, [case1.id, case2.id]));
    await db.delete(consent).where(inArray(consent.id, [consentA.id, consentAStaff.id]));
    await db.delete(users).where(inArray(users.id, [uA.id, uB.id, uRecep.id, uDoc.id]));
    await db.delete(patients).where(inArray(patients.id, [pA.id, pB.id]));
  }

  // Cleanup
  await db.delete(consent).where(eq(consent.patientId, patient.id));
  await db.delete(patients).where(eq(patients.id, patient.id));
  console.log("\n>> All Consent test assertions passed and cleaned up!");
}

if (process.argv[1]?.endsWith("consent.test.ts")) {
  runConsentTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
