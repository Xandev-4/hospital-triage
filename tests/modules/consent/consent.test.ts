import { db } from "../../../src/shared/config/db.js";
import { users, patients, consent } from "../../../src/shared/config/schema.js";
import { eq } from "drizzle-orm";
import {
  giveConsent,
  checkValidConsent,
} from "../../../src/modules/consent/consent.service.js";
import { AppError } from "../../../src/shared/utils/AppError.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runConsentTests() {
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
