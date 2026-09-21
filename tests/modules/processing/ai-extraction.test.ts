import assert from "node:assert/strict";
import {
  extractStructuredData,
  validateAndSanitizeOutput,
} from "../../../src/modules/processing/ai-extraction.js";

export async function runAiExtractionTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: AI Extraction Module                   ");
  console.log("=======================================================");

  // 1. Happy path: valid structured extraction
  console.log("\n--- Testing Happy Path Structured Extraction ---");
  {
    const res = await extractStructuredData({
      chief_complaint: "fever and headache",
      duration: "3 days",
      symptoms: "high fever, severe headache, chills",
      vitals: {
        temperature: 102.5,
        spo2: 98,
        heart_rate: 85,
        systolic_bp: 120,
        diastolic_bp: 80,
      },
    });

    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.chiefComplaint, "fever and headache");
      assert.equal(res.data.duration, "3 days");
      assert.equal(res.data.vitals.temperature, 102.5);
      assert.equal(res.data.vitals.spo2, 98);
      assert.equal(res.data.vitals.heartRate, 85);
      assert.ok(res.confidence >= 0.7);
      assert.equal(res.data.suggestedDepartment, "General Medicine");
    }
    console.log(
      "✓ Happy path passed: Structured clinical data correctly extracted and typed"
    );
  }

  // 2. Section 8 Missing-Info Checklist
  console.log("\n--- Testing Section 8 Missing-Info Detection ---");
  {
    const res = await extractStructuredData({
      chief_complaint: "chest pain",
      duration: "1 hour",
      symptoms: "dull aching pain",
      // missing vitals, missing radiation pattern
    });

    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.suggestedDepartment, "Cardiology");
      assert.ok(
        res.data.missingInfo.includes("spo2_reading") ||
          res.data.missingInfo.includes("radiation_pattern") ||
          res.data.missingInfo.includes("bp_reading"),
        "Missing info checklist should flag empty critical fields"
      );
    }
    console.log(
      "✓ Missing-info passed: Section 8 checklists detect incomplete fields"
    );
  }

  // 3. Low-Confidence Signal (Demo Scenario D)
  console.log("\n--- Testing Low-Confidence Handling (Demo Scenario D) ---");
  {
    const res = await extractStructuredData({
      chief_complaint: "unclear scribbles",
      simulateLowConfidence: true,
    });

    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.reason, "low_confidence");
      assert.ok(res.confidence < 0.7);
      assert.ok(
        res.data !== undefined,
        "Partial data should be available for manual fallback"
      );
    }
    console.log(
      "✓ Low-confidence passed: Signals manual_fallback cleanly without throwing"
    );
  }

  // 4. Validation Guard against Malformed AI Output
  console.log("\n--- Testing Validation Guard on Malformed AI Output ---");
  {
    // Direct unit test of validator with garbage vitals
    const invalidValidation = validateAndSanitizeOutput({
      chiefComplaint: "headache",
      vitals: {
        heartRate: "abc", // Non-numeric garbage!
      },
    });

    assert.equal(invalidValidation.valid, false);
    assert.ok(
      invalidValidation.errors.some((e) => e.includes("heartRate")),
      "Validator must catch non-numeric vital readings"
    );

    // Extraction wrapper behavior on malformed output
    const res = await extractStructuredData({
      simulateMalformedOutput: true,
    });

    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.reason, "ai_malformed_output");
      assert.ok(res.error?.includes("heartRate"));
    }
    console.log(
      "✓ Validation guard passed: Malformed vital ('abc') caught and routed away from database"
    );
  }

  // 5. Provider Timeout Enforcement
  console.log("\n--- Testing Provider Timeout Enforcement ---");
  {
    const res = await extractStructuredData(
      {
        simulateTimeout: true,
      },
      {
        timeoutMs: 100, // 100ms timeout
      }
    );

    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.reason, "ai_extraction_timeout");
      assert.ok(res.error?.includes("timeout"));
    }
    console.log(
      "✓ Timeout passed: Provider call exceeding timeout aborts and returns ai_extraction_timeout"
    );
  }

  // 6. Upstream Provider Error Handling
  console.log("\n--- Testing Provider Error Handling ---");
  {
    const res = await extractStructuredData({
      simulateFailure: true,
    });

    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.reason, "provider_error");
    }
    console.log(
      "✓ Provider error passed: Upstream failure cleanly reported to caller"
    );
  }

  console.log("\n✓ ALL AI Extraction unit tests passed!");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("ai-extraction.test.ts") ||
    process.argv[1].endsWith("ai-extraction.test.js"))
) {
  runAiExtractionTests().catch((err) => {
    console.error("AI extraction test failed:", err);
    process.exit(1);
  });
}
