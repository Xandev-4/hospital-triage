/**
 * Deterministic Risk Rules Engine
 *
 * Implements Section 7 of docs/triage-assistant-core-design.md:
 * - Pure, deterministic clinical risk-tagging logic.
 * - Zero external dependencies (no Express, no Drizzle, no AI providers).
 * - Fails CLOSED on malformed/out-of-range vitals (never silently downgrades risk).
 * - Implements minimum risk floors for missing critical fields on acute presentations.
 * - No randomness, no Date.now(). Pure input -> output.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface VitalsInput {
  spo2?: number | string | null;
  heartRate?: number | string | null;
  heart_rate?: number | string | null;
  temperature?: number | string | null;
  temperatureUnit?: "F" | "C" | null;
  temperature_unit?: "F" | "C" | null;
  systolicBp?: number | string | null;
  systolic_bp?: number | string | null;
  diastolicBp?: number | string | null;
  diastolic_bp?: number | string | null;
  bloodSugar?: number | string | null;
  blood_sugar?: number | string | null;
  [key: string]: unknown;
}

export interface StructuredTriageInput {
  chiefComplaint?: string | null;
  chief_complaint?: string | null;
  duration?: string | null;
  symptoms?: string | null;
  vitals?: VitalsInput | null;
  isPregnant?: boolean | null;
  is_pregnant?: boolean | null;
  [key: string]: unknown;
}

export interface TriggeredRule {
  id: string;
  name: string;
  riskLevel: RiskLevel;
  reason: string;
  source: string;
}

export interface RuleEvaluationResult {
  riskLevel: RiskLevel;
  triggeredRules: string[];
  ruleDetails: TriggeredRule[];
  missingCriticalInfo: string[];
  anomaliesDetected: string[];
}

/**
 * Normalized vitals representation used internally by the rules engine.
 */
interface NormalizedVitals {
  spo2: number | null;
  heartRate: number | null;
  temperatureF: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  bloodSugar: number | null;
  rawPresent: boolean;
}

const SEVERITY_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Parses numeric value safely from number or string representation.
 */
