import assert from "node:assert/strict";
import { evaluateRisk } from "../../../src/modules/processing/rules-engine.js";

export async function runRulesEngineTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Pure Deterministic Rules Engine         ");
  console.log("=======================================================");

  // 1. CRITICAL Rules
  console.log("\n--- Testing CRITICAL Rules ---");

  // RR-CRIT-01: spo2 < 90
  {
    const res = evaluateRisk({
      chief_complaint: "cough",
      vitals: { spo2: 88, heart_rate: 90 },
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-01"));
    console.log("✓ RR-CRIT-01 passed: SpO2 < 90 triggers critical risk");
  }

  // RR-CRIT-02: unconscious / unresponsive
  {
    const res = evaluateRisk({
      chief_complaint: "Found patient unconscious on the floor",
      symptoms: "unresponsive to verbal commands",
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-02"));
    console.log(
      "✓ RR-CRIT-02 passed: Unconscious/unresponsive triggers critical risk"
    );
  }

  // RR-CRIT-03: active/uncontrolled bleeding
  {
    const res = evaluateRisk({
      chief_complaint: "Laceration to leg",
      symptoms: "uncontrolled bleeding and spurting blood",
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-03"));
    console.log(
      "✓ RR-CRIT-03 passed: Uncontrolled bleeding triggers critical risk"
    );
  }

  // RR-CRIT-04: severe difficulty breathing + blue lips/face
  {
    const res = evaluateRisk({
      chief_complaint: "severe difficulty breathing",
      symptoms: "blue lips and gasping for air",
      vitals: { spo2: 92 },
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-04"));
    console.log(
      "✓ RR-CRIT-04 passed: Severe dyspnea + cyanosis triggers critical risk"
    );
  }

  // RR-CRIT-05: seizure
  {
    const res = evaluateRisk({
      chief_complaint: "Had an epileptic fit 10 minutes ago",
      symptoms: "active seizure and convulsions",
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-05"));
    console.log(
      "✓ RR-CRIT-05 passed: Seizure/convulsions triggers critical risk"
    );
  }

  // RR-CRIT-06: severe abdominal pain + pregnancy
  {
    const res = evaluateRisk({
      chief_complaint: "severe abdominal pain",
      symptoms: "sharp pelvic cramps",
      isPregnant: true,
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-06"));
    console.log(
      "✓ RR-CRIT-06 passed: Severe abdominal pain in pregnancy triggers critical risk"
    );
  }

  // RR-CRIT-07: chest pain radiating to arm/jaw
  {
    const res = evaluateRisk({
      chief_complaint: "Chest pain",
      symptoms: "radiating to jaw and left arm",
      vitals: { spo2: 98, systolic_bp: 130, diastolic_bp: 85 },
    });
    assert.equal(res.riskLevel, "critical");
    assert.ok(res.triggeredRules.includes("RR-CRIT-07"));
    console.log(
      "✓ RR-CRIT-07 passed: Chest pain radiating to arm/jaw triggers critical risk"
    );
  }

  // 2. HIGH Rules
  console.log("\n--- Testing HIGH Rules ---");

  // RR-HIGH-01: chest pain + sweating
  {
    const res = evaluateRisk({
      chief_complaint: "Chest pain",
      symptoms: "pressure with cold sweats and diaphoresis",
      vitals: { spo2: 98, systolic_bp: 135, diastolic_bp: 85 },
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-01"));
    console.log(
      "✓ RR-HIGH-01 passed: Chest pain + sweating triggers high risk"
    );
  }

  // RR-HIGH-02: severe breathlessness (without cyanosis)
  {
    const res = evaluateRisk({
      chief_complaint: "severe breathlessness",
      symptoms: "unable to breathe properly",
      vitals: { spo2: 95 },
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-02"));
    console.log(
      "✓ RR-HIGH-02 passed: Severe breathlessness without cyanosis triggers high risk"
    );
  }

  // RR-HIGH-03: high fever (>103°F) + confusion
  {
    const res = evaluateRisk({
      chief_complaint: "fever",
      duration: "2 days",
      symptoms: "patient is confused and disoriented",
      vitals: { temperature: 104 },
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-03"));
    console.log(
      "✓ RR-HIGH-03 passed: High fever (>103°F) + confusion triggers high risk"
    );
  }

  // RR-HIGH-04: blood sugar dysregulation (<60 or >300)
  {
    const lowSugar = evaluateRisk({
      chief_complaint: "shakiness and dizziness",
      vitals: { blood_sugar: 45 },
    });
    assert.equal(lowSugar.riskLevel, "high");
    assert.ok(lowSugar.triggeredRules.includes("RR-HIGH-04"));

    const highSugar = evaluateRisk({
      chief_complaint: "excessive thirst",
      vitals: { blood_sugar: 380 },
    });
    assert.equal(highSugar.riskLevel, "high");
    assert.ok(highSugar.triggeredRules.includes("RR-HIGH-04"));
    console.log(
      "✓ RR-HIGH-04 passed: Blood sugar <60 and >300 trigger high risk"
    );
  }

  // RR-HIGH-05: vomiting blood
  {
    const res = evaluateRisk({
      chief_complaint: "vomiting blood",
      symptoms: "dark coffee ground emesis",
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-05"));
    console.log("✓ RR-HIGH-05 passed: Hematemesis triggers high risk");
  }

  // RR-HIGH-06: slurred speech / sudden vision loss
  {
    const res = evaluateRisk({
      chief_complaint: "sudden slurred speech",
      symptoms: "facial droop noticed by family",
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-06"));
    console.log(
      "✓ RR-HIGH-06 passed: Stroke red flag symptoms trigger high risk"
    );
  }

  // RR-HIGH-07: hypertensive emergency (systolic >= 180 or diastolic >= 120)
  {
    const res = evaluateRisk({
      chief_complaint: "headache",
      duration: "1 day",
      vitals: { systolic_bp: 195, diastolic_bp: 110 },
    });
    assert.equal(res.riskLevel, "high");
    assert.ok(res.triggeredRules.includes("RR-HIGH-07"));
    console.log("✓ RR-HIGH-07 passed: Systolic >= 180 triggers high risk");
  }

  // 3. MEDIUM Rules
  console.log("\n--- Testing MEDIUM Rules ---");

  // RR-MED-01: fever > 3 days
  {
    const res = evaluateRisk({
      chief_complaint: "fever",
      duration: "5 days",
      symptoms: "mild fever and chills",
      vitals: { temperature: 101 },
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-01"));
    console.log("✓ RR-MED-01 passed: Fever > 3 days triggers medium risk");
  }

  // RR-MED-02: persistent vomiting (no blood)
  {
    const res = evaluateRisk({
      chief_complaint: "stomach bug",
      symptoms: "persistent vomiting multiple times, cannot keep fluids down",
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-02"));
    console.log("✓ RR-MED-02 passed: Persistent vomiting triggers medium risk");
  }

  // RR-MED-03: breathlessness on exertion only
  {
    const res = evaluateRisk({
      chief_complaint: "breathlessness on exertion",
      symptoms: "short of breath walking up stairs",
      vitals: { spo2: 96 },
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-03"));
    console.log("✓ RR-MED-03 passed: Exertional dyspnea triggers medium risk");
  }

  // RR-MED-04: worsening chronic condition
  {
    const res = evaluateRisk({
      chief_complaint: "hypertension follow-up",
      symptoms: "increased swelling in legs and feet worsening",
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-04"));
    console.log(
      "✓ RR-MED-04 passed: Worsening chronic condition triggers medium risk"
    );
  }

  // RR-MED-05: injury with swelling
  {
    const res = evaluateRisk({
      chief_complaint: "ankle sprain",
      symptoms:
        "twisted ankle with swelling and bruising, can still bear weight",
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MED-05"));
    console.log(
      "✓ RR-MED-05 passed: Trauma with swelling triggers medium risk"
    );
  }

  // 4. Fail-Closed Anomaly & Missing Info Safety Tests
  console.log("\n--- Testing Fail-Closed Anomalies & Missing Info ---");

  // Anomaly: 300°F temperature from bad OCR
  {
    const res = evaluateRisk({
      chief_complaint: "mild cold",
      vitals: { temperature: 300 },
    });
    assert.ok(res.riskLevel === "medium" || res.riskLevel === "high");
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("300°F")));
    console.log(
      "✓ Anomaly passed: Impossible temperature (300°F) fails closed to medium risk"
    );
  }

  // Anomaly: negative heart rate
  {
    const res = evaluateRisk({
      chief_complaint: "checkup",
      vitals: { heart_rate: -60 },
    });
    assert.ok(res.riskLevel === "medium" || res.riskLevel === "high");
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("-60")));
    console.log(
      "✓ Anomaly passed: Negative heart rate fails closed to medium risk"
    );
  }

  // Anomaly: SpO2 > 100
  {
    const res = evaluateRisk({
      chief_complaint: "cough",
      vitals: { spo2: 120 },
    });
    assert.ok(res.triggeredRules.includes("RR-ANOMALY-01"));
    assert.ok(res.anomaliesDetected.some((a) => a.includes("120%")));
    console.log("✓ Anomaly passed: SpO2 > 100 fails closed to medium risk");
  }

  // Missing info: Fever without duration
  {
    const res = evaluateRisk({
      chief_complaint: "fever",
      symptoms: "chills and mild body ache",
      // duration missing!
      vitals: { temperature: 101 },
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MISSING-01"));
    assert.ok(res.missingCriticalInfo.includes("fever_duration"));
    console.log(
      "✓ Missing info passed: Fever without duration enforces medium floor"
    );
  }

  // Missing info: Chest pain without vitals
  {
    const res = evaluateRisk({
      chief_complaint: "dull chest pain",
      symptoms: "mild pressure",
      // vitals missing!
    });
    assert.equal(res.riskLevel, "medium");
    assert.ok(res.triggeredRules.includes("RR-MISSING-02"));
    assert.ok(res.missingCriticalInfo.includes("vitals"));
    console.log(
      "✓ Missing info passed: Chest pain without vitals enforces medium floor"
    );
  }

  // 5. LOW Risk Default
  console.log("\n--- Testing LOW Risk Default ---");
  {
    const res = evaluateRisk({
      chief_complaint: "mild headache",
      duration: "1 day",
      symptoms: "mild tension headache after screen time, no red flags",
      vitals: {
        spo2: 99,
        heart_rate: 72,
        systolic_bp: 118,
        diastolic_bp: 78,
        temperature: 98.6,
      },
    });
    assert.equal(res.riskLevel, "low");
    assert.ok(res.triggeredRules.includes("RR-LOW-01"));
    assert.equal(res.anomaliesDetected.length, 0);
    assert.equal(res.missingCriticalInfo.length, 0);
    console.log(
      "✓ Low risk passed: Benign presentation with normal vitals defaults to low"
    );
  }

  // 6. Strict Determinism Check
  console.log("\n--- Testing Determinism ---");
  {
    const input = {
      chief_complaint: "Chest pain",
      symptoms: "radiating to arm",
      vitals: { spo2: 89, systolic_bp: 185 },
    };
    const firstRun = JSON.stringify(evaluateRisk(input));
    for (let i = 0; i < 50; i++) {
      const run = JSON.stringify(evaluateRisk(input));
      assert.equal(run, firstRun, `Run ${i} was not deterministic!`);
    }
    console.log(
      "✓ Determinism passed: 50 consecutive runs produced identical JSON output"
    );
  }

  console.log("\n✓ ALL Rules Engine unit tests passed!");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("rules-engine.test.ts") ||
    process.argv[1].endsWith("rules-engine.test.js"))
) {
  runRulesEngineTests().catch((err) => {
    console.error("Rules engine test failed:", err);
    process.exit(1);
  });
}
