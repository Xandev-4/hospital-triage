import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import { consent, patients, users } from "../../../src/shared/config/schema.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

export async function runPipelineFullLoopTests() {
  console.log("\n=======================================================");
  console.log("  TEST SUITE: Full Pipeline E2E Loop                   ");
  console.log("=======================================================");

  // 1. Register a fresh isolated test patient
  const testEmail = `pipeline_${Date.now()}@example.com`;
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Pipeline Test Patient",
      email: testEmail,
      password: "password123",
      role: "patient",
    }),
  });

  assert.equal(
    regRes.status,
    201,
    "Test patient registration must succeed with 201"
  );

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: "password123",
    }),
  });
  assert.equal(loginRes.status, 200, "Login must succeed with 200 OK");
  const loginData = await loginRes.json();
  const token = loginData.token;
  assert.ok(token, "JWT token must be returned from login");

  // 2. Give fresh consent
  const consentRes = await fetch(`${BASE_URL}/api/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      given_by: "self",
      policy_version: "v1.0",
    }),
  });
  assert.equal(
    consentRes.status,
    201,
    "Consent recording must succeed with 201"
  );

  // ==========================================================================
  // Test 1: Full Loop — Critical Rule Trigger (SpO2 < 90%)
  // ==========================================================================
  console.log("\n--- Test 1: Full Loop with Critical Trigger (SpO2 < 90) ---");
  {
    const createRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chief_complaint: "Severe difficulty breathing",
        duration: "1 day",
        symptoms: "gasping for breath, blue lips",
        vitals: {
          spo2: 84,
          heart_rate: 110,
        },
      }),
    });

    assert.equal(createRes.status, 201, "Case creation must succeed with 201");
    const createData = await createRes.json();
    assert.ok(createData.case_id);
    assert.equal(createData.status, "queued");
    assert.equal(createData.mode, "self");

    const caseId = createData.case_id;

    // Fetch clinical report: GET /api/cases/:id/report
    const reportRes = await fetch(`${BASE_URL}/api/cases/${caseId}/report`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(reportRes.status, 200, "Report fetch must return 200 OK");
    const reportData = await reportRes.json();

    assert.equal(reportData.case_id, caseId);
    assert.equal(
      reportData.risk_level,
      "critical",
      "SpO2 84% must trigger critical risk level via rules engine"
    );
    assert.ok(Array.isArray(reportData.missing_info));
    assert.equal(typeof reportData.chief_complaint.value, "string");
    assert.equal(reportData.chief_complaint.source, "ai");

    console.log(
      "✓ Critical trigger loop passed: Case created -> auto-processed -> report verified risk=critical"
    );
  }

  // ==========================================================================
  // Test 2: Full Loop — AI vs Rules Disagreement (Rules Engine Always Wins)
  // ==========================================================================
  console.log(
    "\n--- Test 2: AI vs Rules Disagreement (Rules Engine Override) ---"
  );
  {
    // Acute coronary syndrome presentation: chest pain radiating to jaw/arm.
    // We simulate AI suggesting "low". Rules engine MUST override to "critical".
    const createRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chief_complaint: "Severe crushing chest pain",
        duration: "2 hours",
        symptoms: "chest pressure radiating to left arm and jaw",
        vitals: {
          spo2: 98,
          systolic_bp: 140,
          diastolic_bp: 90,
        },
        ai_suggested_risk: "low", // AI hallucinates/underestimates
      }),
    });

    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.equal(createData.status, "queued");
    const caseId = createData.case_id;

    // Fetch report to verify disagreement banner content
    const reportRes = await fetch(`${BASE_URL}/api/cases/${caseId}/report`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(reportRes.status, 200);
    const reportData = await reportRes.json();

    // SAFETY INVARIANT VERIFICATION:
    assert.equal(
      reportData.risk_level,
      "critical",
      "Rules engine (critical) must strictly override AI suggested risk (low)"
    );
    assert.equal(reportData.ai_rules_disagreement.present, true);
    assert.equal(reportData.ai_rules_disagreement.ai_suggested, "low");
    assert.equal(reportData.ai_rules_disagreement.rules_result, "critical");
    assert.equal(reportData.ai_rules_disagreement.note, "rules result applies");

    console.log(
      "✓ Disagreement loop passed: AI suggested 'low', rules evaluated 'critical', report stores risk='critical' and disagreement=true"
    );
  }

  // ==========================================================================
  // Test 3: Full Loop — Manual Fallback on Low Confidence (Demo Scenario D)
  // ==========================================================================
  console.log("\n--- Test 3: Manual Fallback Routing on Low Confidence ---");
  {
    const createRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chief_complaint: "illegible handwritten prescription note",
        simulate_low_confidence: true,
      }),
    });

    assert.equal(createRes.status, 201);
    const createData = await createRes.json();

    // Must be in manual_fallback, NEVER queued
    assert.equal(
      createData.status,
      "manual_fallback",
      "Low confidence intake must route to manual_fallback"
    );

    const caseId = createData.case_id;

    // Verify GET /api/cases/:id reflects manual_fallback
    const caseRes = await fetch(`${BASE_URL}/api/cases/${caseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const caseData = await caseRes.json();
    assert.equal(caseData.status, "manual_fallback");

    // Verify GET /api/cases/:id/report handles manual_fallback cleanly
    const reportRes = await fetch(`${BASE_URL}/api/cases/${caseId}/report`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(reportRes.status, 200);
    const reportData = await reportRes.json();
    assert.equal(reportData.status, "manual_fallback");
    assert.equal(reportData.risk_level, null);

    console.log(
      "✓ Manual fallback loop passed: Low confidence intake cleanly transitioned to manual_fallback"
    );
  }

  // ==========================================================================
  // Test 4: Full Loop — Missing-Info Checklist Detection & Risk Floor
  // ==========================================================================
  console.log("\n--- Test 4: Missing-Info Detection & Safety Risk Floor ---");
  {
    // Acute chest pain submitted with zero vitals and no duration
    const createRes = await fetch(`${BASE_URL}/api/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chief_complaint: "chest pain",
        symptoms: "dull aching pain in center of chest",
        // vitals omitted, duration omitted
      }),
    });

    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    const caseId = createData.case_id;

    const reportRes = await fetch(`${BASE_URL}/api/cases/${caseId}/report`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(reportRes.status, 200);
    const reportData = await reportRes.json();

    // Section 8 checklist verification:
    assert.ok(
      reportData.missing_info.includes("duration") ||
        reportData.missing_info.includes("spo2_reading") ||
        reportData.missing_info.includes("bp_reading"),
      "Report must contain missing checklist items"
    );

    // Fail-closed risk floor verification (RR-MISSING-02 enforces medium):
    assert.equal(
      reportData.risk_level,
      "medium",
      "Missing vitals on acute chest pain must enforce medium risk floor"
    );

    console.log(
      "✓ Missing-info loop passed: Expected fields flagged and fail-closed medium floor applied"
    );
  }

  console.log("\n✓ ALL Full Pipeline Loop E2E tests passed successfully!");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("pipeline-full-loop.test.ts") ||
    process.argv[1].endsWith("pipeline-full-loop.test.js"))
) {
  runPipelineFullLoopTests()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Pipeline full loop test failed:", err);
      process.exit(1);
    });
}
