/**
 * AI & Multimodal Structured Extraction Wrapper
 *
 * Implements Section 8 of docs/triage-assistant-core-design.md:
 * - Pure extraction wrapper isolated from database and HTTP controllers.
 * - Extracts structured fields: chiefComplaint, duration, symptoms, vitals, missingInfo, confidence.
 * - Enforces real timeout to prevent hanging requests.
 * - Validates AI output structure strictly (never passes malformed data or garbage types downstream).
 * - Fails cleanly with structured error/low-confidence shapes (powers Demo Scenario D manual_fallback).
 * - PII-safe: never logs raw patient prompt/response text in plaintext logs.
 * - STUB MODE by default: per spec.md §13 (Open Item: LLM/STT provider choice), allows complete
 *   end-to-end pipeline verification without burning API credits or requiring external connectivity.
 */

import { validateDuration } from "./rules-engine.js";

export interface ExtractedVitals {
  spo2?: number | null;
  heartRate?: number | null;
  temperature?: number | null;
  temperatureUnit?: "F" | "C" | null;
  systolicBp?: number | null;
  diastolicBp?: number | null;
  bloodSugar?: number | null;
  [key: string]: unknown;
}

export interface ExtractedStructuredData {
  chiefComplaint: string;
  duration: string;
  symptoms: string;
  vitals: ExtractedVitals;
  missingInfo: string[];
  suggestedDepartment: string;
  aiSuggestedRisk?: "low" | "medium" | "high" | "critical";
}

export interface RawExtractionInput {
  caseId?: string;
  chiefComplaint?: string | null;
  duration?: string | null;
  symptoms?: string | null;
  vitals?: Record<string, unknown> | null;
  uploadedFiles?: Array<{
    modality: "voice" | "image_ocr";
    filePath: string;
    mimeType: string;
  }>;
  // Test & Simulation hooks (for Demo Scenario D & automated unit testing)
  simulateFailure?: boolean;
  simulateLowConfidence?: boolean;
  simulateTimeout?: boolean;
  simulateMalformedOutput?: boolean;
}

export interface ExtractionOptions {
  timeoutMs?: number; // default: 5000ms
  confidenceThreshold?: number; // default: 0.7
  provider?: "stub" | "gemini" | "openai";
}

export type ExtractionResult =
  | {
      success: true;
      confidence: number; // 0.0 - 1.0 (>= confidenceThreshold)
      data: ExtractedStructuredData;
      provider: string;
      durationMs: number;
    }
  | {
      success: false;
      confidence: number; // < confidenceThreshold or 0
      reason:
        | "low_confidence"
        | "ai_extraction_timeout"
        | "ai_malformed_output"
        | "ocr_unreadable"
        | "provider_error";
      data?: Partial<ExtractedStructuredData>;
      error?: string;
      provider: string;
      durationMs: number;
    };

// ==============================================================================
// Section 8: Missing-Info Symptom Checklists (core-design.md §8)
// ==============================================================================
const SYMPTOM_CHECKLISTS: Record<string, string[]> = {
  fever: [
    "duration",
    "peak_temperature",
    "associated_symptoms",
    "recent_travel",
    "medication_taken",
  ],
  breathing_difficulty: [
    "duration",
    "spo2_reading",
    "exertion_vs_rest",
    "chest_pain",
    "respiratory_history",
  ],
  abdominal_pain: [
    "duration",
    "location",
    "severity",
    "associated_symptoms",
    "pregnancy_status",
  ],
  chest_pain: [
    "duration",
    "character",
    "radiation",
    "associated_symptoms",
    "trigger",
  ],
  headache: [
    "duration",
    "severity",
    "onset_speed",
    "associated_symptoms",
    "prior_history",
  ],
  injury_trauma: [
    "mechanism",
    "affected_area",
    "swelling_deformity",
    "weight_bearing",
    "time_since_injury",
  ],
  skin_rash_wound: [
    "duration",
    "location",
    "spreading_status",
    "associated_symptoms",
  ],
  maternal_checkin: [
    "gestational_week",
    "swelling",
    "headache",
    "vision_changes",
    "fetal_movement",
    "bleeding_discharge",
  ],
  chronic_diabetes_checkin: [
    "blood_sugar_reading",
    "medication_adherence",
    "new_symptoms",
    "diet_appetite",
  ],
  chronic_hypertension_checkin: [
    "bp_reading",
    "medication_adherence",
    "headache_dizziness",
    "peripheral_swelling",
  ],
  general_fatigue_weakness: [
    "duration",
    "sleep_pattern",
    "appetite_changes",
    "associated_symptoms",
    "daily_activity_impact",
  ],
};

