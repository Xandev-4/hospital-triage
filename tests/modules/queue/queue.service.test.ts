import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { getQueue } from "../../../src/modules/queue/queue.service.js";
import { db } from "../../../src/shared/config/db.js";
import {
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";

export async function runQueueServiceTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Doctor Triage Queue Service             ");
  console.log("=======================================================");

  // 1. Setup isolated doctor, patient, and consent records
  const [docUser] = await db
    .insert(users)
    .values({
      name: "Dr. Queue Tester",
      email: `doc_queue_${Date.now()}@hospital.org`,
      passwordHash: "dummyhash",
      role: "doctor",
    })
    .returning();

  const [patientUser] = await db
    .insert(users)
    .values({
      name: "Queue Test Patient User",
      email: `patient_queue_${Date.now()}@example.com`,
      passwordHash: "dummyhash",
      role: "patient",
    })
    .returning();

  const [testPatient] = await db
    .insert(patients)
    .values({
      name: "Alice Queue Test",
      phoneNumber: "+919876543210",
    })
    .returning();

  const [activeConsent] = await db
    .insert(consent)
    .values({
      patientId: testPatient.id,
      givenBy: "self",
      policyVersion: "v1.0",
      validUntil: new Date(Date.now() + 30 * 60 * 1000),
    })
    .returning();

  const createdCaseIds: string[] = [];

  try {
    // ========================================================================
    // Test 1: Role Guard — Doctor Only
    // ========================================================================
    console.log("\n--- Test 1: Role Guard (Doctor Only) ---");
    {
      // Patient actor attempt
      await assert.rejects(
        async () => {
          await getQueue({ id: patientUser.id, role: "patient" });
        },
        (err: any) => {
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, "forbidden");
          return true;
        },
        "Patient role must be blocked from queue with 403 forbidden"
      );

      // Receptionist actor attempt
      await assert.rejects(
        async () => {
          await getQueue({ id: "some-staff-id", role: "receptionist" });
        },
        (err: any) => {
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, "forbidden");
          return true;
        },
        "Receptionist role must be blocked from queue with 403 forbidden"
      );

      console.log(
        "✓ Role guard passed: Non-doctor actors rejected with 403 forbidden"
      );
    }

    // ========================================================================
    // Test 2: Active Status Scoping (queued & assigned included; others excluded)
    // ========================================================================
    console.log("\n--- Test 2: Active Status Scoping ---");
    {
      // Insert cases across various statuses
      const statusesToTest = [
        "submitted",
        "processing",
        "manual_fallback",
        "queued",
        "assigned",
        "closed",
      ] as const;

      const testCases = await Promise.all(
        statusesToTest.map(async (st) => {
          const [c] = await db
            .insert(triageCases)
            .values({
              patientId: testPatient.id,
              createdBy: docUser.id,
              consentId: activeConsent.id,
              mode: "self",
              status: st,
              chiefComplaint: `Status test for ${st}`,
              riskLevel: "medium",
            })
            .returning();
          createdCaseIds.push(c.id);
          return { id: c.id, status: st };
        })
      );

      const result = await getQueue({ id: docUser.id, role: "doctor" });

      const returnedIds = new Set(result.queue.map((q) => q.case_id));

      // Assert queued and assigned ARE in queue
      const queuedCase = testCases.find((t) => t.status === "queued")!;
      const assignedCase = testCases.find((t) => t.status === "assigned")!;
      assert.ok(
        returnedIds.has(queuedCase.id),
        "Queued case must be included in queue"
      );
      assert.ok(
        returnedIds.has(assignedCase.id),
        "Assigned case must be included in queue"
      );

      // Assert submitted, processing, manual_fallback, and closed are NOT in queue
      const submittedCase = testCases.find((t) => t.status === "submitted")!;
      const processingCase = testCases.find((t) => t.status === "processing")!;
      const fallbackCase = testCases.find(
        (t) => t.status === "manual_fallback"
      )!;
      const closedCase = testCases.find((t) => t.status === "closed")!;

      assert.ok(
        !returnedIds.has(submittedCase.id),
        "Submitted case must be excluded from queue"
      );
      assert.ok(
        !returnedIds.has(processingCase.id),
        "Processing case must be excluded from queue"
      );
      assert.ok(
        !returnedIds.has(fallbackCase.id),
        "manual_fallback case must be excluded from queue"
      );
      assert.ok(
        !returnedIds.has(closedCase.id),
        "Closed case must be excluded from queue"
      );

      console.log(
        "✓ Status scoping passed: Only 'queued' and 'assigned' cases appear in the active queue"
      );
    }

    // ========================================================================
    // Test 3: Non-Alphabetical Risk Ordering (critical -> high -> medium -> low)
    // ========================================================================
    console.log("\n--- Test 3: Explicit Non-Alphabetical Risk Ordering ---");
    {
      // Clean up previous test cases so we can inspect precise ordering
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
      createdCaseIds.length = 0;

      // Insert in scrambled order: Low first, then Critical, Medium, High
      const [caseLow] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Mild scrape on elbow",
          riskLevel: "low",
          createdAt: new Date("2026-09-21T10:00:00Z"),
        })
        .returning();

      const [caseCrit] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Massive myocardial infarction",
          riskLevel: "critical",
          createdAt: new Date("2026-09-21T10:05:00Z"),
        })
        .returning();

      const [caseMed] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Persistent fever for 4 days",
          riskLevel: "medium",
          createdAt: new Date("2026-09-21T10:02:00Z"),
        })
        .returning();

      const [caseHigh] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Severe breathlessness and high BP",
          riskLevel: "high",
          createdAt: new Date("2026-09-21T10:03:00Z"),
        })
        .returning();

      createdCaseIds.push(caseLow.id, caseCrit.id, caseMed.id, caseHigh.id);

      const result = await getQueue({ id: docUser.id, role: "doctor" });

      // Find indices of our test cases
      const idxCrit = result.queue.findIndex((q) => q.case_id === caseCrit.id);
      const idxHigh = result.queue.findIndex((q) => q.case_id === caseHigh.id);
      const idxMed = result.queue.findIndex((q) => q.case_id === caseMed.id);
      const idxLow = result.queue.findIndex((q) => q.case_id === caseLow.id);

      assert.ok(idxCrit >= 0 && idxHigh >= 0 && idxMed >= 0 && idxLow >= 0);
      assert.ok(
        idxCrit < idxHigh,
        `Critical (${idxCrit}) must appear before High (${idxHigh})`
      );
      assert.ok(
        idxHigh < idxMed,
        `High (${idxHigh}) must appear before Medium (${idxMed})`
      );
      assert.ok(
        idxMed < idxLow,
        `Medium (${idxMed}) must appear before Low (${idxLow}) (proves non-alphabetical sort)`
      );

      console.log(
        "✓ Risk ordering passed: Queue order is strictly critical -> high -> medium -> low"
      );
    }

    // ========================================================================
    // Test 4: FIFO Tie-Breaking Within Risk Tier
    // ========================================================================
    console.log("\n--- Test 4: FIFO Tie-Breaking Within Risk Tier ---");
    {
      const [critEarlier] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Earlier critical patient",
          riskLevel: "critical",
          createdAt: new Date("2026-09-21T08:00:00Z"), // 8:00 AM
        })
        .returning();

      const [critLater] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: "Later critical patient",
          riskLevel: "critical",
          createdAt: new Date("2026-09-21T09:00:00Z"), // 9:00 AM
        })
        .returning();

      createdCaseIds.push(critEarlier.id, critLater.id);

      const result = await getQueue({ id: docUser.id, role: "doctor" });
      const idxEarlier = result.queue.findIndex(
        (q) => q.case_id === critEarlier.id
      );
      const idxLater = result.queue.findIndex(
        (q) => q.case_id === critLater.id
      );

      assert.ok(
        idxEarlier < idxLater,
        "Earlier submitted critical case must precede later one (FIFO)"
      );

      console.log(
        "✓ FIFO tie-breaking passed: Earlier submission prioritized within same risk tier"
      );
    }

    // ========================================================================
    // Test 5: Scannable Summary Projection (No Sensitive Data Leaks)
    // ========================================================================
    console.log(
      "\n--- Test 5: Scannable Summary Projection & Data Leak Prevention ---"
    );
    {
      const longComplaint =
        "Patient presents with intense crushing substernal chest discomfort radiating directly into the left mandible and upper brachial region, accompanied by severe cold sweats, nausea, and acute dizziness since breakfast.";

      const [leakTest] = await db
        .insert(triageCases)
        .values({
          patientId: testPatient.id,
          createdBy: docUser.id,
          consentId: activeConsent.id,
          mode: "self",
          status: "queued",
          chiefComplaint: longComplaint,
          symptoms:
            "Highly confidential detailed clinical narrative that must not leak in summary",
          vitals: { spo2: 88, heartRate: 120 },
          riskLevel: "critical",
        })
        .returning();

      createdCaseIds.push(leakTest.id);

      const result = await getQueue({ id: docUser.id, role: "doctor" });
      const item = result.queue.find((q) => q.case_id === leakTest.id);
      assert.ok(item, "Item must be present in queue");

      // Verify contract projection fields
      assert.equal(item.case_id, leakTest.id);
      assert.equal(item.patient_display, "Alice Queue Test");
      assert.equal(item.risk_level, "critical");
      assert.equal(item.status, "queued");
      assert.ok(typeof item.submitted_at === "string");

      // Verify truncation
      assert.ok(item.chief_complaint.length <= 100);
      assert.ok(item.chief_complaint.endsWith("..."));

      // Verify ZERO data leakage of raw symptoms or vitals in summary projection
      const rawItem = item as Record<string, unknown>;
      assert.equal(
        rawItem.symptoms,
        undefined,
        "symptoms must NOT be leaked in queue summary"
      );
      assert.equal(
        rawItem.vitals,
        undefined,
        "vitals must NOT be leaked in queue summary"
      );
      assert.equal(
        rawItem.duration,
        undefined,
        "duration must NOT be leaked in queue summary"
      );
      assert.equal(
        rawItem.consentId,
        undefined,
        "consentId must NOT be leaked in queue summary"
      );
      assert.equal(
        rawItem.createdBy,
        undefined,
        "createdBy must NOT be leaked in queue summary"
      );

      console.log(
        "✓ Payload safety passed: Queue exclusively projects scannable fields with zero clinical leakage"
      );
    }

    // ========================================================================
    // Test 6: Queue Filtering (status and risk_level)
    // ========================================================================
    console.log("\n--- Test 6: Queue Filtering ---");
    {
      // Filter by status: queued
      const queuedOnly = await getQueue(
        { id: docUser.id, role: "doctor" },
        { status: "queued" }
      );
      assert.ok(queuedOnly.queue.every((q) => q.status === "queued"));

      // Filter by risk_level: critical
      const critOnly = await getQueue(
        { id: docUser.id, role: "doctor" },
        { risk_level: "critical" }
      );
      assert.ok(critOnly.queue.every((q) => q.risk_level === "critical"));

      // Filter validation error on illegal status
      await assert.rejects(
        async () => {
          await getQueue(
            { id: docUser.id, role: "doctor" },
            { status: "closed" as any }
          );
        },
        (err: any) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "validation_error");
          return true;
        }
      );

      console.log(
        "✓ Queue filtering passed: status and risk_level filters operate accurately"
      );
    }

    console.log(
      "\n✓ ALL Doctor Triage Queue Service tests passed successfully!"
    );
  } finally {
    // Clean up created records
    if (createdCaseIds.length > 0) {
      await db
        .delete(triageCases)
        .where(inArray(triageCases.id, createdCaseIds));
    }
    await db.delete(consent).where(eq(consent.id, activeConsent.id));
    await db.delete(patients).where(eq(patients.id, testPatient.id));
    await db
      .delete(users)
      .where(inArray(users.id, [docUser.id, patientUser.id]));
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("queue.service.test.ts") ||
    process.argv[1].endsWith("queue.service.test.js"))
) {
  runQueueServiceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Queue service test failed:", err);
      process.exit(1);
    });
}
