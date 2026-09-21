import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import {
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runQueueRoutesTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: GET /api/queue HTTP Endpoint & Access   ");
  console.log("=======================================================");

  const passwordHash = await bcrypt.hash("testpass123", 10);

  // Setup Doctor A, Doctor B, Patient User
  const [docA] = await db
    .insert(users)
    .values({
      name: "Dr. Alpha",
      email: `doc_alpha_${Date.now()}@hospital.org`,
      passwordHash,
      role: "doctor",
    })
    .returning();

  const [docB] = await db
    .insert(users)
    .values({
      name: "Dr. Beta",
      email: `doc_beta_${Date.now()}@hospital.org`,
      passwordHash,
      role: "doctor",
    })
    .returning();

  const [patientUser] = await db
    .insert(users)
    .values({
      name: "Patient Route Tester",
      email: `patient_http_${Date.now()}@example.com`,
      passwordHash,
      role: "patient",
    })
    .returning();

  const [patientProfile] = await db
    .insert(patients)
    .values({
      name: "Queue Patient",
      phoneNumber: "+919111122222",
    })
    .returning();

  const [activeConsent] = await db
    .insert(consent)
    .values({
      patientId: patientProfile.id,
      givenBy: "self",
      policyVersion: "v1.0",
      validUntil: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning();

  // Create a queued case created by Dr. A
  const [testCase] = await db
    .insert(triageCases)
    .values({
      patientId: patientProfile.id,
      createdBy: docA.id,
      consentId: activeConsent.id,
      mode: "self",
      status: "queued",
      chiefComplaint: "Severe migraine and photophobia",
      riskLevel: "medium",
    })
    .returning();

  try {
    // 1. Unauthenticated request -> 401
    console.log("\n--- Test 1: Unauthenticated request to /api/queue ---");
    const unauthRes = await fetch(`${BASE_URL}/api/queue`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assert.equal(unauthBody.error.code, "unauthorized");
    console.log("✓ Unauthenticated request rejected with 401 unauthorized");

    // 2. Patient token request -> 403 forbidden
    console.log("\n--- Test 2: Patient token request to /api/queue ---");
    const patientLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: patientUser.email,
        password: "testpass123",
      }),
    });
    const { token: patientToken } = await patientLogin.json();

    const patientRes = await fetch(`${BASE_URL}/api/queue`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    assert.equal(patientRes.status, 403);
    const patientBody = await patientRes.json();
    assert.equal(patientBody.error.code, "forbidden");
    console.log("✓ Patient role blocked with 403 forbidden");

    // 3. Doctor B token request -> 200 OK and sees Dr. A's case
    // Confirms: "no ownership filter: all doctors share the full queue, single-facility V1"
    console.log(
      "\n--- Test 3: Doctor token & Shared Queue Access (No ownership filter) ---"
    );
    const docBLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: docB.email,
        password: "testpass123",
      }),
    });
    const { token: docBToken } = await docBLogin.json();

    const docRes = await fetch(`${BASE_URL}/api/queue`, {
      headers: { Authorization: `Bearer ${docBToken}` },
    });
    assert.equal(docRes.status, 200);
    const docBody = await docRes.json();

    assert.ok(
      Array.isArray(docBody.queue),
      "Response must contain queue array"
    );
    const foundCase = docBody.queue.find(
      (item: any) => item.case_id === testCase.id
    );
    assert.ok(
      foundCase,
      "Doctor B must see case created by Doctor A (shared single-facility queue)"
    );
    assert.equal(foundCase.risk_level, "medium");
    assert.equal(foundCase.patient_display, "Queue Patient");
    assert.equal(foundCase.status, "queued");
    console.log(
      "✓ Doctor B successfully retrieved queue and verified shared queue visibility"
    );

    // 4. Filtering check via query params
    console.log(
      "\n--- Test 4: Query param filtering (risk_level=critical) ---"
    );
    const filterRes = await fetch(`${BASE_URL}/api/queue?risk_level=critical`, {
      headers: { Authorization: `Bearer ${docBToken}` },
    });
    assert.equal(filterRes.status, 200);
    const filterBody = await filterRes.json();
    const filterFound = filterBody.queue.find(
      (item: any) => item.case_id === testCase.id
    );
    assert.equal(
      filterFound,
      undefined,
      "Medium risk case must be excluded when filtering by critical"
    );
    console.log("✓ Query param filtering verified over HTTP");

    console.log("\n✓ ALL GET /api/queue HTTP endpoint tests passed!");
  } finally {
    await db.delete(triageCases).where(eq(triageCases.id, testCase.id));
    await db.delete(consent).where(eq(consent.id, activeConsent.id));
    await db.delete(patients).where(eq(patients.id, patientProfile.id));
    await db
      .delete(users)
      .where(inArray(users.id, [docA.id, docB.id, patientUser.id]));
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("queue.routes.test.ts") ||
    process.argv[1].endsWith("queue.routes.test.js"))
) {
  runQueueRoutesTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Queue routes test failed:", err);
      process.exit(1);
    });
}