/**
 * Detects missing information based on Section 8 checklist comparison.
 */
function detectMissingInfo(
  complaint: string,
  duration: string,
  symptoms: string,
  vitals: ExtractedVitals
): string[] {
  const text = `${complaint} ${symptoms}`.toLowerCase();
  const missing: string[] = [];

  // 1. General Baseline Checklist (core-design.md Section 8)
  const durationCheck = validateDuration(duration);
  if (durationCheck.status === "absent") {
    missing.push("duration");
  }

  const hasAnyVitals =
    vitals &&
    (vitals.spo2 !== null && vitals.spo2 !== undefined ||
      vitals.heartRate !== null && vitals.heartRate !== undefined ||
      vitals.temperature !== null && vitals.temperature !== undefined ||
      vitals.systolicBp !== null && vitals.systolicBp !== undefined ||
      vitals.diastolicBp !== null && vitals.diastolicBp !== undefined ||
      vitals.bloodSugar !== null && vitals.bloodSugar !== undefined);

  if (!hasAnyVitals) {
    missing.push("vitals");
  }

  if (!symptoms || symptoms.trim().length === 0) {
    missing.push("symptoms");
  }

  // 2. Complaint-specific checklists per core-design.md Section 8
  let category: string | null = null;
  if (/fever|pyrexia|chills|high temp/.test(text)) category = "fever";
  else if (/breath|dyspnea|suffocat|gasp/.test(text))
    category = "breathing_difficulty";
  else if (/chest pain|angina|chest pressure/.test(text))
    category = "chest_pain";
  else if (/abdomin|stomach|pelvic|belly/.test(text))
    category = "abdominal_pain";
  else if (/headache|migraine/.test(text)) category = "headache";
  else if (/fall|injury|trauma|sprain|twist|fracture/.test(text))
    category = "injury_trauma";
  else if (/rash|wound|itch|skin|lesion/.test(text))
    category = "skin_rash_wound";
  else if (/pregnant|maternal|trimester/.test(text))
    category = "maternal_checkin";
  else if (/diabetes|blood sugar|glucose/.test(text))
    category = "chronic_diabetes_checkin";
  else if (/hypertension|high bp|blood pressure/.test(text))
    category = "chronic_hypertension_checkin";
  else if (/fatigue|weakness|tired/.test(text))
    category = "general_fatigue_weakness";

  if (!category) {
    return Array.from(new Set(missing));
  }

  const checklist = SYMPTOM_CHECKLISTS[category];
  if (checklist) {
    for (const item of checklist) {
      switch (item) {
        case "peak_temperature":
          if (
            (vitals.temperature === null || vitals.temperature === undefined) &&
            !missing.includes("peak_temperature")
          ) {
            missing.push("peak_temperature");
          }
          break;
        case "spo2_reading":
          if (
            (vitals.spo2 === null || vitals.spo2 === undefined) &&
            !missing.includes("spo2_reading")
          ) {
            missing.push("spo2_reading");
          }
          break;
        case "blood_sugar_reading":
          if (
            (vitals.bloodSugar === null || vitals.bloodSugar === undefined) &&
            !missing.includes("blood_sugar_reading")
          ) {
            missing.push("blood_sugar_reading");
          }
          break;
        case "bp_reading":
          if (
            (vitals.systolicBp === null ||
              vitals.systolicBp === undefined ||
              vitals.diastolicBp === null ||
              vitals.diastolicBp === undefined) &&
            !missing.includes("bp_reading")
          ) {
            missing.push("bp_reading");
          }
          break;
        case "radiation":
          if (
            !/radiat|spread|arm|jaw|neck|shoulder|back/.test(text) &&
            category === "chest_pain"
          ) {
            if (!missing.includes("radiation_pattern")) {
              missing.push("radiation_pattern");
            }
            if (!missing.includes("radiation")) {
              missing.push("radiation");
            }
          }
          break;
        default:
          break;
      }
    }
  }

  return Array.from(new Set(missing));
}

/**
 * Suggests clinical department based on chief complaint and symptom keywords.
 */
