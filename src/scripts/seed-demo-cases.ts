/**
 * Dedicated Demo Cases Seeder (V1 Scenarios A, B, C, D)
 *
 * Distinct from account-seed (seed.ts):
 * - seed.ts seeds permanent staff accounts (run once).
 * - seed-demo-cases.ts seeds synthetic demo cases for practice and live presentations (run repeatedly).
 *
 * Fully Re-runnable & Idempotent:
 * - Detects and cleans up existing demo data before re-seeding.
 * - Prints target database host (without credentials) at startup for environment verification.
 * - Enforces production safety guard (requires --force if NODE_ENV=production).
 * - Uses synthetic, non-identifiable patient data (555-01xx fictitious numbers, clean synthetic names).
 * - Avoids raw debug tags like '[DEMO]' in clinical text so doctor UI renders polished and realistic.
 */

import "dotenv/config";
import crypto from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { client, db } from "../shared/config/db.js";
import {
  patients,
  users,
  consent,
  triageCases,
  caseReportVersions,
  auditLog,
  type RiskLevel,
} from "../shared/config/schema.js";
import { hashPassword } from "../modules/auth/auth.service.js";

// ==============================================================================
// 1. Safety & Environment Verification
// ==============================================================================

function getDatabaseHost(): string {
  try {
    const raw = process.env.DATABASE_URL || "";
    if (!raw) return "UNKNOWN (DATABASE_URL not configured)";
    const url = new URL(raw);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "UNKNOWN (Invalid DATABASE_URL)";
  }
}

function generateSecurePassword(): string {
  const randomStr = crypto.randomBytes(12).toString("base64url");
  return `${randomStr}!9Aa`;
}

// ==============================================================================
// 2. Demo Scenario Definitions
// ==============================================================================

interface DemoCaseDef {
  key: "A" | "B" | "C" | "D";
  title: string;
  patient: {
    name: string;
    email: string;
    phone: string;
  };
  case: {
    mode: "self" | "assisted";
    caseType: "walk_in";
    status: "queued" | "manual_fallback";
    chiefComplaint: string;
    duration: string | null;
    symptoms: string | null;
    vitals: Record<string, any> | null;
    riskLevel: RiskLevel | null;
    aiRulesDisagreement: boolean;
  };
  report?: {
    suggestedDepartment: string;
    missingInfo: string[];
    riskLevel: RiskLevel;
    triageSummary: string;
    disagreement: {
      present: boolean;
      aiSuggested: RiskLevel | null;
      rulesResult: RiskLevel;
      note: string | null;
    };
    triggeredRules: string[];
    ruleDetails: Array<{
      id: string;
      name: string;
      riskLevel: string;
      reason: string;
      source: string;
    }>;
  };
  auditHistory: Array<{
    eventType:
      | "consent_given"
      | "intake_submitted"
      | "ai_report_generated"
      | "status_changed";
    metadata: Record<string, any>;
  }>;
}

