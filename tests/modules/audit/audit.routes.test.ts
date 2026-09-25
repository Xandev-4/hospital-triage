import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { inArray } from "drizzle-orm";
import { db } from "../../../src/shared/config/db.js";
import {
  auditLog,
  consent,
  patients,
  triageCases,
  users,
} from "../../../src/shared/config/schema.js";
import { env } from "../../../src/shared/config/env.js";
import { insertAuditEvent } from "../../../src/modules/audit/audit.repository.js";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

function createToken(user: { id: string; role: string; email: string }) {
  return jwt.sign(
    {
      sub: user.id,
      id: user.id,
      role: user.role,
      email: user.email,
    },
    env.jwtSecret,
    { expiresIn: "1h" }
  );
}

export async function runAuditRoutesTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: GET /api/cases/:id/audit (API §8)       ");
  console.log("=======================================================");

  const passwordHash = await bcrypt.hash("testpass123", 10);
  const createdUserIds: string[] = [];
  const createdPatientIds: string[] = [];
  const createdConsentIds: string[] = [];
  const createdCaseIds: string[] = [];
  const createdAuditIds: string[] = [];

  try {
    // 1. Setup Patient A
    const [patientAProfile] = await db
      .insert(patients)
      .values({
        name: "Audit Patient A",
        phoneNumber: "+919111100001",
      })
      .returning();
    createdPatientIds.push(patientAProfile.id);

    const [patientAUser] = await db
      .insert(users)
      .values({
        name: "Patient A",
        email: `patient_a_${Date.now()}@example.com`,
        passwordHash,
        role: "patient",
        patientId: patientAProfile.id,
      })
      .returning();
    createdUserIds.push(patientAUser.id);
    const patientAToken = createToken(patientAUser);

    // 2. Setup Patient B (non-owner)
    const [patientBProfile] = await db
      .insert(patients)
      .values({
        name: "Audit Patient B",
        phoneNumber: "+919111100002",
      })
      .returning();
    createdPatientIds.push(patientBProfile.id);

    const [patientBUser] = await db
      .insert(users)
      .values({
        name: "Patient B",
        email: `patient_b_${Date.now()}@example.com`,
        passwordHash,
        role: "patient",
        patientId: patientBProfile.id,
      })
      .returning();
    createdUserIds.push(patientBUser.id);
    const patientBToken = createToken(patientBUser);

    // 3. Setup Receptionist 1 (creator of Case 2)
    const [receptionist1] = await db
      .insert(users)
      .values({
        name: "Receptionist One",
        email: `rec1_${Date.now()}@hospital.org`,
        passwordHash,
        role: "receptionist",
      })
      .returning();
    createdUserIds.push(receptionist1.id);
    const rec1Token = createToken(receptionist1);

    // 4. Setup Receptionist 2 (non-creator)
    const [receptionist2] = await db
      .insert(users)
      .values({
        name: "Receptionist Two",
        email: `rec2_${Date.now()}@hospital.org`,
        passwordHash,
        role: "receptionist",
      })
      .returning();
    createdUserIds.push(receptionist2.id);
    const rec2Token = createToken(receptionist2);

    // 5. Setup Doctor
    const [doctorUser] = await db
      .insert(users)
      .values({
        name: "Dr. Audit Reviewer",
        email: `doc_audit_${Date.now()}@hospital.org`,
        passwordHash,
        role: "doctor",
      })
      .returning();
    createdUserIds.push(doctorUser.id);
    const doctorToken = createToken(doctorUser);

    // 6. Setup Consent for Patient A
    const [consentA] = await db
      .insert(consent)
      .values({
        patientId: patientAProfile.id,
        givenBy: "self",
        policyVersion: "v1.0",
        validUntil: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();
    createdConsentIds.push(consentA.id);

    // 7. Create Case 1 (self-intake by Patient A)
    const [case1] = await db
      .insert(triageCases)
      .values({
        patientId: patientAProfile.id,
        consentId: consentA.id,
        mode: "self",
        status: "queued",
        createdBy: patientAUser.id,
        chiefComplaint: "Severe persistent chest pressure",
        riskLevel: "critical",
      })
      .returning();
    createdCaseIds.push(case1.id);

    // Insert chronological audit events for Case 1
    const event1 = await insertAuditEvent({
      caseId: case1.id,
      actorId: patientAUser.id,
      eventType: "consent_given",
      metadata: { consent_id: consentA.id, policy_version: "v1.0" },
    });
    createdAuditIds.push(event1.id);

    // Short delay to ensure distinct timestamp ordering
    await new Promise((r) => setTimeout(r, 20));

    const event2 = await insertAuditEvent({
      caseId: case1.id,
      actorId: patientAUser.id,
      eventType: "intake_submitted",
      metadata: { mode: "self", complaint: "Severe chest pressure" },
    });
    createdAuditIds.push(event2.id);

    await new Promise((r) => setTimeout(r, 20));

    const event3 = await insertAuditEvent({
      caseId: case1.id,
      actorId: doctorUser.id,
      eventType: "status_changed",
      metadata: { from: "processing", to: "queued", reason: "rules_evaluated" },
    });
    createdAuditIds.push(event3.id);

    // 8. Create Case 2 (assisted intake created by Receptionist 1)
    const [consentB] = await db
      .insert(consent)
      .values({
        patientId: patientBProfile.id,
        givenBy: "staff",
        staffId: receptionist1.id,
        policyVersion: "v1.0",
        validUntil: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();
    createdConsentIds.push(consentB.id);

    const [case2] = await db
      .insert(triageCases)
      .values({
        patientId: patientBProfile.id,
        consentId: consentB.id,
        mode: "assisted",
        status: "queued",
        createdBy: receptionist1.id,
        chiefComplaint: "Assisted intake for acute abdominal pain",
        riskLevel: "medium",
      })
      .returning();
    createdCaseIds.push(case2.id);

    const case2Event = await insertAuditEvent({
      caseId: case2.id,
      actorId: receptionist1.id,
      eventType: "intake_submitted",
      metadata: { mode: "assisted", staff_id: receptionist1.id },
    });
    createdAuditIds.push(case2Event.id);

    // =========================================================================
    // Part 1: Ownership Verification & Anti-Enumeration (404 not 403)
    // =========================================================================

    // Test 1.1: Patient A fetches own case audit trail -> 200 OK
    console.log("  → Test 1.1: Patient A fetches own case audit trail (200 OK)");
    const resPatientA = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      headers: { Authorization: `Bearer ${patientAToken}` },
    });
    assert.equal(resPatientA.status, 200, "Expected 200 OK for patient viewing own case");
    const dataPatientA = (await resPatientA.json()) as { events: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(dataPatientA.events), "'events' must be an array");
    assert.equal(dataPatientA.events.length, 3, "Expected 3 audit events for Case 1");
    console.log("    ✓ Patient A retrieved 3 audit events for own case");

    // Test 1.2: Patient B (non-owner) fetches Case 1 audit trail -> 404 not_found (anti-enumeration)
    console.log("  → Test 1.2: Patient B (non-owner) fetches Case 1 -> 404 not_found (anti-enumeration)");
    const resPatientB = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      headers: { Authorization: `Bearer ${patientBToken}` },
    });
    assert.equal(
      resPatientB.status,
      404,
      "Expected 404 not_found to prevent case enumeration by non-owner patient"
    );
    console.log("    ✓ Anti-enumeration confirmed: non-owner received 404 not_found");

    // Test 1.3: Receptionist 2 (did not create Case 2) fetches Case 2 -> 404 not_found
    console.log("  → Test 1.3: Receptionist 2 fetches Case 2 (not creator) -> 404 not_found");
    const resRec2 = await fetch(`${BASE_URL}/api/cases/${case2.id}/audit`, {
      headers: { Authorization: `Bearer ${rec2Token}` },
    });
    assert.equal(resRec2.status, 404, "Expected 404 not_found for non-creator receptionist");
    console.log("    ✓ Anti-enumeration confirmed: non-creator receptionist received 404");

    // Test 1.4: Receptionist 1 (created Case 2) fetches Case 2 -> 200 OK
    console.log("  → Test 1.4: Receptionist 1 fetches Case 2 (creator) -> 200 OK");
    const resRec1 = await fetch(`${BASE_URL}/api/cases/${case2.id}/audit`, {
      headers: { Authorization: `Bearer ${rec1Token}` },
    });
    assert.equal(resRec1.status, 200, "Expected 200 OK for creating receptionist");
    const dataRec1 = (await resRec1.json()) as { events: Array<Record<string, unknown>> };
    assert.equal(dataRec1.events.length, 1);
    console.log("    ✓ Creator receptionist retrieved case audit trail");

    // Test 1.5: Doctor fetches Case 1 and Case 2 -> 200 OK (unrestricted clinical review)
    console.log("  → Test 1.5: Doctor fetches Case 1 and Case 2 -> 200 OK");
    const resDoc1 = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(resDoc1.status, 200);
    const resDoc2 = await fetch(`${BASE_URL}/api/cases/${case2.id}/audit`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(resDoc2.status, 200);
    console.log("    ✓ Doctor has clinical access to all case audit trails");

    // Test 1.6: Non-existent case ID -> 404 not_found
    console.log("  → Test 1.6: Non-existent case ID -> 404 not_found");
    const resNotFound = await fetch(
      `${BASE_URL}/api/cases/00000000-0000-0000-0000-000000000000/audit`,
      { headers: { Authorization: `Bearer ${doctorToken}` } }
    );
    assert.equal(resNotFound.status, 404);
    console.log("    ✓ Non-existent case returned 404 not_found");

    // Test 1.7: Unauthenticated request -> 401 unauthorized
    console.log("  → Test 1.7: Unauthenticated request -> 401 unauthorized");
    const resUnauth = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`);
    assert.equal(resUnauth.status, 401);
    console.log("    ✓ Unauthenticated request rejected with 401");

    // =========================================================================
    // Part 2: Chronological Ordering & Payload Schema (api-contract.md §8)
    // =========================================================================
    console.log("  → Test 2.1: Verify chronological ordering (created_at ASC) and payload schema");
    const docData = (await resDoc1.json()) as {
      events: Array<{
        event_type: string;
        actor_id: string;
        metadata: Record<string, unknown>;
        created_at: string;
      }>;
    };

    assert.equal(docData.events.length, 3);
    assert.equal(docData.events[0].event_type, "consent_given");
    assert.equal(docData.events[1].event_type, "intake_submitted");
    assert.equal(docData.events[2].event_type, "status_changed");

    // Verify ordering
    const t0 = new Date(docData.events[0].created_at).getTime();
    const t1 = new Date(docData.events[1].created_at).getTime();
    const t2 = new Date(docData.events[2].created_at).getTime();
    assert.ok(t0 <= t1 && t1 <= t2, "Events must be in strictly ascending chronological order");

    // Verify exact contract field structure
    for (const ev of docData.events) {
      assert.ok(typeof ev.event_type === "string", "event_type must be string");
      assert.ok(typeof ev.actor_id === "string", "actor_id must be string");
      assert.ok(typeof ev.metadata === "object" && ev.metadata !== null, "metadata must be object");
      assert.ok(typeof ev.created_at === "string", "created_at must be ISO8601 string");
      assert.ok(!isNaN(new Date(ev.created_at).getTime()), "created_at must be valid date");
    }
    console.log("    ✓ Payload schema conforms exactly to api-contract.md §8");

    // =========================================================================
    // Part 3: Paranoia Check: Genuinely NO write route on /audit
    // =========================================================================
    console.log("  → Test 3.1: Paranoia check: Confirm NO write route exists on /audit");
    const postRes = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${doctorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "closed" }),
    });
    assert.equal(
      postRes.status === 404 || postRes.status === 405,
      true,
      `POST to audit must not be accepted (got ${postRes.status})`
    );

    const patchRes = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${doctorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: {} }),
    });
    assert.equal(
      patchRes.status === 404 || patchRes.status === 405,
      true,
      `PATCH to audit must not be accepted (got ${patchRes.status})`
    );

    const deleteRes = await fetch(`${BASE_URL}/api/cases/${case1.id}/audit`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(
      deleteRes.status === 404 || deleteRes.status === 405,
      true,
      `DELETE to audit must not be accepted (got ${deleteRes.status})`
    );
    console.log("    ✓ Verified POST, PATCH, and DELETE are strictly rejected (no write route exists)");

    console.log("✓ All GET /api/cases/:id/audit route tests passed successfully!\n");
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

if (process.argv[1]?.endsWith("audit.routes.test.ts")) {
  runAuditRoutesTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