function suggestDepartment(complaint: string, symptoms: string): string {
  const text = `${complaint} ${symptoms}`.toLowerCase();

  if (
    /unconscious|unresponsive|collapse|active bleeding|profuse bleeding/.test(
      text
    )
  ) {
    return "Emergency Medicine";
  }
  if (/chest pain|angina|palpitat|heart|cardiac|myocardial/.test(text)) {
    return "Cardiology";
  }
  if (/breath|dyspnea|wheez|cough|asthma|pneumonia|lung|cyanosis/.test(text)) {
    return "Pulmonology";
  }
  if (/pregnant|pregnancy|gestat|trimester|fetal|pelvic|labor/.test(text)) {
    return "Obstetrics & Gynecology";
  }
  if (/fracture|sprain|twist|bone|joint|trauma|fall|dislocat/.test(text)) {
    return "Orthopedics";
  }
  if (/seizure|stroke|slurred speech|facial droop|paralysis/.test(text)) {
    return "Neurology";
  }
  if (/stomach|abdomin|vomit|diarrhea|nausea|gastric|bowel/.test(text)) {
    return "Gastroenterology";
  }
  if (/rash|wound|burn|skin|itching|dermat/.test(text)) {
    return "Dermatology";
  }
  if (/headache|migraine/.test(text) && !/fever|pyrexia/.test(text)) {
    return "Neurology";
  }

  return "General Medicine";
}

/**
 * Validates and sanitizes raw AI extraction output.
 * Ensures no unvalidated or structurally broken types reach downstream services.
 */
