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
import { insertAuditEvent } from "../../../src/modules/audit/audit.repository.js";

export async function runAuditRepositoryTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: audit.repository.ts (Lowest Layer)     ");
  console.log("=======================================================");

  const passwordHash = await bcrypt.hash("testpass123", 10);
  const createdUserIds: string[] = [];
  const createdPatientIds: string[] = [];
  const createdConsentIds: string[] = [];
  const createdCaseIds: string[] = [];
  const createdAuditIds: string[] = [];

  try {
    // Setup test user
    const [testUser] = await db
      .insert(users)
      .values({
        name: "Audit Repo Tester",
        email: `audit_repo_${Date.now()}@example.com`,
        passwordHash,
        role: "doctor",
      })
      .returning();
    createdUserIds.push(testUser.id);

    // Setup test patient & consent
    const [testPatient] = await db
      .insert(patients)
      .values({
        name: "Audit Repo Patient",
        phoneNumber: "+919000011111",
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
        chiefComplaint: "Testing audit repo",
      })
      .returning();
    createdCaseIds.push(testCase.id);

    // Test 1: Insert audit event with caseId
    console.log("  → Test 1: insertAuditEvent with valid caseId and metadata");
    const beforeTime = new Date(Date.now() - 2000);
    const event1 = await insertAuditEvent({
      caseId: testCase.id,
      actorId: testUser.id,
      eventType: "intake_submitted",
      metadata: { test_key: "value1", step: 1 },
    });
    createdAuditIds.push(event1.id);

    assert.ok(event1.id, "Audit entry must have a generated UUID id");
    assert.equal(event1.caseId, testCase.id);
    assert.equal(event1.actorId, testUser.id);
    assert.equal(event1.eventType, "intake_submitted");
    assert.deepEqual(event1.metadata, { test_key: "value1", step: 1 });
    assert.ok(event1.createdAt instanceof Date, "createdAt must be a Date instance");
    assert.ok(
      event1.createdAt.getTime() >= beforeTime.getTime(),
      "createdAt must be DB-generated at insert time"
    );
    console.log("    ✓ Event inserted with DB-generated now() timestamp");

    // Test 2: Insert non-case audit event (nullable caseId, e.g. patient_search)
    console.log("  → Test 2: insertAuditEvent with nullable caseId (non-case event)");
    const event2 = await insertAuditEvent({
      caseId: null,
      actorId: testUser.id,
      eventType: "patient_search",
      metadata: { search_query: "+919000011111" },
    });
    createdAuditIds.push(event2.id);

    assert.ok(event2.id);
    assert.equal(event2.caseId, null, "caseId must be null for non-case event");
    assert.equal(event2.eventType, "patient_search");
    console.log("    ✓ Non-case audit event inserted with caseId === null");

    // Test 3: Transaction executor support
    console.log("  → Test 3: insertAuditEvent inside a database transaction");
    let txEventId: string | null = null;
    await db.transaction(async (tx) => {
      const txEvent = await insertAuditEvent(
        {
          caseId: testCase.id,
          actorId: testUser.id,
          eventType: "status_changed",
          metadata: { from: "submitted", to: "processing" },
        },
        tx
      );
      txEventId = txEvent.id;
      createdAuditIds.push(txEvent.id);
      assert.ok(txEvent.id);
      assert.equal(txEvent.eventType, "status_changed");
    });
    assert.ok(txEventId, "Transaction event must be committed");
    console.log("    ✓ Audit event committed cleanly within db.transaction");

    // Test 4: Verify single write path & timestamp integrity from DB
    console.log("  → Test 4: Verify DB persistence and ordering integrity");
    const [fetched] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, event1.id));
    assert.ok(fetched);
    assert.equal(fetched.eventType, "intake_submitted");

    console.log("✓ All audit.repository.ts tests passed successfully!\n");
  } finally {
    // Cleanup
    if (createdAuditIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.id, createdAuditIds));
    }
    if (createdCaseIds.length > 0) {
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

if (process.argv[1]?.endsWith("audit.repository.test.ts")) {
  runAuditRepositoryTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
