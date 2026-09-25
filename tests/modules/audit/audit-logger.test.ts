import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import {
  auditLog,
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";
import {
  AUDIT_EVENT_TYPES,
  logAuditEvent,
  type AuditEventType,
} from "../../../src/modules/audit/audit-logger.js";

export async function runAuditLoggerTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: audit-logger.ts (Shared Logger Layer)  ");
  console.log("=======================================================");

  const passwordHash = await bcrypt.hash("testpass123", 10);
  const createdUserIds: string[] = [];
  const createdPatientIds: string[] = [];
  const createdConsentIds: string[] = [];
  const createdCaseIds: string[] = [];

  try {
    // 1. Verify 10 enum event types
    console.log("  → Test 1: Verify 10 canonical audit event types");
    assert.equal(AUDIT_EVENT_TYPES.length, 10, "Must define exactly 10 enum event types");
    assert.deepEqual(
      [...AUDIT_EVENT_TYPES].sort(),
      [
        "ai_report_generated",
        "assigned",
        "closed",
        "consent_given",
        "intake_submitted",
        "patient_created",
        "patient_search",
        "report_edited",
        "risk_overridden",
        "status_changed",
      ].sort()
    );
    console.log("    ✓ All 10 enum event types verified");

    // Setup test user, patient, consent, case
    const [testUser] = await db
      .insert(users)
      .values({
        name: "Audit Logger Tester",
        email: `audit_logger_${Date.now()}@example.com`,
        passwordHash,
        role: "doctor",
      })
      .returning();
    createdUserIds.push(testUser.id);

    const [testPatient] = await db
      .insert(patients)
      .values({
        name: "Audit Patient",
        phoneNumber: "+919888877777",
      })
      .returning();
    createdPatientIds.push(testPatient.id);

    const [testConsent] = await db
      .insert(consent)
      .values({
        patientId: testPatient.id,
        givenBy: "self",
        policyVersion: "v1.0",
        validUntil: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();
    createdConsentIds.push(testConsent.id);

    const [testCase] = await db
      .insert(triageCases)
      .values({
        patientId: testPatient.id,
        consentId: testConsent.id,
        mode: "self",
        status: "submitted",
        createdBy: testUser.id,
        chiefComplaint: "Testing shared logger",
      })
      .returning();
    createdCaseIds.push(testCase.id);

    // 2. Happy Path write via logAuditEvent
    console.log("  → Test 2: Happy path logAuditEvent with structural metadata");
    await logAuditEvent({
      caseId: testCase.id,
      actorId: testUser.id,
      eventType: "status_changed",
      metadata: { from: "submitted", to: "processing", reason: "pipeline_start" },
    });

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, testCase.id));
    assert.ok(entry, "Audit entry must be persisted");
    assert.equal(entry.eventType, "status_changed");
    assert.equal((entry.metadata as Record<string, unknown>).reason, "pipeline_start");
    console.log("    ✓ Event persisted with structural metadata");

    // 3. Metadata sanitization (redacting sensitive keys like passwordHash/token)
    console.log("  → Test 3: Metadata sanitization redacts sensitive credentials");
    await logAuditEvent({
      caseId: testCase.id,
      actorId: testUser.id,
      eventType: "risk_overridden",
      metadata: {
        from: "medium",
        to: "high",
        reason: "clinician_judgment",
        passwordHash: "super-secret-hash",
        token: "jwt-token-12345",
      },
    });

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.caseId, testCase.id));
    const riskOverrideEntry = entries.find((e) => e.eventType === "risk_overridden");
    assert.ok(riskOverrideEntry);
    const meta = riskOverrideEntry.metadata as Record<string, unknown>;
    assert.equal(meta.passwordHash, "[REDACTED]");
    assert.equal(meta.token, "[REDACTED]");
    assert.equal(meta.reason, "clinician_judgment");
    console.log("    ✓ Sensitive keys successfully redacted from metadata");

    // 4. Fail-open behavior: write failure does not throw or block operational flow
    console.log("  → Test 4: Fail-open design (write failure does not throw)");
    // Intercept console.error to capture [AUDIT WRITE FAILED]
    const originalConsoleError = console.error;
    let loggedGrepMessage = "";
    console.error = (...args: unknown[]) => {
      loggedGrepMessage += args.map(String).join(" ") + "\n";
    };

    try {
      // Pass an invalid actorId that violates foreign key constraint to trigger DB error
      await logAuditEvent({
        caseId: testCase.id,
        actorId: "00000000-0000-0000-0000-000000000000", // Non-existent user ID
        eventType: "closed",
        metadata: { disposition: "discharged" },
      });

      assert.ok(
        loggedGrepMessage.includes("[AUDIT WRITE FAILED]"),
        "Must log failure with grep-friendly '[AUDIT WRITE FAILED]' prefix"
      );
      assert.ok(
        loggedGrepMessage.includes("closed"),
        "Failure log must indicate the event_type"
      );
    } finally {
      console.error = originalConsoleError;
    }
    console.log("    ✓ Write failure safely caught, logged with grep-friendly prefix, did not throw");

    console.log("✓ All audit-logger.ts tests passed successfully!\n");
  } finally {
    // Cleanup
    if (createdCaseIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.caseId, createdCaseIds));
      await db.delete(triageCases).where(inArray(triageCases.id, createdCaseIds));
    }
    if (createdConsentIds.length > 0) {
      await db.delete(consent).where(inArray(consent.id, createdConsentIds));
    }
    if (createdPatientIds.length > 0) {
      await db.delete(patients).where(inArray(patients.id, createdPatientIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  }
}

if (process.argv[1]?.endsWith("audit-logger.test.ts")) {
  runAuditLoggerTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
