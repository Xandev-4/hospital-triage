import { db } from "../../../src/shared/config/db.js";
import {
  users,
  patients,
  consent,
  triageCases,
} from "../../../src/shared/config/schema.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runCasesTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Cases Module (api-contract.md §4 & §5)   ");
  console.log("========================================================");

  // Setup: Log in Patient 1
  const p1Login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "password123",
    }),
  });
  const { token: tokenP1 } = await p1Login.json();

  const [u1] = await db
    .select()
    .from(users)
    .where(eq(users.email, "test@example.com"));
  const p1PatientId = u1!.patientId!;

  // Clean existing consent and cases for clean slate
  await db.delete(triageCases).where(eq(triageCases.patientId, p1PatientId));
  await db.delete(consent).where(eq(consent.patientId, p1PatientId));

  // 1. Case creation without consent (Must fail with 403 consent_required)
  console.log("\n[Cases 1] POST /api/cases with NO consent");
  const noConsentRes = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenP1}`,
    },
    body: JSON.stringify({
      chief_complaint: "Severe fever and body chills",
      duration: "2 days",
    }),
  });
  const noConsentData = await noConsentRes.json();
  if (
    noConsentRes.status !== 403 ||
    noConsentData.error?.code !== "consent_required"
  ) {
    throw new Error(
      `Expected 403 consent_required, got ${noConsentRes.status}`
    );
  }
  console.log(
    "✓ Gating verified: Case creation blocked with 403 consent_required"
  );

  // 2. Provide fresh consent
  console.log("\n[Cases 2] POST /api/consent (Recording active consent)");
  const consentRes = await fetch(`${BASE_URL}/api/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenP1}`,
    },
    body: JSON.stringify({ given_by: "self", policy_version: "v1.0" }),
  });
  if (consentRes.status !== 201) throw new Error("Consent creation failed");
  console.log("✓ Active consent recorded");

  // 3. Create case with active consent
  console.log("\n[Cases 3] POST /api/cases with active consent");
  const createRes = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenP1}`,
    },
    body: JSON.stringify({
      chief_complaint: "Severe fever and body chills",
      duration: "2 days",
      symptoms: "Chills, muscle pain, high fever",
    }),
  });
  const createData = await createRes.json();
  if (
    createRes.status !== 201 ||
    !["submitted", "queued"].includes(createData.status) ||
    createData.mode !== "self"
  ) {
    throw new Error(`Case creation failed: ${JSON.stringify(createData)}`);
  }
  const caseId = createData.case_id;
  console.log(
    `✓ Case created successfully: status=${createData.status}, mode=self, case_id:`,
    caseId
  );

  // 4. GET /api/cases/:id by owner
  console.log("\n[Cases 4] GET /api/cases/:id by owner");
  const getRes = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
    headers: { Authorization: `Bearer ${tokenP1}` },
  });
  const getData = await getRes.json();
  if (getRes.status !== 200 || getData.case_id !== caseId) {
    throw new Error(`Failed to get case: ${JSON.stringify(getData)}`);
  }
  console.log("✓ Full case details retrieved by owner");

  // 5. Anti-Enumeration: GET /api/cases/:id by Patient 2 (Must return 404, not 403)
  console.log("\n[Cases 5] Anti-Enumeration: GET /api/cases/:id by non-owner");
  let tokenP2: string;
  const p2Login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "patient2@example.com",
      password: "password123",
    }),
  });
  if (p2Login.status === 200) {
    const d = await p2Login.json();
    tokenP2 = d.token;
  } else {
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Patient Two",
        email: "patient2@example.com",
        password: "password123",
      }),
    });
    const l2 = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "patient2@example.com",
        password: "password123",
      }),
    });
    const d = await l2.json();
    tokenP2 = d.token;
  }

  const anonRes = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
    headers: { Authorization: `Bearer ${tokenP2}` },
  });
  const anonData = await anonRes.json();
  if (anonRes.status !== 404 || anonData.error?.code !== "not_found") {
    throw new Error(
      `Anti-enumeration failed! Expected 404, got ${anonRes.status}`
    );
  }
  console.log("✓ Anti-enumeration confirmed: non-owner received 404 not_found");

  // 6. Expired consent gating (> 30 min old)
  console.log("\n[Cases 6] Expired consent rejection (> 30 minutes old)");
  const pastDate = new Date(Date.now() - 35 * 60 * 1000);
  await db
    .update(consent)
    .set({ givenAt: pastDate })
    .where(eq(consent.patientId, p1PatientId));

  const expiredRes = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenP1}`,
    },
    body: JSON.stringify({ chief_complaint: "New complaint after expiry" }),
  });
  const expiredData = await expiredRes.json();
  if (
    expiredRes.status !== 403 ||
    expiredData.error?.code !== "consent_required"
  ) {
    throw new Error(
      `Expected 403 consent_required for expired consent, got ${expiredRes.status}`
    );
  }
  console.log("✓ Expired consent rejected with 403 consent_required");

  // 7. Mode mismatch (Receptionist trying to use self consent)
  console.log("\n[Cases 7] Mode mismatch (Receptionist + self consent)");
  // Create or login receptionist
  let tokenRecep: string;
  const recepEmail = "receptionist@hospital.gov.in";
  const rL = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: recepEmail, password: "password123" }),
  });
  if (rL.status === 200) {
    const d = await rL.json();
    tokenRecep = d.token;
  } else {
    const hash = await bcrypt.hash("password123", 10);
    await db.insert(users).values({
      role: "receptionist",
      name: "Desk Nurse",
      email: recepEmail,
      passwordHash: hash,
    });
    const rL2 = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: recepEmail, password: "password123" }),
    });
    const d = await rL2.json();
    tokenRecep = d.token;
  }

  // Refresh Patient 1's self consent to NOW
  await db
    .update(consent)
    .set({ givenAt: new Date(), givenBy: "self" })
    .where(eq(consent.patientId, p1PatientId));

  const mismatchRes = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenRecep}`,
    },
    body: JSON.stringify({
      patient_id: p1PatientId,
      chief_complaint: "Assisted intake with self consent",
    }),
  });
  const mismatchData = await mismatchRes.json();
  if (
    mismatchRes.status !== 403 ||
    mismatchData.error?.code !== "consent_required"
  ) {
    throw new Error(
      `Expected 403 consent_required for mode mismatch, got ${mismatchRes.status}`
    );
  }
  console.log("✓ Mode mismatch rejected with 403 consent_required");

  // 8. GET /api/cases list check
  console.log("\n[Cases 8] GET /api/cases");
  const listRes = await fetch(`${BASE_URL}/api/cases`, {
    headers: { Authorization: `Bearer ${tokenP1}` },
  });
  const listData = await listRes.json();
  if (listRes.status !== 200 || !Array.isArray(listData.cases)) {
    throw new Error("Failed to list cases");
  }
  // 9. Blocked Route: POST /api/cases/:id/process is internal-only (must return 404 from external HTTP)
  console.log(
    "\n[Cases 9] Blocked Route: POST /api/cases/:id/process is internal-only"
  );
  const processHttpRes = await fetch(
    `${BASE_URL}/api/cases/${caseId}/process`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenP1}`,
      },
      body: JSON.stringify({}),
    }
  );
  if (processHttpRes.status !== 404) {
    throw new Error(
      `Security failure! /process should never be exposed via HTTP. Expected 404, got ${processHttpRes.status}`
    );
  }
  console.log("✓ External HTTP call to /process blocked (returned 404)");

  console.log("\n>> All Cases test assertions passed!");
}

if (process.argv[1]?.endsWith("cases.test.ts")) {
  runCasesTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