export function validateAndSanitizeOutput(raw: unknown): {
  valid: boolean;
  data?: ExtractedStructuredData;
  errors: string[];
} {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      errors: ["Extraction output must be a non-null object"],
    };
  }

  const record = raw as Record<string, unknown>;

  // 1. Text fields
  const chiefComplaint =
    typeof record.chiefComplaint === "string"
      ? record.chiefComplaint.trim()
      : typeof record.chief_complaint === "string"
        ? record.chief_complaint.trim()
        : "";

  const duration =
    typeof record.duration === "string" ? record.duration.trim() : "";

  const symptoms =
    typeof record.symptoms === "string" ? record.symptoms.trim() : "";

  if (chiefComplaint.length > 1000) {
    errors.push("chiefComplaint exceeds maximum allowed length (1000)");
  }
  if (duration.length > 100) {
    errors.push("duration exceeds maximum allowed length (100)");
  }
  if (symptoms.length > 5000) {
    errors.push("symptoms exceeds maximum allowed length (5000)");
  }

  // 2. Vitals validation & coercion
  const vitalsRecord = (record.vitals ?? {}) as Record<string, unknown>;
  if (typeof vitalsRecord !== "object" || vitalsRecord === null) {
    errors.push("vitals must be an object");
    return { valid: false, errors };
  }

  const sanitizedVitals: ExtractedVitals = {
    spo2: null,
    heartRate: null,
    temperature: null,
    temperatureUnit: null,
    systolicBp: null,
    diastolicBp: null,
    bloodSugar: null,
  };

  const validateNumericVital = (field: string, val: unknown): number | null => {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val === "number") {
      if (Number.isFinite(val)) return val;
      errors.push(`Vital ${field} must be a finite number`);
      return null;
    }
    if (typeof val === "string") {
      const parsed = parseFloat(val.trim());
      if (Number.isFinite(parsed)) return parsed;
      errors.push(`Vital ${field} received non-numeric string: "${val}"`);
      return null;
    }
    errors.push(`Vital ${field} has invalid type: ${typeof val}`);
    return null;
  };

  sanitizedVitals.spo2 = validateNumericVital("spo2", vitalsRecord.spo2);
  sanitizedVitals.heartRate = validateNumericVital(
    "heartRate",
    vitalsRecord.heartRate ?? vitalsRecord.heart_rate
  );
  sanitizedVitals.temperature = validateNumericVital(
    "temperature",
    vitalsRecord.temperature
  );
  sanitizedVitals.systolicBp = validateNumericVital(
    "systolicBp",
    vitalsRecord.systolicBp ?? vitalsRecord.systolic_bp
  );
  sanitizedVitals.diastolicBp = validateNumericVital(
    "diastolicBp",
    vitalsRecord.diastolicBp ?? vitalsRecord.diastolic_bp
  );
  sanitizedVitals.bloodSugar = validateNumericVital(
    "bloodSugar",
    vitalsRecord.bloodSugar ?? vitalsRecord.blood_sugar
  );

  const rawUnit = vitalsRecord.temperatureUnit ?? vitalsRecord.temperature_unit;
  if (typeof rawUnit === "string") {
    const u = rawUnit.toUpperCase();
    if (u === "F" || u === "C") {
      sanitizedVitals.temperatureUnit = u;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 3. Missing info list
  const missingInfo = Array.isArray(record.missingInfo)
    ? record.missingInfo.filter((i): i is string => typeof i === "string")
    : detectMissingInfo(chiefComplaint, duration, symptoms, sanitizedVitals);

  // 4. Department suggestion
  const suggestedDepartment =
    typeof record.suggestedDepartment === "string" &&
    record.suggestedDepartment.trim()
      ? record.suggestedDepartment.trim()
      : suggestDepartment(chiefComplaint, symptoms);

  // 5. AI suggested risk (if present)
  let aiSuggestedRisk: ExtractedStructuredData["aiSuggestedRisk"] = undefined;
  if (
    typeof record.aiSuggestedRisk === "string" &&
    ["low", "medium", "high", "critical"].includes(record.aiSuggestedRisk)
  ) {
    aiSuggestedRisk =
      record.aiSuggestedRisk as ExtractedStructuredData["aiSuggestedRisk"];
  }

  return {
    valid: true,
    data: {
      chiefComplaint,
      duration,
      symptoms,
      vitals: sanitizedVitals,
      missingInfo,
      suggestedDepartment,
      aiSuggestedRisk,
    },
    errors: [],
  };
}

/**
 * PII-Safe Logging Helper
 * Strictly prevents leaking patient names, phone numbers, or free-text descriptions into logs.
 */
function logSanitizedExtractionEvent(info: {
  caseId?: string;
  provider: string;
  durationMs: number;
  confidence: number;
  success: boolean;
  reason?: string;
}): void {
  if (process.env.DEBUG_AI === "true") {
    console.log(
      `[AIExtraction] caseId=${info.caseId ?? "unknown"} provider=${info.provider} duration=${info.durationMs}ms success=${info.success} confidence=${info.confidence}${info.reason ? ` reason=${info.reason}` : ""}`
    );
  }
}

/**
 * Stub Provider Implementation
 * Simulates intelligent extraction for testing and local development without API costs.
 */
async function executeStubExtraction(
  input: RawExtractionInput,
  abortSignal: AbortSignal
): Promise<ExtractionResult> {
  const startTime = Date.now();

  // Test simulation: simulated timeout
  if (input.simulateTimeout) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 8000);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (abortSignal.aborted) {
      throw new Error("aborted");
    }
  }

  // Test simulation: explicit failure or forced provider failure string
  if (
    input.simulateFailure ||
    input.chiefComplaint?.includes("FORCE_AI_FAILURE") ||
    input.chiefComplaint?.includes("[SIMULATE_FAILURE]")
  ) {
    const elapsed = Date.now() - startTime;
    return {
      success: false,
      confidence: 0,
      reason: "provider_error",
      error: "Simulated upstream AI provider error",
      provider: "stub",
      durationMs: elapsed,
    };
  }

  // Test simulation: low confidence / unparseable or bad input (Demo Scenario D)
  if (
    input.simulateLowConfidence ||
    input.chiefComplaint?.includes("BAD_INPUT") ||
    input.chiefComplaint?.includes("UNPARSEABLE_INPUT") ||
    input.chiefComplaint?.includes("[SIMULATE_LOW_CONFIDENCE]") ||
    input.symptoms?.includes("UNPARSEABLE_INPUT")
  ) {
    const elapsed = Date.now() - startTime;
    return {
      success: false,
      confidence: 0.42,
      reason: "low_confidence",
      error:
        "OCR confidence below safety threshold (handwritten/blurry document)",
      data: {
        chiefComplaint:
          input.chiefComplaint ?? "unclear complaint",
        duration: input.duration ?? "unknown",
        symptoms: input.symptoms ?? "illegible handwriting",
        vitals: {},
        missingInfo: ["chief_complaint", "vitals"],
        suggestedDepartment: "General Medicine",
      },
      provider: "stub",
      durationMs: elapsed,
    };
  }

  // Test simulation: malformed output
  if (input.simulateMalformedOutput) {
    const elapsed = Date.now() - startTime;
    const malformed = {
      chiefComplaint: "Valid text",
      duration: "1 day",
      symptoms: "cough",
      vitals: {
        heartRate: "invalid_not_a_number", // Malformed!
      },
    };
    const validation = validateAndSanitizeOutput(malformed);
    return {
      success: false,
      confidence: 0.1,
      reason: "ai_malformed_output",
      error: validation.errors.join("; "),
      provider: "stub",
      durationMs: elapsed,
    };
  }

  // Normal successful extraction
  const chiefComplaint = (
    input.chiefComplaint ??
    ""
  ).trim();
  const symptoms = (input.symptoms ?? "").trim();
  const duration = (input.duration ?? "").trim();

  // Extract vitals safely if provided
  const inputVitals = input.vitals ?? {};
  const rawData = {
    chiefComplaint: chiefComplaint || "General medical inquiry",
    duration: duration,
    symptoms: symptoms || chiefComplaint,
    vitals: inputVitals,
    suggestedDepartment: suggestDepartment(chiefComplaint, symptoms),
  };

  const validation = validateAndSanitizeOutput(rawData);
  const elapsed = Date.now() - startTime;

  if (!validation.valid || !validation.data) {
    return {
      success: false,
      confidence: 0.2,
      reason: "ai_malformed_output",
      error: validation.errors.join("; "),
      provider: "stub",
      durationMs: elapsed,
    };
  }

  return {
    success: true,
    confidence: 0.94,
    data: validation.data,
    provider: "stub",
    durationMs: elapsed,
  };
}

