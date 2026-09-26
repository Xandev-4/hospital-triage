import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../../src/app.js";
import { client, db } from "../../src/shared/config/db.js";
import { users } from "../../src/shared/config/schema.js";
import { eq, inArray } from "drizzle-orm";

async function runSeedVerification() {
  console.log("========================================================");
  console.log("  VERIFICATION: Seeded Staff Accounts & Role Guards     ");
  console.log("========================================================");

  // 1. Database existence check via Drizzle
  console.log(
    "\n[Step 1] Confirming seeded staff accounts in database via Drizzle..."
  );
  const expectedEmails = [
    "dr.aisha.sharma@hospital.org",
    "dr.marcus.chen@hospital.org",
    "reception.priya@hospital.org",
    "reception.rahul@hospital.org",
  ];

  const dbUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      patientId: users.patientId,
    })
    .from(users)
    .where(inArray(users.email, expectedEmails));

  console.log(`Found ${dbUsers.length} matching accounts in DB:`);
  for (const u of dbUsers) {
    console.log(
      `  - [${u.role.toUpperCase()}] ${u.name} <${u.email}> (ID: ${u.id}, patientId: ${u.patientId})`
    );
    assert.strictEqual(
      u.patientId,
      null,
      `Staff account ${u.email} must have patientId: null`
    );
  }
  assert.strictEqual(
    dbUsers.length,
    4,
    "Expected all 4 seeded staff accounts to exist in the database"
  );

  // Spin up an ephemeral HTTP server to test the actual live endpoints
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\nTest HTTP server listening on ${baseUrl}`);

  try {
    // 2. Doctor Login via /api/auth/login
    console.log("\n[Step 2] Testing Doctor Login: POST /api/auth/login...");
    const docLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dr.aisha.sharma@hospital.org",
        password: process.env.SEED_DOCTOR_1_PASSWORD || "DocSharma@Secure2026!",
      }),
    });

    const docLoginData = (await docLoginRes.json()) as any;
    console.log(`  → Response status: ${docLoginRes.status}`);
    console.log("  → Login payload:", docLoginData);
    assert.strictEqual(
      docLoginRes.status,
      200,
      "Doctor login must return HTTP 200"
    );
    assert.ok(
      docLoginData.token,
      "Doctor login response must include JWT token"
    );
    assert.strictEqual(
      docLoginData.role,
      "doctor",
      "Doctor login response role must be 'doctor'"
    );
    console.log("  ✓ Doctor login successful! JWT token received.");

    const docToken = docLoginData.token;

    // 3. Confirm /me returns role: 'doctor'
    console.log(
      "\n[Step 3] Testing /me with Doctor token: GET /api/auth/me..."
    );
    const docMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${docToken}`,
      },
    });

    const docMeData = (await docMeRes.json()) as any;
    console.log(`  → Response status: ${docMeRes.status}`);
    console.log("  → /me payload:", docMeData);
    assert.strictEqual(
      docMeRes.status,
      200,
      "GET /api/auth/me must return HTTP 200"
    );
    assert.strictEqual(
      docMeData.role,
      "doctor",
      "GET /api/auth/me must return role: 'doctor'"
    );
    assert.strictEqual(docMeData.email, "dr.aisha.sharma@hospital.org");
    console.log("  ✓ /me successfully verified role: 'doctor'!");

    // 4. Role Restriction Guard: Doctor hitting POST /api/cases (Patient/Receptionist only)
    console.log(
      "\n[Step 4] Testing Role Restriction: Doctor hitting POST /api/cases (patient/receptionist only)..."
    );
    const caseAttemptRes = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${docToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "self",
        chief_complaint: "Attempting case creation as doctor",
      }),
    });

    const caseAttemptData = (await caseAttemptRes.json()) as any;
    console.log(`  → Response status: ${caseAttemptRes.status}`);
    console.log("  → Error payload:", caseAttemptData);
    assert.strictEqual(
      caseAttemptRes.status,
      403,
      "Doctor calling POST /api/cases must be rejected with HTTP 403 Forbidden"
    );
    assert.strictEqual(caseAttemptData.error.code, "forbidden");
    console.log(
      "  ✓ Security Guard confirmed: Doctor was correctly rejected from POST /api/cases!"
    );

    // 5. Doctor Authorized Route: Doctor hitting GET /api/queue
    console.log(
      "\n[Step 5] Testing Doctor Authorized Route: GET /api/queue..."
    );
    const queueRes = await fetch(`${baseUrl}/api/queue`, {
      headers: { Authorization: `Bearer ${docToken}` },
    });
    console.log(`  → Response status: ${queueRes.status}`);
    assert.strictEqual(
      queueRes.status,
      200,
      "Doctor must have access to GET /api/queue"
    );
    console.log("  ✓ Doctor authorized route (GET /api/queue) accessible!");

    // 6. Receptionist Login via /api/auth/login
    console.log(
      "\n[Step 6] Testing Receptionist Login: POST /api/auth/login..."
    );
    const recepLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "reception.priya@hospital.org",
        password:
          process.env.SEED_RECEPTIONIST_1_PASSWORD || "RecepPriya@Secure2026!",
      }),
    });

    const recepLoginData = (await recepLoginRes.json()) as any;
    console.log(`  → Response status: ${recepLoginRes.status}`);
    assert.strictEqual(
      recepLoginRes.status,
      200,
      "Receptionist login must return HTTP 200"
    );
    assert.ok(
      recepLoginData.token,
      "Receptionist login must include JWT token"
    );
    assert.strictEqual(recepLoginData.role, "receptionist");
    console.log("  ✓ Receptionist login successful!");

    const recepToken = recepLoginData.token;

    // 7. Receptionist /me verification
    console.log(
      "\n[Step 7] Testing /me with Receptionist token: GET /api/auth/me..."
    );
    const recepMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${recepToken}` },
    });
    const recepMeData = (await recepMeRes.json()) as any;
    console.log(`  → Response status: ${recepMeRes.status}`);
    console.log("  → /me payload:", recepMeData);
    assert.strictEqual(recepMeRes.status, 200);
    assert.strictEqual(recepMeData.role, "receptionist");
    assert.strictEqual(recepMeData.email, "reception.priya@hospital.org");
    console.log("  ✓ /me successfully verified role: 'receptionist'!");

    // 8. Role Restriction Guard: Receptionist hitting Doctor-only route
    console.log(
      "\n[Step 8] Testing Role Restriction: Receptionist hitting GET /api/cases/:id/report/versions (Doctor only)..."
    );
    const docOnlyRes = await fetch(
      `${baseUrl}/api/cases/00000000-0000-0000-0000-000000000000/report/versions`,
      {
        headers: { Authorization: `Bearer ${recepToken}` },
      }
    );
    const docOnlyData = (await docOnlyRes.json()) as any;
    console.log(`  → Response status: ${docOnlyRes.status}`);
    console.log("  → Error payload:", docOnlyData);
    assert.strictEqual(
      docOnlyRes.status,
      403,
      "Receptionist calling doctor-only endpoint must be rejected with HTTP 403 Forbidden"
    );
    assert.strictEqual(docOnlyData.error.code, "forbidden");
    console.log(
      "  ✓ Security Guard confirmed: Receptionist was correctly rejected from doctor-only route!"
    );

    // 9. Receptionist Role Restriction: GET /api/queue (Doctor-only per api-contract §7 & §10)
    console.log(
      "\n[Step 9] Testing Receptionist Role Restriction: GET /api/queue (Doctor-only)..."
    );
    const recepQueueRes = await fetch(`${baseUrl}/api/queue`, {
      headers: { Authorization: `Bearer ${recepToken}` },
    });
    const recepQueueData = (await recepQueueRes.json()) as any;
    console.log(`  → Response status: ${recepQueueRes.status}`);
    console.log("  → Payload:", recepQueueData);
    assert.strictEqual(
      recepQueueRes.status,
      403,
      "Receptionist must be rejected from Doctor-only GET /api/queue with 403 Forbidden"
    );
    assert.strictEqual(recepQueueData.error.code, "forbidden");
    console.log(
      "  ✓ Security Guard confirmed: Receptionist correctly rejected from Doctor-only queue!"
    );

    // 10. Receptionist Authorized Route: POST /api/cases (Patient/Receptionist allowed, Doctor blocked)
    console.log(
      "\n[Step 10] Testing Receptionist Role Authorization on POST /api/cases (Patient/Receptionist allowed)..."
    );
    const recepCaseAttemptRes = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${recepToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "assisted",
        // Not passing patient_id/consent to observe that role check passes (no 403 forbidden)
      }),
    });
    const recepCaseAttemptData = (await recepCaseAttemptRes.json()) as any;
    console.log(`  → Response status: ${recepCaseAttemptRes.status}`);
    console.log("  → Payload:", recepCaseAttemptData);
    // Role check MUST NOT return 403 forbidden
    assert.notStrictEqual(
      recepCaseAttemptRes.status,
      403,
      "Receptionist must NOT be rejected with 403 forbidden on POST /api/cases"
    );
    console.log(
      "  ✓ Receptionist role passed authorization on POST /api/cases (unlike Doctor who was rejected with 403)!"
    );

    console.log("\n========================================================");
    console.log("  ✨ ALL SEED VERIFICATION & ROLE GUARD TESTS PASSED!   ");
    console.log("========================================================");
  } finally {
    server.close();
    await client.end();
  }
}

runSeedVerification().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