const DEMO_CASES: DemoCaseDef[] = [
  // ---------------------------------------------------------------------------
  // Scenario A: Normal Clean Case (Low Risk, Neurology)
  // ---------------------------------------------------------------------------
  {
    key: "A",
    title: "Scenario A: Normal Clean Intake (Low Risk)",
    patient: {
      name: "Demo Patient A (Sarah Jenkins)",
      email: "demo.patient.a@hospital-demo.internal",
      phone: "+1-555-0101",
    },
    case: {
      mode: "self",
      caseType: "walk_in",
      status: "queued",
      chiefComplaint: "Mild tension headache across forehead",
      duration: "1 day",
      symptoms:
        "Dull aching band-like pressure across temples and forehead. Relieved by resting in a quiet, dark room. No nausea, vomiting, photophobia, or visual aura.",
      vitals: {
        heartRate: 72,
        spo2: 99,
        systolicBp: 118,
        diastolicBp: 76,
        temperature: 98.4,
      },
      riskLevel: "low",
      aiRulesDisagreement: false,
    },
    report: {
      suggestedDepartment: "Neurology",
      missingInfo: [],
      riskLevel: "low",
      triageSummary:
        "Adult patient presenting with episodic tension-type headache for 1 day. Neurological red flags absent. All physiological vital signs strictly within normal limits. Routine clinical priority.",
      disagreement: {
        present: false,
        aiSuggested: null,
        rulesResult: "low",
        note: null,
      },
      triggeredRules: ["RR-LOW-01"],
      ruleDetails: [
        {
          id: "RR-LOW-01",
          name: "Routine Clinical Presentation",
          riskLevel: "low",
          reason:
            "No high or critical red flags detected. Vital signs are biologically stable.",
          source: "standard clinical practice",
        },
      ],
    },
    auditHistory: [
      {
        eventType: "consent_given",
        metadata: { mode: "self", policy_version: "2026.1" },
      },
      {
        eventType: "intake_submitted",
        metadata: {
          mode: "self",
          case_type: "walk_in",
          inputs: ["typed_text"],
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "submitted", to: "processing" },
      },
      {
        eventType: "ai_report_generated",
        metadata: {
          provider: "gemini",
          confidence: 0.95,
          risk_level: "low",
          suggested_department: "Neurology",
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "processing", to: "queued" },
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Scenario B: Missing Information (Medium Risk Safety Floor)
  // ---------------------------------------------------------------------------
  {
    key: "B",
    title: "Scenario B: Missing Information Checklist (Medium Risk Floor)",
    patient: {
      name: "Demo Patient B (Robert Chen)",
      email: "demo.patient.b@hospital-demo.internal",
      phone: "+1-555-0102",
    },
    case: {
      mode: "assisted",
      caseType: "walk_in",
      status: "queued",
      chiefComplaint: "High fever and persistent chills",
      duration: null, // Intentionally omitted
      symptoms:
        "Shivering, severe chills, fatigue, and generalized body aches. Patient did not have a thermometer at home and does not recall exact onset day.",
      vitals: null, // Intentionally omitted
      riskLevel: "medium",
      aiRulesDisagreement: false,
    },
    report: {
      suggestedDepartment: "Internal Medicine",
      missingInfo: ["duration", "vitals", "peak_temperature", "fever_duration"],
      riskLevel: "medium",
      triageSummary:
        "Patient reports unmeasured high fever with prominent rigors. Duration and baseline vital signs are absent. Deterministic safety floor enforces medium priority until bedside vitals and onset history are obtained.",
      disagreement: {
        present: false,
        aiSuggested: null,
        rulesResult: "medium",
        note: null,
      },
      triggeredRules: ["RR-MISSING-01"],
      ruleDetails: [
        {
          id: "RR-MISSING-01",
          name: "Incomplete Fever Assessment (Safety Floor)",
          riskLevel: "medium",
          reason:
            "Fever reported without documented duration or temperature reading enforces a minimum safety risk level of medium.",
          source: "safety floor protocol",
        },
      ],
    },
    auditHistory: [
      {
        eventType: "consent_given",
        metadata: { mode: "assisted", policy_version: "2026.1" },
      },
      {
        eventType: "intake_submitted",
        metadata: {
          mode: "assisted",
          case_type: "walk_in",
          inputs: ["typed_text"],
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "submitted", to: "processing" },
      },
      {
        eventType: "ai_report_generated",
        metadata: {
          provider: "gemini",
          confidence: 0.88,
          risk_level: "medium",
          missing_info_count: 4,
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "processing", to: "queued" },
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Scenario C: AI / Rules Disagreement (Rules Win -> Critical Risk)
  // ---------------------------------------------------------------------------
  {
    key: "C",
    title: "Scenario C: AI/Rules Disagreement (Rules Override to Critical)",
    patient: {
      name: "Demo Patient C (Elena Rostova)",
      email: "demo.patient.c@hospital-demo.internal",
      phone: "+1-555-0103",
    },
    case: {
      mode: "self",
      caseType: "walk_in",
      status: "queued",
      chiefComplaint: "Feeling slightly weak, maybe just a little tired today",
      duration: "1 day",
      symptoms:
        "Mild dry cough and slight lightheadedness upon standing up. Patient feels unusually winded walking up a single flight of stairs.",
      vitals: {
        spo2: 87, // Critical hypoxemia (<90%)
        heartRate: 138, // Severe tachycardia
        systolicBp: 104,
        diastolicBp: 68,
        temperature: 99.1,
      },
      riskLevel: "critical",
      aiRulesDisagreement: true,
    },
    report: {
      suggestedDepartment: "Pulmonology / Emergency Medicine",
      missingInfo: [],
      riskLevel: "critical",
      triageSummary:
        "CRITICAL SAFETY OVERRIDE: While narrative presents mild fatigue, objective vitals reveal severe hypoxemia (SpO2 87%) with significant sinus tachycardia (HR 138 bpm). Clinical deterministic safety engine RR-CRIT-01 strictly supersedes preliminary reading.",
      disagreement: {
        present: true,
        aiSuggested: "low",
        rulesResult: "critical",
        note: "rules result applies",
      },
      triggeredRules: ["RR-CRIT-01"],
      ruleDetails: [
        {
          id: "RR-CRIT-01",
          name: "Severe Hypoxemia",
          riskLevel: "critical",
          reason:
            "Pulse oximetry reading SpO2 is 87%, which is below the critical safety threshold (< 90%).",
          source: "clinical reference threshold",
        },
      ],
    },
    auditHistory: [
      {
        eventType: "consent_given",
        metadata: { mode: "self", policy_version: "2026.1" },
      },
      {
        eventType: "intake_submitted",
        metadata: {
          mode: "self",
          case_type: "walk_in",
          inputs: ["typed_text"],
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "submitted", to: "processing" },
      },
      {
        eventType: "ai_report_generated",
        metadata: {
          provider: "gemini",
          ai_suggested_risk: "low",
          final_rules_risk: "critical",
          disagreement: true,
          override_rule: "RR-CRIT-01",
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "processing", to: "queued" },
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Scenario D: Processing Failure / Fallback Case (manual_fallback Routing)
  // ---------------------------------------------------------------------------
  {
    key: "D",
    title: "Scenario D: Unreadable Document / Fallback (manual_fallback)",
    patient: {
      name: "Demo Patient D (Marcus Vance)",
      email: "demo.patient.d@hospital-demo.internal",
      phone: "+1-555-0104",
    },
    case: {
      mode: "assisted",
      caseType: "walk_in",
      status: "manual_fallback",
      chiefComplaint:
        "Uploaded handwritten clinical intake slip — handwriting obscured by ink smudging and low scan contrast",
      duration: null,
      symptoms: null,
      vitals: null,
      riskLevel: null,
      aiRulesDisagreement: false,
    },
    auditHistory: [
      {
        eventType: "consent_given",
        metadata: { mode: "assisted", policy_version: "2026.1" },
      },
      {
        eventType: "intake_submitted",
        metadata: {
          mode: "assisted",
          case_type: "walk_in",
          inputs: ["image_ocr"],
        },
      },
      {
        eventType: "status_changed",
        metadata: { from: "submitted", to: "processing" },
      },
      {
        eventType: "ai_report_generated",
        metadata: {
          success: false,
          reason: "ocr_unreadable",
          fallback_category: "bad_input",
          confidence: 0.38,
          error:
            "Handwriting recognition confidence score below threshold (0.38 < 0.70)",
          is_bug: false,
        },
      },
      {
        eventType: "status_changed",
        metadata: {
          from: "processing",
          to: "manual_fallback",
          reason: "ocr_unreadable",
          fallback_category: "bad_input",
        },
      },
    ],
  },
];

// ==============================================================================
// 3. Helper: Ensure Core Staff User Exists (Doctor / Receptionist)
// ==============================================================================

async function ensureDefaultStaff(): Promise<{
  doctorUserId: string;
  receptionistUserId: string;
}> {
  // Check if Dr. Aisha exists
  const [existingDoc] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "dr.aisha.sharma@hospital.org"))
    .limit(1);

  let doctorUserId = existingDoc?.id;
  if (!doctorUserId) {
    const passwordHash = await hashPassword("DoctorPassword123!");
    const [newDoc] = await db
      .insert(users)
      .values({
        name: "Dr. Aisha Sharma",
        email: "dr.aisha.sharma@hospital.org",
        role: "doctor",
        passwordHash,
      })
      .returning({ id: users.id });
    if (!newDoc) throw new Error("Failed to insert doctor account");
    doctorUserId = newDoc.id;
    console.log(
      "   ✓ Created core doctor account: dr.aisha.sharma@hospital.org"
    );
  }

  // Check if Receptionist Priya exists
  const [existingRec] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "reception.priya@hospital.org"))
    .limit(1);

  let receptionistUserId = existingRec?.id;
  if (!receptionistUserId) {
    const passwordHash = await hashPassword("ReceptionPassword123!");
    const [newRec] = await db
      .insert(users)
      .values({
        name: "Priya Nair",
        email: "reception.priya@hospital.org",
        role: "receptionist",
        passwordHash,
      })
      .returning({ id: users.id });
    if (!newRec) throw new Error("Failed to insert receptionist account");
    receptionistUserId = newRec.id;
    console.log(
      "   ✓ Created core receptionist account: reception.priya@hospital.org"
    );
  }

  return { doctorUserId, receptionistUserId };
}

// ==============================================================================
// 4. Main Seed Execution
// ==============================================================================

async function seedDemoCases() {
  const hasForce = process.argv.includes("--force");
  const dbHost = getDatabaseHost();

  console.log("=================================================");
  console.log("   🏥 SEED DEMO CASES (V1 Scenarios A, B, C, D)  ");
  console.log("=================================================");
  console.log(`🌐 Target Database Host : ${dbHost}`);
  console.log(
    `⚙️  Environment Mode     : ${process.env.NODE_ENV || "development"}`
  );

  // Safety check 1: Production guard
  if (process.env.NODE_ENV === "production" && !hasForce) {
    console.error(
      "\n❌ [SAFETY GUARD] NODE_ENV is set to 'production'. Aborting demo case seed."
    );
    console.error(
      "   To bypass this safety check intentionally, pass --force."
    );
    process.exit(1);
  }

  // 1. Ensure core staff accounts exist
  const { doctorUserId, receptionistUserId } = await ensureDefaultStaff();

  // 2. Idempotently find and clean up existing demo records
  console.log("\n🔍 Checking for existing demo cases...");
  const existingDemoPatients = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      or(
        like(patients.name, "Demo Patient%"),
        like(patients.phoneNumber, "+1-555-01%")
      )
    );

  if (existingDemoPatients.length > 0) {
    const patientIds = existingDemoPatients.map((p) => p.id);

    // Find all cases associated with these patients
    const existingCases = await db
      .select({ id: triageCases.id })
      .from(triageCases)
      .where(inArray(triageCases.patientId, patientIds));

    const caseIds = existingCases.map((c) => c.id);

    if (caseIds.length > 0) {
      // Delete child records first
      await db.delete(auditLog).where(inArray(auditLog.caseId, caseIds));
      await db
        .delete(caseReportVersions)
        .where(inArray(caseReportVersions.caseId, caseIds));
      await db.delete(triageCases).where(inArray(triageCases.id, caseIds));
    }

    // Delete consents and users associated with demo patients
    await db.delete(consent).where(inArray(consent.patientId, patientIds));
    await db.delete(users).where(inArray(users.patientId, patientIds));
    await db.delete(patients).where(inArray(patients.id, patientIds));

    console.log(
      `   🧹 Cleaned up ${caseIds.length} existing demo case(s) and ${patientIds.length} patient record(s).`
    );
  } else {
    console.log("   ✓ No previous demo cases found. Ready to seed fresh set.");
  }

  // 3. Seed the four canonical demo cases
  console.log("\n🌱 Seeding 4 canonical demo scenarios...");
  const seededSummary: Array<{
    Scenario: string;
    Patient: string;
    Status: string;
    Risk: string;
    Disagreement: string;
    CaseId: string;
  }> = [];

  for (const def of DEMO_CASES) {
    // A. Create synthetic patient record
    const [patientRecord] = await db
      .insert(patients)
      .values({
        name: def.patient.name,
        phoneNumber: def.patient.phone,
      })
      .returning({ id: patients.id });
    if (!patientRecord)
      throw new Error(`Failed to create patient: ${def.patient.name}`);

    // B. Create patient user account (for self-service cases)
    const passwordHash = await hashPassword(generateSecurePassword());
    const [patientUser] = await db
      .insert(users)
      .values({
        name: def.patient.name,
        email: def.patient.email,
        role: "patient",
        passwordHash,
        patientId: patientRecord.id,
      })
      .returning({ id: users.id });
    if (!patientUser)
      throw new Error(`Failed to create user for: ${def.patient.email}`);

    // Creator user depends on case mode
    const creatorUserId =
      def.case.mode === "assisted" ? receptionistUserId : patientUser.id;

    // C. Create consent record
    const [consentRecord] = await db
      .insert(consent)
      .values({
        patientId: patientRecord.id,
        givenBy: def.case.mode === "assisted" ? "staff" : "self",
        staffId: def.case.mode === "assisted" ? receptionistUserId : null,
        policyVersion: "2026.1",
      })
      .returning({ id: consent.id });
    if (!consentRecord)
      throw new Error(`Failed to create consent for: ${def.patient.name}`);

    // D. Create triage case record
    const [caseRecord] = await db
      .insert(triageCases)
      .values({
        patientId: patientRecord.id,
        createdBy: creatorUserId,
        consentId: consentRecord.id,
        mode: def.case.mode,
        caseType: def.case.caseType,
        status: def.case.status,
        chiefComplaint: def.case.chiefComplaint,
        duration: def.case.duration,
        symptoms: def.case.symptoms,
        vitals: def.case.vitals,
        riskLevel: def.case.riskLevel,
        aiRulesDisagreement: def.case.aiRulesDisagreement,
      })
      .returning({ id: triageCases.id });
    if (!caseRecord)
      throw new Error(`Failed to create case for: ${def.patient.name}`);

    // E. Create version 1 report if case has a structured report (Scenarios A, B, C)
    if (def.report) {
      await db.insert(caseReportVersions).values({
        caseId: caseRecord.id,
        versionNumber: 1,
        source: "ai",
        content: {
          chief_complaint: {
            value: def.case.chiefComplaint,
            source: "ai",
          },
          duration: {
            value: def.case.duration,
            source: "ai",
          },
          symptoms: {
            value: def.case.symptoms,
            source: "ai",
          },
          vitals: {
            value: def.case.vitals,
            source: "ai",
          },
          missing_info: def.report.missingInfo,
          suggested_department: def.report.suggestedDepartment,
          contributing_inputs: {
            typed_text: true,
            image_ocr: false,
            voice_stt: false,
            failed_inputs: [],
          },
          risk_level: def.report.riskLevel,
          triage_summary: def.report.triageSummary,
          ai_rules_disagreement: def.report.disagreement,
          triggered_rules: def.report.triggeredRules,
          rule_details: def.report.ruleDetails,
        },
        editedBy: null,
      });
    }

    // F. Create audit log history
    for (const auditDef of def.auditHistory) {
      await db.insert(auditLog).values({
        caseId: caseRecord.id,
        actorId: creatorUserId,
        eventType: auditDef.eventType,
        metadata: auditDef.metadata,
      });
    }

    seededSummary.push({
      Scenario: `Scenario ${def.key}`,
      Patient: def.patient.name,
      Status: def.case.status,
      Risk: def.case.riskLevel ?? "(none)",
      Disagreement: def.case.aiRulesDisagreement ? "YES ⚠️" : "No",
      CaseId: caseRecord.id,
    });
  }

  console.log("\n✅ Successfully seeded 4 demo cases!");
  console.table(seededSummary);
  console.log(
    "\n💡 Clinical Queue Ordering in Doctor View (Critical -> High -> Medium -> Low):"
  );
  console.log(
    "   1. Scenario C [Elena Rostova]  : CRITICAL (SpO2 87%, AI Disagreement flagged)"
  );
  console.log(
    "   2. Scenario B [Robert Chen]    : MEDIUM   (Fever missing duration/vitals safety floor)"
  );
  console.log(
    "   3. Scenario A [Sarah Jenkins]  : LOW      (Normal tension headache, routine queued)"
  );
  console.log(
    "   4. Scenario D [Marcus Vance]   : FALLBACK (Manual fallback queue, unreadable slip)"
  );
  console.log("\nReady for live rehearsal and presentation!\n");
}

seedDemoCases()
  .catch((err) => {
    console.error("❌ Seed demo cases failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await client.end();
  });