/**
 * Main AI Extraction Entrypoint
 *
 * Wraps AI/OCR provider execution with:
 * 1. Real timeout enforcement
 * 2. Strict output validation (never passes unvalidated types downstream)
 * 3. Distinct failure / low-confidence response shapes (for manual_fallback routing)
 * 4. PII-safe logging
 */
export async function extractStructuredData(
  rawInput: RawExtractionInput,
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const confidenceThreshold = options.confidenceThreshold ?? 0.7;
  const startTime = Date.now();

  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<ExtractionResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      const elapsed = Date.now() - startTime;
      resolve({
        success: false,
        confidence: 0,
        reason: "ai_extraction_timeout",
        error: `AI extraction exceeded timeout of ${timeoutMs}ms`,
        provider: options.provider ?? "stub",
        durationMs: elapsed,
      });
    }, timeoutMs);
  });

  try {
    const executionPromise = (async (): Promise<ExtractionResult> => {
      // NOTE: When a real provider (e.g. Gemini 1.5 Flash) is integrated,
      // branch here based on options.provider || process.env.AI_PROVIDER.
      // For now, execute the robust stub provider.
      return executeStubExtraction(rawInput, controller.signal);
    })();

    const result = await Promise.race([executionPromise, timeoutPromise]);

    // Check confidence threshold
    if (result.success && result.confidence < confidenceThreshold) {
      const lowConfidenceResult: ExtractionResult = {
        success: false,
        confidence: result.confidence,
        reason: "low_confidence",
        error: `Extraction confidence (${result.confidence}) fell below required threshold (${confidenceThreshold})`,
        data: result.data,
        provider: result.provider,
        durationMs: result.durationMs,
      };

      logSanitizedExtractionEvent({
        caseId: rawInput.caseId,
        provider: lowConfidenceResult.provider,
        durationMs: lowConfidenceResult.durationMs,
        confidence: lowConfidenceResult.confidence,
        success: false,
        reason: lowConfidenceResult.reason,
      });

      return lowConfidenceResult;
    }

    logSanitizedExtractionEvent({
      caseId: rawInput.caseId,
      provider: result.provider,
      durationMs: result.durationMs,
      confidence: result.confidence,
      success: result.success,
      reason: result.success ? undefined : result.reason,
    });

    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const isAbort = controller.signal.aborted;

    const failureResult: ExtractionResult = {
      success: false,
      confidence: 0,
      reason: isAbort ? "ai_extraction_timeout" : "provider_error",
      error: err instanceof Error ? err.message : String(err),
      provider: options.provider ?? "stub",
      durationMs: elapsed,
    };

    logSanitizedExtractionEvent({
      caseId: rawInput.caseId,
      provider: failureResult.provider,
      durationMs: failureResult.durationMs,
      confidence: failureResult.confidence,
      success: false,
      reason: failureResult.reason,
    });

    return failureResult;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