function parseNumeric(val: unknown): number | null {
  if (typeof val === "number") {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === "string") {
    const cleaned = val.trim().replace(/[^0-9.-]/g, "");
    if (!cleaned) return null;
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parses temperature and normalizes to Fahrenheit for consistent threshold checks.
 */
function parseTemperatureToF(
  rawTemp: unknown,
  specifiedUnit?: "F" | "C" | null
): { tempF: number | null; isAnomaly: boolean; error?: string } {
  const num = parseNumeric(rawTemp);
  if (num === null) {
    return { tempF: null, isAnomaly: false };
  }

  const unit = specifiedUnit?.toUpperCase();

  // Unit explicitly Celsius, or value < 50 without unit (humanly impossible in F)
  if (unit === "C" || (!unit && num <= 50)) {
    // Sane biological Celsius range: 25°C to 46°C (77°F to 114.8°F)
    if (num < 25 || num > 46) {
      return {
        tempF: null,
        isAnomaly: true,
        error: `Physiologically impossible Celsius temperature reading: ${num}°C`,
      };
    }
    const converted = (num * 9) / 5 + 32;
    return { tempF: Math.round(converted * 10) / 10, isAnomaly: false };
  }

  // Fahrenheit
  // Sane biological Fahrenheit range: 80°F to 115°F
  if (num < 80 || num > 115) {
    return {
      tempF: null,
      isAnomaly: true,
      error: `Physiologically impossible Fahrenheit temperature reading: ${num}°F`,
    };
  }

  return { tempF: num, isAnomaly: false };
}

/**
 * Normalizes and validates vitals input, flagging any out-of-range anomalies.
 */
function normalizeAndValidateVitals(
  vitals: VitalsInput | null | undefined,
  anomalies: string[]
): NormalizedVitals {
  const result: NormalizedVitals = {
    spo2: null,
    heartRate: null,
    temperatureF: null,
    systolicBp: null,
    diastolicBp: null,
    bloodSugar: null,
    rawPresent: false,
  };

  if (!vitals || typeof vitals !== "object") {
    return result;
  }

  result.rawPresent = Object.entries(vitals).some(([_, v]) => {
    return v !== null && v !== undefined && v !== "";
  });

  // 1. SpO2 (0-100%)
  const rawSpo2 = vitals.spo2;
  const parsedSpo2 = parseNumeric(rawSpo2);
  if (parsedSpo2 !== null) {
    if (parsedSpo2 < 0 || parsedSpo2 > 100) {
      anomalies.push(`SpO2 reading out of range (0-100%): ${parsedSpo2}%`);
    } else {
      result.spo2 = parsedSpo2;
    }
  }

  // 2. Heart Rate (sane range: 20-300 bpm)
  const rawHr = vitals.heartRate ?? vitals.heart_rate;
  const parsedHr = parseNumeric(rawHr);
  if (parsedHr !== null) {
    if (parsedHr < 20 || parsedHr > 300) {
      anomalies.push(
        `Heart rate reading physiologically impossible (20-300 bpm): ${parsedHr} bpm`
      );
    } else {
      result.heartRate = parsedHr;
    }
  }

  // 3. Temperature
  const rawTemp = vitals.temperature;
  const rawUnit = (vitals.temperatureUnit ?? vitals.temperature_unit) as
    "F" | "C" | null | undefined;
  if (rawTemp !== null && rawTemp !== undefined) {
    const { tempF, isAnomaly, error } = parseTemperatureToF(rawTemp, rawUnit);
    if (isAnomaly && error) {
      anomalies.push(error);
    } else {
      result.temperatureF = tempF;
    }
  }

  // 4. Blood Pressure Systolic (sane range: 40-300 mmHg)
  const rawSys = vitals.systolicBp ?? vitals.systolic_bp;
  const parsedSys = parseNumeric(rawSys);
  if (parsedSys !== null) {
    if (parsedSys < 40 || parsedSys > 300) {
      anomalies.push(
        `Systolic BP physiologically impossible (40-300 mmHg): ${parsedSys} mmHg`
      );
    } else {
      result.systolicBp = parsedSys;
    }
  }

  // 5. Blood Pressure Diastolic (sane range: 20-200 mmHg)
  const rawDia = vitals.diastolicBp ?? vitals.diastolic_bp;
  const parsedDia = parseNumeric(rawDia);
  if (parsedDia !== null) {
    if (parsedDia < 20 || parsedDia > 200) {
      anomalies.push(
        `Diastolic BP physiologically impossible (20-200 mmHg): ${parsedDia} mmHg`
      );
    } else {
      result.diastolicBp = parsedDia;
    }
  }

  // 6. Blood Sugar (sane range: 10-1200 mg/dL)
  const rawBs = vitals.bloodSugar ?? vitals.blood_sugar;
  const parsedBs = parseNumeric(rawBs);
  if (parsedBs !== null) {
    if (parsedBs < 10 || parsedBs > 1200) {
      anomalies.push(
        `Blood sugar reading physiologically impossible (10-1200 mg/dL): ${parsedBs} mg/dL`
      );
    } else {
      result.bloodSugar = parsedBs;
    }
  }

  return result;
}

/**
 * Checks whether text content matches any of the provided regex patterns or keywords.
 */
function textMatches(
  combinedText: string,
  patterns: (RegExp | string)[]
): boolean {
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (combinedText.includes(pattern.toLowerCase())) {
        return true;
      }
    } else if (pattern.test(combinedText)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates duration string to check if it represents a duration exceeding 3 days.
 */
function isDurationGreaterThanThreeDays(durationText: string): boolean {
  const norm = durationText.toLowerCase();

  // Explicit patterns for > 3 days
  if (
    /([4-9]|\d{2,})\s*days?/.test(norm) ||
    /(\d+)\s*(weeks?|months?|years?)/.test(norm) ||
    norm.includes("week") ||
    norm.includes("month") ||
    norm.includes("> 3 days") ||
    norm.includes("more than 3 days") ||
    norm.includes("over 3 days") ||
    norm.includes("several days")
  ) {
    return true;
  }

  return false;
}

/**
 * Deterministic Clinical Risk Evaluator.
 *
 * Implements Section 7 of core-design.md:
 * Evaluates structured triage input against deterministic clinical safety rules.
 *
 * Fails closed on malformed vitals or missing critical information on acute presentations.
 */
export function evaluateRisk(
  input: StructuredTriageInput
): RuleEvaluationResult {
  const triggeredRules: TriggeredRule[] = [];
  const anomaliesDetected: string[] = [];
  const missingCriticalInfo: string[] = [];

  const chiefComplaint = (
    input.chiefComplaint ??
    input.chief_complaint ??
    ""
  ).trim();
  const symptoms = (input.symptoms ?? "").trim();
  const duration = (input.duration ?? "").trim();
  const isPregnant = Boolean(input.isPregnant ?? input.is_pregnant);

  const combinedText = `${chiefComplaint} ${symptoms}`.toLowerCase();

  // Normalize vitals & detect anomalies
  const vitals = normalizeAndValidateVitals(input.vitals, anomaliesDetected);

  // ============================================================================
  // 1. CRITICAL RULES (Section 7: _CRITICAL_)
  // ============================================================================

  // RR-CRIT-01: spo2 < 90
  if (vitals.spo2 !== null && vitals.spo2 < 90) {
    triggeredRules.push({
      id: "RR-CRIT-01",
      name: "Severe Hypoxemia",
      riskLevel: "critical",
      reason: `Pulse oximetry reading SpO2 is ${vitals.spo2}%, which is below the critical safety threshold (< 90%).`,
      source: "clinical reference threshold",
    });
  }

  // RR-CRIT-02: unconscious / unresponsive
  if (
    textMatches(combinedText, [
      /\bunconscious\b/,
      /\bunresponsive\b/,
      /\bpassed out\b/,
      /\bcollapse[d]?\b/,
      /\bloss of consciousness\b/,
      /\bcoma\b/,
      /\bsyncope\b/,
    ])
  ) {
    triggeredRules.push({
      id: "RR-CRIT-02",
      name: "Unresponsive / Altered Consciousness",
      riskLevel: "critical",
      reason:
        "Patient reported as unconscious, unresponsive, or experiencing collapse.",
      source: "clinical red-flag symptom",
    });
  }

  // RR-CRIT-03: active/uncontrolled bleeding
  if (
    textMatches(combinedText, [
      /\bactive bleeding\b/,
      /\buncontrolled bleeding\b/,
      /\bprofuse bleeding\b/,
      /\bheavy bleeding\b/,
      /\bhemorrhag(e|ing)\b/,
      /\bbleeding profusely\b/,
      /\bspurting blood\b/,
    ])
  ) {
    triggeredRules.push({
      id: "RR-CRIT-03",
      name: "Active / Uncontrolled Bleeding",
      riskLevel: "critical",
      reason: "Active or uncontrolled severe hemorrhage reported.",
      source: "clinical red-flag symptom",
    });
  }

  // RR-CRIT-04: severe difficulty breathing + blue lips/face (cyanosis)
  const hasSevereBreathing = textMatches(combinedText, [
    /\bsevere (difficulty breathing|breathlessness|shortness of breath|dyspnea)\b/,
    /\bgasping for air\b/,
    /\bstridor\b/,
    /\bcannot breathe\b/,
    /\bunable to breathe\b/,
  ]);

  const hasCyanosis = textMatches(combinedText, [
    /\bblue lips\b/,
    /\bbluish lips\b/,
    /\bblue face\b/,
    /\bbluish face\b/,
    /\bcyanosis\b/,
    /\bblue discoloration\b/,
    /\bturning blue\b/,
  ]);

  if (hasSevereBreathing && hasCyanosis) {
    triggeredRules.push({
      id: "RR-CRIT-04",
      name: "Respiratory Failure with Cyanosis",
      riskLevel: "critical",
      reason:
        "Severe breathing difficulty combined with peripheral/central cyanosis (blue lips or face).",
      source: "clinical red-flag symptom combination",
    });
  }

  // RR-CRIT-05: seizure (ongoing or just occurred)
  if (
    textMatches(combinedText, [
      /\bseizure\b/,
      /\bconvulsion[s]?\b/,
      /\bfitting\b/,
      /\bepileptic fit\b/,
      /\bstatus epilepticus\b/,
      /\bpost[- ]ictal\b/,
    ])
  ) {
    triggeredRules.push({
      id: "RR-CRIT-05",
      name: "Active or Recent Seizure",
      riskLevel: "critical",
      reason: "Ongoing or recently observed seizure/convulsion activity.",
      source: "clinical red-flag neurological event",
    });
  }

  // RR-CRIT-06: severe abdominal pain + pregnancy (maternal-specific)
  const isMaternal =
    isPregnant ||
    textMatches(combinedText, [
      /\bpregnant\b/,
      /\bpregnancy\b/,
      /\bgestat(ion|ional)\b/,
      /\btrimester\b/,
      /\bmaternal\b/,
    ]);

  const hasSevereAbdominalPain = textMatches(combinedText, [
    /\bsevere abdominal pain\b/,
    /\bsevere stomach pain\b/,
    /\bacute abdomen\b/,
    /\bsevere pelvic pain\b/,
    /\bintense abdominal pain\b/,
    /\bextreme abdominal pain\b/,
  ]);

  if (isMaternal && hasSevereAbdominalPain) {
    triggeredRules.push({
      id: "RR-CRIT-06",
      name: "Maternal Obstetric Emergency",
      riskLevel: "critical",
      reason:
        "Severe abdominal pain in a pregnant patient (potential ectopic rupture, placental abruption, or pre-eclampsia).",
      source: "maternal clinical protocol",
    });
  }

  // RR-CRIT-07: chest pain radiating to arm/jaw
  const hasChestPain = textMatches(combinedText, [
    /\bchest pain\b/,
    /\bangina\b/,
    /\bchest tightness\b/,
    /\bchest pressure\b/,
    /\bheaviness in chest\b/,
  ]);

  const hasRadiation = textMatches(combinedText, [
    /\bradiat(?:ing|es|ion|ed)?\s+(?:to|into|down)\s+(?:the\s+)?(?:left\s+|right\s+)?(?:arm|jaw|neck|shoulder|back)\b/,
    /\bpain\s+(?:spreads?|spreading|going)\s+(?:to|into|down)\s+(?:the\s+)?(?:left\s+|right\s+)?(?:arm|jaw|neck|shoulder|back)\b/,
    /\b(?:left\s+|right\s+)?(?:arm|jaw|neck|shoulder)\s+pain\b/,
  ]);

  if (hasChestPain && hasRadiation) {
    triggeredRules.push({
      id: "RR-CRIT-07",
      name: "Acute Coronary Syndrome with Radiation",
      riskLevel: "critical",
      reason:
        "Chest pain radiating to the arm, jaw, neck, or shoulder indicates possible myocardial infarction.",
      source: "cardiac clinical protocol",
    });
  }

  // ============================================================================
  // 2. HIGH RULES (Section 7: _HIGH_)
  // ============================================================================

  // RR-HIGH-01: chest pain + sweating (diaphoresis)
  const hasSweating = textMatches(combinedText, [
    /\bsweat(ing|s)?\b/,
    /\bdiaphoresis\b/,
    /\bcold sweat[s]?\b/,
    /\bprofuse perspiration\b/,
  ]);

  if (hasChestPain && hasSweating) {
    triggeredRules.push({
      id: "RR-HIGH-01",
      name: "Chest Pain with Diaphoresis",
      riskLevel: "high",
      reason:
        "Chest pain accompanied by sweating/diaphoresis is an acute cardiac red flag.",
      source: "cardiac clinical protocol",
    });
  }

  // RR-HIGH-02: severe breathlessness (without blue lips)
  if (hasSevereBreathing && !hasCyanosis) {
    triggeredRules.push({
      id: "RR-HIGH-02",
      name: "Severe Breathlessness",
      riskLevel: "high",
      reason:
        "Severe difficulty breathing or acute shortness of breath reported.",
      source: "respiratory clinical protocol",
    });
  }

  // RR-HIGH-03: high fever (>103°F/39.4°C) + confusion
  const hasHighFeverReading =
    vitals.temperatureF !== null && vitals.temperatureF >= 103;
  const mentionsHighFever = textMatches(combinedText, [
    /\bhigh fever\b/,
    /\bvery high fever\b/,
    /\bfever (over|above|>) 103\b/,
  ]);
  const hasHighFever = hasHighFeverReading || mentionsHighFever;

  const hasConfusion = textMatches(combinedText, [
    /\bconfusion\b/,
    /\bconfused\b/,
    /\bdelirium\b/,
    /\baltered mental\b/,
    /\bdisoriented\b/,
    /\bdisorientation\b/,
    /\bhallucinat(ing|ions)\b/,
  ]);

  if (hasHighFever && hasConfusion) {
    triggeredRules.push({
      id: "RR-HIGH-03",
      name: "Hyperpyrexia with Encephalopathy / Confusion",
      riskLevel: "high",
      reason:
        "High fever (>103°F/39.4°C) combined with confusion or altered mental status (potential central nervous system infection/sepsis).",
      source: "infectious disease safety protocol",
    });
  }

  // RR-HIGH-04: reported blood sugar reading very low (<60) or very high (>300)
  if (
    vitals.bloodSugar !== null &&
    (vitals.bloodSugar < 60 || vitals.bloodSugar > 300)
  ) {
    const direction =
      vitals.bloodSugar < 60 ? "critically low" : "critically high";
    triggeredRules.push({
      id: "RR-HIGH-04",
      name: "Severe Blood Glucose Dysregulation",
      riskLevel: "high",
      reason: `Blood glucose reading is ${direction} (${vitals.bloodSugar} mg/dL, normal fasting: 70-99 mg/dL).`,
      source: "endocrine clinical threshold",
    });
  }

  // RR-HIGH-05: vomiting blood (hematemesis) or hemoptysis
  if (
    textMatches(combinedText, [
      /\bvomit(ing)? blood\b/,
      /\bhematemesis\b/,
      /\bblood in vomit\b/,
      /\bcoffee[- ]ground emesis\b/,
      /\bcough(ing)? (up )?blood\b/,
      /\bhemoptysis\b/,
    ])
  ) {
    triggeredRules.push({
      id: "RR-HIGH-05",
      name: "Gastrointestinal or Pulmonary Hemorrhage",
      riskLevel: "high",
      reason:
        "Vomiting or coughing blood indicates active upper GI bleed or severe pulmonary hemorrhage.",
      source: "gastrointestinal / pulmonary red flag",
    });
  }

  // RR-HIGH-06: sudden vision loss or slurred speech (stroke red flag)
  if (
    textMatches(combinedText, [
      /\bsudden vision loss\b/,
      /\bloss of vision\b/,
      /\bslurred speech\b/,
      /\bfacial droop\b/,
      /\bone-sided weakness\b/,
      /\barm weakness\b/,
      /\bhemiplegia\b/,
      /\bhemiparesis\b/,
      /\baphasia\b/,
    ])
  ) {
    triggeredRules.push({
      id: "RR-HIGH-06",
      name: "Acute Neurological Deficit (Stroke Red Flag)",
      riskLevel: "high",
      reason:
        "Sudden onset vision loss, slurred speech, or focal motor weakness represents acute stroke until ruled out.",
      source: "neurological emergency protocol (FAST)",
    });
  }

  // RR-HIGH-07: hypertensive emergency (systolic >= 180 or diastolic >= 120)
  if (
    (vitals.systolicBp !== null && vitals.systolicBp >= 180) ||
    (vitals.diastolicBp !== null && vitals.diastolicBp >= 120)
  ) {
    const bpDisplay = `${vitals.systolicBp ?? "?"}/${vitals.diastolicBp ?? "?"} mmHg`;
    triggeredRules.push({
      id: "RR-HIGH-07",
      name: "Hypertensive Crisis",
      riskLevel: "high",
      reason: `Blood pressure reading (${bpDisplay}) meets hypertensive crisis threshold (systolic >= 180 or diastolic >= 120).`,
      source: "cardiovascular emergency protocol",
    });
  }

  // ============================================================================
  // 3. MEDIUM RULES (Section 7: _MEDIUM_)
  // ============================================================================

  const hasFeverMention =
    (vitals.temperatureF !== null && vitals.temperatureF >= 100.4) ||
    textMatches(combinedText, [
      /\bfever\b/,
      /\bpyrexia\b/,
      /\bchills\b/,
      /\bhigh temp\b/,
    ]);

  // RR-MED-01: fever > 3 days
  if (hasFeverMention && duration && isDurationGreaterThanThreeDays(duration)) {
    triggeredRules.push({
      id: "RR-MED-01",
      name: "Prolonged Fever (>3 Days)",
      riskLevel: "medium",
      reason: `Fever persisting beyond 3 days (reported duration: "${duration}") requires formal clinical investigation.`,
      source: "infectious disease protocol",
    });
  }

  // RR-MED-02: persistent vomiting (no blood)
  const hasVomiting = textMatches(combinedText, [
    /\bvomit(ing|s)?\b/,
    /\bnausea and vomiting\b/,
    /\bthrowing up\b/,
    /\bemesis\b/,
  ]);
  const hasPersistent = textMatches(combinedText, [
    /\bpersistent\b/,
    /\bcontinuous\b/,
    /\bcannot keep (food|water|fluids) down\b/,
    /\bmultiple times\b/,
    /\bfrequent\b/,
    /\ball day\b/,
  ]);

  if (
    hasVomiting &&
    hasPersistent &&
    !textMatches(combinedText, [/\bblood\b/])
  ) {
    triggeredRules.push({
      id: "RR-MED-02",
      name: "Persistent Intractable Vomiting",
      riskLevel: "medium",
      reason:
        "Persistent vomiting without blood carries dehydration and electrolyte derangement risk.",
      source: "gastrointestinal protocol",
    });
  }

  // RR-MED-03: moderate breathlessness on exertion only
  const hasExertionalBreathlessness = textMatches(combinedText, [
    /\bbreathlessness on exertion\b/,
    /\bshort of breath (walking|climbing|stairs|exertion|running)\b/,
    /\bdyspnea on exertion\b/,
    /\btired after walking\b/,
  ]);

  if (hasExertionalBreathlessness && !hasSevereBreathing) {
    triggeredRules.push({
      id: "RR-MED-03",
      name: "Moderate Exertional Dyspnea",
      riskLevel: "medium",
      reason:
        "Breathlessness triggered on physical exertion requires non-urgent cardiorespiratory evaluation.",
      source: "cardiorespiratory protocol",
    });
  }

  // RR-MED-04: worsening chronic condition symptom (e.g. increased swelling in diabetes/hypertension)
  const mentionsChronic = textMatches(combinedText, [
    /\bhypertension\b/,
    /\bhigh bp\b/,
    /\bdiabetes\b/,
    /\bdiabetic\b/,
    /\bchronic\b/,
  ]);
  const mentionsWorsening = textMatches(combinedText, [
    /\bworsen(ing|ed)?\b/,
    /\bincreased swelling\b/,
    /\bswelling in (legs|feet|ankles)\b/,
    /\bedema\b/,
    /\bgetting worse\b/,
  ]);

  if (mentionsChronic && mentionsWorsening) {
    triggeredRules.push({
      id: "RR-MED-04",
      name: "Worsening Chronic Condition",
      riskLevel: "medium",
      reason:
        "Patient reports exacerbation or worsening edema/symptoms of pre-existing chronic illness.",
      source: "chronic disease monitoring protocol",
    });
  }

  // RR-MED-05: injury with visible swelling/deformity, patient can still move the area
  const mentionsInjury = textMatches(combinedText, [
    /\binjury\b/,
    /\bfall(en)?\b/,
    /\bhurt\b/,
    /\btrauma\b/,
    /\bsprain\b/,
    /\btwisted\b/,
  ]);
  const mentionsSwelling = textMatches(combinedText, [
    /\bswelling\b/,
    /\bswollen\b/,
    /\bdeformity\b/,
    /\bbruis(ing|e)\b/,
  ]);

  if (mentionsInjury && mentionsSwelling) {
    triggeredRules.push({
      id: "RR-MED-05",
      name: "Musculoskeletal Trauma with Swelling",
      riskLevel: "medium",
      reason:
        "Injury with visible swelling or deformity requiring clinical exam and radiography.",
      source: "orthopedic triage protocol",
    });
  }

  // ============================================================================
  // 4. FAIL-CLOSED SAFETY GUARDS: ANOMALIES & MISSING CRITICAL FIELDS
  // ============================================================================

  // RR-ANOMALY-01: Malformed or physiologically impossible vital reading
  if (anomaliesDetected.length > 0) {
    triggeredRules.push({
      id: "RR-ANOMALY-01",
      name: "Physiologically Impossible Vital Sign Anomaly",
      riskLevel: "medium",
      reason: `Malformed or out-of-range vital reading detected (${anomaliesDetected.join("; ")}). Fails closed to require manual clinical review.`,
      source: "safety fail-closed anomaly guard",
    });
  }

  // RR-MISSING-01: Fever reported without duration
  // If fever is reported as a primary complaint/symptom but duration is completely absent,
  // do not silently assume short duration (low risk).
  if (hasFeverMention && !duration) {
    missingCriticalInfo.push("fever_duration");
    triggeredRules.push({
      id: "RR-MISSING-01",
      name: "Unspecified Fever Duration",
      riskLevel: "medium",
      reason:
        "Fever reported without duration. Cannot rule out prolonged fever (>3 days); enforces medium risk floor.",
      source: "safety fail-closed missing data guard",
    });
  }

  // RR-MISSING-02: Acute cardiopulmonary symptom without vitals
  // If acute chest pain or breathlessness is reported but vitals are entirely missing,
  // fail closed to at least medium risk.
  const hasAcuteCardiopulmonary =
    hasChestPain ||
    hasSevereBreathing ||
    textMatches(combinedText, [/\bpalpitations\b/, /\bracing heart\b/]);

  if (hasAcuteCardiopulmonary && (!input.vitals || !vitals.rawPresent)) {
    missingCriticalInfo.push("vitals");
    triggeredRules.push({
      id: "RR-MISSING-02",
      name: "Acute Cardiopulmonary Presentation Without Vitals",
      riskLevel: "medium",
      reason:
        "Acute chest or respiratory complaint reported without measured vital signs (SpO2, BP, pulse). Enforces medium risk floor.",
      source: "safety fail-closed missing data guard",
    });
  }

  // ============================================================================
  // 5. LOW RISK DEFAULT
  // ============================================================================

  // If no critical, high, or medium rules fired, default to low.
  if (triggeredRules.length === 0) {
    triggeredRules.push({
      id: "RR-LOW-01",
      name: "Mild / Low-Risk Presentation",
      riskLevel: "low",
      reason:
        "No acute red-flag symptoms, vital sign abnormalities, or missing critical data triggers matched.",
      source: "routine triage baseline",
    });
  }

  // ============================================================================
  // 6. RESOLVE FINAL RISK LEVEL
  // Highest severity among all triggered rules wins.
  // ============================================================================
  let highestRisk: RiskLevel = "low";
  for (const rule of triggeredRules) {
    if (SEVERITY_ORDER[rule.riskLevel] > SEVERITY_ORDER[highestRisk]) {
      highestRisk = rule.riskLevel;
    }
  }

  return {
    riskLevel: highestRisk,
    triggeredRules: triggeredRules.map((r) => r.id),
    ruleDetails: triggeredRules,
    missingCriticalInfo,
    anomaliesDetected,
  };
}
