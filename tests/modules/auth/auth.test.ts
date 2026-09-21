import { db } from "../../../src/shared/config/db.js";
import { users, patients } from "../../../src/shared/config/schema.js";
import { eq } from "drizzle-orm";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runAuthTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Auth Module (api-contract.md §1)          ");
  console.log("========================================================");

  const testEmail = `judge_test_${Date.now()}@example.com`;
  const testPassword = "judgePassword123";

  // 1. Patient Self-Registration
  console.log("\n[Auth 1] POST /api/auth/register");
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Judge Demo Patient",
      email: testEmail,
      password: testPassword,
      phone_number: "+919999988888",
    }),
  });

  const regData = await regRes.json();
  console.log("Registration Status:", regRes.status);
  if (regRes.status !== 201 || !regData.user_id || regData.role !== "patient") {
    throw new Error(`Registration failed: ${JSON.stringify(regData)}`);
  }
  console.log("✓ User created:", regData);

  // 2. Database Verification of Atomic Linked Records
  const [dbUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, regData.user_id));
  if (!dbUser || !dbUser.patientId)
    throw new Error("Database user or patientId missing");
  const [dbPatient] = await db
    .select()
    .from(patients)
    .where(eq(patients.id, dbUser.patientId));
  if (!dbPatient || dbPatient.phoneNumber !== "+919999988888") {
    throw new Error("Database linked patient record verification failed");
  }
  console.log("✓ Database atomic FK linkage confirmed:", {
    userId: dbUser.id,
    patientId: dbPatient.id,
    phone: dbPatient.phoneNumber,
  });

  // 3. Login
  console.log("\n[Auth 2] POST /api/auth/login");
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const loginData = await loginRes.json();
  if (loginRes.status !== 200 || !loginData.token) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const token = loginData.token;
  console.log("✓ Login successful, JWT token acquired");

  // 4. GET /api/auth/me
  console.log("\n[Auth 3] GET /api/auth/me");
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meData = await meRes.json();
  if (
    meRes.status !== 200 ||
    meData.email !== testEmail ||
    meData.role !== "patient"
  ) {
    throw new Error(`GET /me failed: ${JSON.stringify(meData)}`);
  }
  console.log("✓ Profile verified:", meData);

  // 5. POST /api/auth/logout
  console.log("\n[Auth 4] POST /api/auth/logout");
  const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
    method: "POST",
  });
  const logoutData = await logoutRes.json();
  if (logoutRes.status !== 200 || !logoutData.ok) {
    throw new Error(`Logout failed: ${JSON.stringify(logoutData)}`);
  }
  console.log("✓ Logout confirmed: { ok: true }");

  // 6. Security: Duplicate email registration (Anti-Enumeration 400)
  console.log("\n[Auth 5] Duplicate email anti-enumeration");
  const dupRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Duplicate Person",
      email: testEmail,
      password: "someOtherPassword123",
    }),
  });
  const dupData = await dupRes.json();
  if (dupRes.status !== 400 || dupData.error?.code !== "validation_error") {
    throw new Error(`Anti-enumeration test failed: ${JSON.stringify(dupData)}`);
  }
  console.log(
    "✓ Anti-enumeration confirmed: duplicate email rejected with 400 validation_error"
  );

  // 7. Security: Weak password rejection
  console.log("\n[Auth 6] Weak password validation");
  const weakRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Weak Pass",
      email: `weak_${Date.now()}@example.com`,
      password: "short",
    }),
  });
  if (weakRes.status !== 400)
    throw new Error("Weak password was not rejected with 400");
  console.log("✓ Weak password rejected with 400");

  // 8. Security: Invalid login credentials
  console.log("\n[Auth 7] Bad credentials on login");
  const badLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: "wrong_password" }),
  });
  if (badLoginRes.status !== 401)
    throw new Error("Bad credentials did not return 401");
  console.log("✓ Wrong credentials rejected with 401 unauthorized");

  // 9. Security: Unauthorized access to /me
  console.log("\n[Auth 8] Unauthorized /me request");
  const unauthRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: "Bearer bad.token.here" },
  });
  if (unauthRes.status !== 401) throw new Error("Bad token did not return 401");
  console.log("✓ Invalid token rejected with 401 unauthorized");

  // Cleanup
  await db.delete(users).where(eq(users.id, dbUser.id));
  await db.delete(patients).where(eq(patients.id, dbPatient.id));
  console.log("\n>> All Auth test assertions passed and cleaned up!");
}

if (process.argv[1]?.endsWith("auth.test.ts")) {
  runAuthTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
