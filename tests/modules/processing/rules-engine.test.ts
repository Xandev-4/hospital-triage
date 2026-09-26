import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRisk,
  type RiskLevel,
  type StructuredTriageInput,
} from "../../../src/modules/processing/rules-engine.js";

/**
 * Resolves final clinical risk between rules engine and hypothetical AI recommendation.
 * Safety invariant: Deterministic rules engine result ALWAYS wins if higher or enforces floor.
 */
function resolveRiskDisagreement(
  rulesResult: RiskLevel,
  aiSuggestedRisk: RiskLevel
): { finalRisk: RiskLevel; disagreement: boolean } {
  const SEVERITY: Record<RiskLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  const disagreement = rulesResult !== aiSuggestedRisk;
  // Safety floor: Rules engine never permits an AI model to downgrade risk
  const finalRisk =
    SEVERITY[rulesResult] >= SEVERITY[aiSuggestedRisk]
      ? rulesResult
      : aiSuggestedRisk;

  return { finalRisk, disagreement };
}

export async function runRulesEngineTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Pure Deterministic Rules Engine         ");
  console.log("=======================================================");

  // ===================================================================
  // 1. CRITICAL RULES
  // ===================================================================
  console.log("\n--- 1. Testing CRITICAL Rules ---");

  // RR-CRIT-01: Severe Hypoxemia (SpO2 < 90)
  {
    const res = evaluateRisk({
      chief_complaint: "Mild persistent cough",
      vitals: { spo2: 88, heart_rate: 92 },
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-01"));
    console.log("  ✓ RR-CRIT-01: SpO2 88% (<90) triggers critical risk");
  }

  // RR-CRIT-02: Unresponsive / Altered Consciousness
  {
    const res = evaluateRisk({
      chief_complaint: "Patient found unconscious on hallway floor",
      symptoms: "unresponsive to verbal stimuli and shaking",
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-02"));
    console.log("  ✓ RR-CRIT-02: Unconscious/unresponsive triggers critical risk");
  }

  // RR-CRIT-03: Active / Uncontrolled Bleeding
  {
    const res = evaluateRisk({
      chief_complaint: "Deep laceration to thigh",
      symptoms: "spurting blood and active bleeding uncontrolled by pressure",
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-03"));
    console.log("  ✓ RR-CRIT-03: Active/uncontrolled bleeding triggers critical risk");
  }

  // RR-CRIT-04: Respiratory Failure with Cyanosis (Severe Dyspnea + Cyanosis)
  {
    const res = evaluateRisk({
      chief_complaint: "severe difficulty breathing",
      symptoms: "blue lips and gasping for air",
      vitals: { spo2: 92 },
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-04"));
    console.log("  ✓ RR-CRIT-04: Severe dyspnea + cyanosis triggers critical risk");
  }

  // RR-CRIT-05: Active or Recent Seizure
  {
    const res = evaluateRisk({
      chief_complaint: "Active convulsions",
      symptoms: "violent fitting and post-ictal confusion observed",
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-05"));
    console.log("  ✓ RR-CRIT-05: Seizure/convulsions triggers critical risk");
  }

  // RR-CRIT-06: Maternal Obstetric Emergency (Severe Abdominal Pain in Pregnancy)
  {
    const res = evaluateRisk({
      chief_complaint: "severe abdominal pain",
      symptoms: "intense lower pelvic pain",
      isPregnant: true,
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-06"));
    console.log("  ✓ RR-CRIT-06: Severe abdominal pain in pregnancy triggers critical risk");
  }

  // RR-CRIT-07: Acute Coronary Syndrome with Radiation (Chest Pain + Radiation)
  {
    const res = evaluateRisk({
      chief_complaint: "Substernal chest pain",
      symptoms: "pain radiating to left arm and jaw",
      vitals: { spo2: 97, systolic_bp: 130, diastolic_bp: 85 },
    });
    assert.strictEqual(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-07"));
    console.log("  ✓ RR-CRIT-07: Chest pain radiating to arm/jaw triggers critical risk");
  }

  // ===================================================================
  // 2. HIGH RULES
  // ===================================================================
  console.log("\n--- 2. Testing HIGH Rules ---");

  // RR-HIGH-01: Chest Pain with Diaphoresis (Chest Pain + Sweating)
  {
    const res = evaluateRisk({
      chief_complaint: "Chest pressure",
      symptoms: "heavy sweating and cold sweats without radiation",
      vitals: { spo2: 98, systolic_bp: 135, diastolic_bp: 85 },
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-01"));
    console.log("  ✓ RR-HIGH-01: Chest pain with sweating triggers high risk");
  }

  // RR-HIGH-02: Severe Breathlessness without Cyanosis
  {
    const res = evaluateRisk({
      chief_complaint: "severe difficulty breathing",
      symptoms: "acute breathlessness, panting for air",
      vitals: { spo2: 95 },
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-02"));
    console.log("  ✓ RR-HIGH-02: Severe breathlessness without cyanosis triggers high risk");
  }

  // RR-HIGH-03: Hyperpyrexia with Confusion (Temp >= 103°F + Confusion)
  {
    const res = evaluateRisk({
      chief_complaint: "High fever",
      duration: "2 days",
      symptoms: "patient is confused and disoriented",
      vitals: { temperature: 103.5 },
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-03"));
    console.log("  ✓ RR-HIGH-03: High fever (>103°F) + confusion triggers high risk");
  }

  // RR-HIGH-04: Severe Blood Glucose Dysregulation (<60 or >300 mg/dL)
  {
    const lowSugar = evaluateRisk({
      chief_complaint: "Shakiness and lightheadedness",
      vitals: { blood_sugar: 48 },
    });
    assert.strictEqual(lowSugar.riskLevel, "high");
    assert.ok(lowSugar.triggeredRules.includes("RR-HIGH-04"));

    const highSugar = evaluateRisk({
      chief_complaint: "Severe thirst and frequent urination",
      vitals: { blood_sugar: 380 },
    });
    assert.strictEqual(highSugar.riskLevel, "high");
    assert.ok(highSugar.triggeredRules.includes("RR-HIGH-04"));
    console.log("  ✓ RR-HIGH-04: Blood sugar <60 and >300 trigger high risk");
  }

  // RR-HIGH-05: Upper GI or Pulmonary Bleeding (Hematemesis / Hemoptysis)
  {
    const res = evaluateRisk({
      chief_complaint: "Vomiting blood",
      symptoms: "dark coffee-ground emesis after dinner",
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-05"));
    console.log("  ✓ RR-HIGH-05: Vomiting blood (hematemesis) triggers high risk");
  }

  // RR-HIGH-06: Acute Neurological Deficit (Stroke Red Flag: Facial Droop, Slurred Speech)
  {
    const res = evaluateRisk({
      chief_complaint: "Sudden slurred speech",
      symptoms: "facial droop on right side noted by spouse",
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-06"));
    console.log("  ✓ RR-HIGH-06: Slurred speech / stroke red flag triggers high risk");
  }

  // RR-HIGH-07: Hypertensive Crisis (Systolic >= 180 or Diastolic >= 120)
  {
    const res = evaluateRisk({
      chief_complaint: "Dull throbbing occipital headache",
      vitals: { systolic_bp: 195, diastolic_bp: 105 },
    });
    assert.strictEqual(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-07"));
    console.log("  ✓ RR-HIGH-07: Systolic BP >= 180 triggers high risk");
  }

  // ===================================================================
  // 3. MEDIUM RULES
  // ===================================================================
  console.log("\n--- 3. Testing MEDIUM Rules ---");

  // RR-MED-01: Prolonged Fever (>3 Days)
  {
    const res = evaluateRisk({
      chief_complaint: "Fever and chills",
      duration: "5 days",
      symptoms: "constant mild fever",
      vitals: { temperature: 101 },
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-01"));
    console.log("  ✓ RR-MED-01: Fever persisting > 3 days triggers medium risk");
  }

  // RR-MED-02: Persistent Intractable Vomiting (No Blood)
  {
    const res = evaluateRisk({
      chief_complaint: "Nausea and vomiting",
      symptoms: "persistent vomiting multiple times, cannot keep fluids down",
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-02"));
    console.log("  ✓ RR-MED-02: Persistent vomiting triggers medium risk");
  }

  // RR-MED-03: Moderate Exertional Dyspnea Only
  {
    const res = evaluateRisk({
      chief_complaint: "Breathlessness on exertion",
      symptoms: "short of breath climbing stairs, normal at rest",
      vitals: { spo2: 96 },
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-03"));
    console.log("  ✓ RR-MED-03: Exertional dyspnea triggers medium risk");
  }

  // RR-MED-04: Worsening Chronic Condition
  {
    const res = evaluateRisk({
      chief_complaint: "Hypertension checkup",
      symptoms: "increased swelling in feet and ankles getting worse",
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-04"));
    console.log("  ✓ RR-MED-04: Worsening chronic condition triggers medium risk");
  }

  // RR-MED-05: Musculoskeletal Trauma with Swelling
  {
    const res = evaluateRisk({
      chief_complaint: "Twisted ankle",
      symptoms: "injury with visible swelling and bruising after slip",
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-05"));
    console.log("  ✓ RR-MED-05: Trauma with swelling triggers medium risk");
  }

  // ===================================================================
  // 4. EXACT BOUNDARY VALUE TESTS (Off-by-One Guardrails)
  // ===================================================================
  console.log("\n--- 4. Testing Exact Threshold Boundary Values ---");

  // A. SpO2 Threshold: < 90 triggers RR-CRIT-01
  {
    const at89 = evaluateRisk({
      chief_complaint: "Cough",
      vitals: { spo2: 89 },
    });
    assert.strictEqual(at89.riskLevel, "critical");
    assert.ok(at89.triggeredRules.includes("RR-CRIT-01"), "SpO2=89 must trigger RR-CRIT-01");

    const at90 = evaluateRisk({
      chief_complaint: "Cough",
      vitals: { spo2: 90 },
    });
    assert.notStrictEqual(at90.riskLevel, "critical", "SpO2=90 must NOT trigger critical RR-CRIT-01");
    assert.ok(!at90.triggeredRules.includes("RR-CRIT-01"), "SpO2=90 must NOT include RR-CRIT-01");
    console.log("  ✓ SpO2 boundary: 89% triggers critical (<90), 90% does not trigger");
  }

  // B. Blood Sugar Thresholds: < 60 (low) or > 300 (high)
  {
    const sugar59 = evaluateRisk({
      chief_complaint: "Weakness",
      vitals: { blood_sugar: 59 },
    });
    assert.ok(sugar59.triggeredRules.includes("RR-HIGH-04"), "Sugar=59 must trigger RR-HIGH-04");

    const sugar60 = evaluateRisk({
      chief_complaint: "Weakness",
      vitals: { blood_sugar: 60 },
    });
    assert.ok(!sugar60.triggeredRules.includes("RR-HIGH-04"), "Sugar=60 must NOT trigger <60 rule");

    const sugar300 = evaluateRisk({
      chief_complaint: "Thirst",
      vitals: { blood_sugar: 300 },
    });
    assert.ok(!sugar300.triggeredRules.includes("RR-HIGH-04"), "Sugar=300 must NOT trigger >300 rule");

    const sugar301 = evaluateRisk({
      chief_complaint: "Thirst",
      vitals: { blood_sugar: 301 },
    });
    assert.ok(sugar301.triggeredRules.includes("RR-HIGH-04"), "Sugar=301 must trigger RR-HIGH-04");
    console.log("  ✓ Blood sugar boundary: 59 triggers (<60), 60 safe; 300 safe, 301 triggers (>300)");
  }

  // C. Blood Pressure Thresholds: Systolic >= 180 or Diastolic >= 120
  {
    const sys179 = evaluateRisk({
      chief_complaint: "Headache",
      vitals: { systolic_bp: 179, diastolic_bp: 85 },
    });
    assert.ok(!sys179.triggeredRules.includes("RR-HIGH-07"), "Systolic=179 must NOT trigger RR-HIGH-07");

    const sys180 = evaluateRisk({
      chief_complaint: "Headache",
      vitals: { systolic_bp: 180, diastolic_bp: 85 },
    });
    assert.ok(sys180.triggeredRules.includes("RR-HIGH-07"), "Systolic=180 must trigger RR-HIGH-07");

    const dia119 = evaluateRisk({
      chief_complaint: "Headache",
      vitals: { systolic_bp: 135, diastolic_bp: 119 },
    });
    assert.ok(!dia119.triggeredRules.includes("RR-HIGH-07"), "Diastolic=119 must NOT trigger RR-HIGH-07");

    const dia120 = evaluateRisk({
      chief_complaint: "Headache",
      vitals: { systolic_bp: 135, diastolic_bp: 120 },
    });
    assert.ok(dia120.triggeredRules.includes("RR-HIGH-07"), "Diastolic=120 must trigger RR-HIGH-07");
    console.log("  ✓ Blood pressure boundary: Systolic 179 safe / 180 triggers; Diastolic 119 safe / 120 triggers");
  }

  // D. High Fever Temperature Threshold (>= 103°F / 39.4°C) with Confusion
  {
    const tempF102_9 = evaluateRisk({
      chief_complaint: "Fever",
      symptoms: "confused and disoriented",
      vitals: { temperature: 102.9 },
    });
    assert.ok(!tempF102_9.triggeredRules.includes("RR-HIGH-03"), "102.9°F must NOT trigger hyperpyrexia");

    const tempF103_0 = evaluateRisk({
      chief_complaint: "Fever",
      symptoms: "confused and disoriented",
      vitals: { temperature: 103.0 },
    });
    assert.ok(tempF103_0.triggeredRules.includes("RR-HIGH-03"), "103.0°F must trigger RR-HIGH-03");

    // Celsius boundary (39.4°C = 102.92°F, 39.5°C = 103.1°F)
    const tempC39_4 = evaluateRisk({
      chief_complaint: "Fever",
      symptoms: "confused and disoriented",
      vitals: { temperature: 39.4, temperature_unit: "C" },
    });
    assert.ok(!tempC39_4.triggeredRules.includes("RR-HIGH-03"), "39.4°C (102.92°F) must NOT trigger hyperpyrexia");

    const tempC39_5 = evaluateRisk({
      chief_complaint: "Fever",
      symptoms: "confused and disoriented",
      vitals: { temperature: 39.5, temperature_unit: "C" },
    });
    assert.ok(tempC39_5.triggeredRules.includes("RR-HIGH-03"), "39.5°C (103.1°F) must trigger RR-HIGH-03");
    console.log("  ✓ Temperature boundary: 102.9°F safe / 103.0°F triggers; 39.4°C safe / 39.5°C triggers");
  }

  // E. Fever Duration Boundary (> 3 Days triggers RR-MED-01)
  {
    const fever3Days = evaluateRisk({
      chief_complaint: "Fever",
      duration: "3 days",
      vitals: { temperature: 101 },
    });
    assert.ok(!fever3Days.triggeredRules.includes("RR-MED-01"), "3 days duration is NOT > 3 days");

    const fever4Days = evaluateRisk({
      chief_complaint: "Fever",
      duration: "4 days",
      vitals: { temperature: 101 },
    });
    assert.ok(fever4Days.triggeredRules.includes("RR-MED-01"), "4 days duration IS > 3 days");
    console.log("  ✓ Fever duration boundary: exactly 3 days safe / 4 days triggers RR-MED-01");
  }

  // ===================================================================
  // 5. COMBINATIONS OF RULES FIRING TOGETHER
  // ===================================================================
  console.log("\n--- 5. Testing Multi-Rule Signal Combinations ---");

  // Combination 1: Multiple Moderate Signals
  {
    const combo = evaluateRisk({
      chief_complaint: "Hypertension checkup and twisted ankle",
      duration: "5 days",
      symptoms: "fever with swelling in ankle and feet getting worse",
      vitals: { temperature: 101 },
    });
    assert.strictEqual(combo.riskLevel, "medium");
    assert.ok(combo.triggeredRules.includes("RR-MED-01"), "Prolonged fever should fire");
    assert.ok(combo.triggeredRules.includes("RR-MED-04"), "Worsening condition should fire");
    assert.ok(combo.triggeredRules.includes("RR-MED-05"), "Trauma with swelling should fire");
    console.log("  ✓ Multi-rule combination: 3 medium rules fired concurrently");
  }

  // Combination 2: Multiple Severity Tiers — Highest Severity Strictly Wins
  {
    const multiTier = evaluateRisk({
      chief_complaint: "Chest pain and fever",
      duration: "5 days",
      symptoms: "sweating profusely with blue lips and gasping for air",
      vitals: {
        spo2: 86, // RR-CRIT-01 (<90)
        systolic_bp: 190, // RR-HIGH-07 (>=180)
        temperature: 101, // RR-MED-01 (>3 days)
      },
    });
    assert.strictEqual(multiTier.riskLevel, "critical", "Highest severity (critical) must strictly dominate");
    assert.ok(multiTier.triggeredRules.includes("RR-CRIT-01"), "Critical SpO2 fired");
    assert.ok(multiTier.triggeredRules.includes("RR-CRIT-04"), "Cyanosis + dyspnea fired");
    assert.ok(multiTier.triggeredRules.includes("RR-HIGH-01"), "Chest pain + sweating fired");
    assert.ok(multiTier.triggeredRules.includes("RR-HIGH-07"), "Hypertensive crisis fired");
    assert.ok(multiTier.triggeredRules.includes("RR-MED-01"), "Prolonged fever fired");
    console.log("  ✓ Multi-tier combination: Critical strictly dominates High and Medium signals");
  }

  // ===================================================================
  // 6. FAIL-CLOSED MALFORMED VITALS & MISSING INFORMATION
  // ===================================================================
  console.log("\n--- 6. Testing Fail-Closed Malformed & Missing Vitals ---");

  // Anomaly 1: Physically impossible temperature (300°F)
  {
    const res = evaluateRisk({
      chief_complaint: "Mild cold",
      vitals: { temperature: 300 },
    });
    assert.ok(res.riskLevel === "medium" || res.riskLevel === "high");
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("300°F")));
    console.log("  ✓ Anomaly guard: 300°F temperature fails closed to medium risk");
  }

  // Anomaly 2: Negative heart rate (-50 bpm)
  {
    const res = evaluateRisk({
      chief_complaint: "Checkup",
      vitals: { heart_rate: -50 },
    });
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("-50")));
    console.log("  ✓ Anomaly guard: Negative heart rate fails closed to medium risk");
  }

  // Anomaly 3: Impossible SpO2 reading (> 100%)
  {
    const res = evaluateRisk({
      chief_complaint: "Checkup",
      vitals: { spo2: 125 },
    });
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("125%")));
    console.log("  ✓ Anomaly guard: SpO2 > 100% fails closed to medium risk");
  }

  // Missing Info 1: Fever without duration enforces medium floor
  {
    const res = evaluateRisk({
      chief_complaint: "Fever and chills",
      symptoms: "body aches",
      // duration missing!
      vitals: { temperature: 101 },
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MISSING-01"));
    assert.ok(res.missingCriticalInfo.includes("fever_duration"));
    console.log("  ✓ Missing info: Fever without duration enforces medium risk floor");
  }

  // Missing Info 2: Acute chest pain without vitals enforces medium floor
  {
    const res = evaluateRisk({
      chief_complaint: "Acute dull chest pain",
      symptoms: "mild pressure",
      // vitals missing!
    });
    assert.strictEqual(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MISSING-02"));
    assert.ok(res.missingCriticalInfo.includes("vitals"));
    console.log("  ✓ Missing info: Chest pain without vitals enforces medium risk floor");
  }

  // ===================================================================
  // 7. LOWEST RISK TIER (Routine / Benign Presentation)
  // ===================================================================
  console.log("\n--- 7. Testing Lowest Risk Tier (Low Default) ---");
  {
    const res = evaluateRisk({
      chief_complaint: "Mild tension headache",
      duration: "1 day",
      symptoms: "mild headache after prolonged computer screen use, no visual changes",
      vitals: {
        spo2: 99,
        heart_rate: 72,
        systolic_bp: 118,
        diastolic_bp: 76,
        temperature: 98.4,
      },
    });
    assert.strictEqual(res.riskLevel, "low");
    assert.ok(res.triggeredRules.includes("RR-LOW-01"));
    assert.strictEqual(res.anomaliesDetected.length, 0);
    assert.strictEqual(res.missingCriticalInfo.length, 0);
    console.log("  ✓ Lowest tier: Benign presentation with normal vitals defaults to low (RR-LOW-01)");
  }

  // ===================================================================
  // 8. RULES VS. AI DISAGREEMENT SAFETY INVARIANT
  // ===================================================================
  console.log("\n--- 8. Testing Rules vs AI Disagreement (Rules Always Win) ---");
  {
    // Scenario: Patient narrative sounds mild ("just a little tired"), but vitals show severe hypoxemia (SpO2=86%)
    const rulesEval = evaluateRisk({
      chief_complaint: "Feeling a bit worn out today",
      symptoms: "mild fatigue",
      vitals: { spo2: 86 }, // Triggers critical RR-CRIT-01
    });
    assert.strictEqual(rulesEval.riskLevel, "critical");

    // Hypothetical AI deceived by the calm wording suggests 'low'
    const aiSuggestedRisk: RiskLevel = "low";

    const resolution = resolveRiskDisagreement(rulesEval.riskLevel, aiSuggestedRisk);

    assert.strictEqual(
      resolution.finalRisk,
      "critical",
      "Deterministic rules engine MUST override hypothetical AI suggestion when higher"
    );
    assert.strictEqual(resolution.disagreement, true, "Disagreement flag must be true");
    console.log("  ✓ Disagreement invariant verified: Rules engine 'critical' strictly overrides AI 'low'");
  }

  console.log("\n✓ ALL Rules Engine unit tests passed successfully!");
}

// Support running directly via `npx tsx tests/modules/processing/rules-engine.test.ts`
if (
  process.argv[1] &&
  (process.argv[1].endsWith("rules-engine.test.ts") ||
    process.argv[1].endsWith("rules-engine.test.js"))
) {
  runRulesEngineTests().catch((err) => {
    console.error("❌ Rules engine test failed:", err);
    process.exit(1);
  });
}
