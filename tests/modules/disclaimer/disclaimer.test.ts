import assert from "node:assert/strict";
import { NON_DIAGNOSTIC_DISCLAIMER_TEXT } from "../../../src/app.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runDisclaimerTests() {
  console.log("\n=======================================================");
  console.log("  TEST SUITE: Non-Diagnostic Disclaimer (API §9)      ");
  console.log("=======================================================");

  // 1. GET /api/disclaimer without any authentication
  console.log("  → Test 1: GET /api/disclaimer returns 200 without authentication");
  const res = await fetch(`${BASE_URL}/api/disclaimer`, {
    method: "GET",
  });

  assert.equal(res.status, 200, "Expected 200 OK for /api/disclaimer");
  const body = (await res.json()) as { text?: string };

  assert.ok(body.text, "Response body must contain 'text' field");
  assert.equal(typeof body.text, "string", "'text' field must be a string");
  assert.equal(
    body.text,
    NON_DIAGNOSTIC_DISCLAIMER_TEXT,
    "Response text must match canonical NON_DIAGNOSTIC_DISCLAIMER_TEXT"
  );

  // 2. Clinical safety semantic verification
  console.log("  → Test 2: Disclaimer wording explicitly includes non-diagnostic notice");
  const lowerText = body.text.toLowerCase();
  assert.ok(
    lowerText.includes("non-diagnostic"),
    "Disclaimer text must explicitly include 'non-diagnostic'"
  );
  assert.ok(
    lowerText.includes("organizes information") || lowerText.includes("triage"),
    "Disclaimer text must clarify scope as triage / organization"
  );
  assert.ok(
    lowerText.includes("never prescribes") || lowerText.includes("provider"),
    "Disclaimer text must emphasize human provider clinical authority"
  );

  // 3. Health check sanity test
  console.log("  → Test 3: GET /api/health returns 200 { status: 'ok' }");
  const healthRes = await fetch(`${BASE_URL}/api/health`, {
    method: "GET",
  });
  assert.equal(healthRes.status, 200);
  const healthBody = (await healthRes.json()) as { status?: string };
  assert.equal(healthBody.status, "ok");

  console.log("✓ All Disclaimer & Misc API tests passed successfully!\n");
}

if (process.argv[1]?.endsWith("disclaimer.test.ts")) {
  runDisclaimerTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
