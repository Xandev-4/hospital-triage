import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import * as consentService from "./consent.service.js";
import { db } from "../../shared/config/db.js";
import { users } from "../../shared/config/schema.js";
import { AppError } from "../../shared/utils/AppError.js";

export async function createConsent(req: Request, res: Response) {
  const currentUser = req.user!;
  const { patient_id, policy_version, timestamp } = req.body;
  let { given_by } = req.body;

  if (currentUser.role === "patient") {
    if (given_by && given_by !== "self") {
      throw AppError.validation("Patients can only provide self-consent");
    }
    given_by = "self";

    // Server-side resolution: look up req.user.id -> users.patientId
    // Do NOT trust patient_id from request body
    const [userRecord] = await db
      .select({ patientId: users.patientId })
      .from(users)
      .where(eq(users.id, currentUser.id));

    if (!userRecord || !userRecord.patientId) {
      throw AppError.notFound("No patient profile linked to this account");
    }

    if (patient_id && patient_id !== userRecord.patientId) {
      throw AppError.forbidden("Cannot give consent for another patient");
    }

    const resolvedPatientId = userRecord.patientId;

    const result = await consentService.giveConsent({
      patient_id: resolvedPatientId,
      given_by: "self",
      policy_version,
      timestamp,
    });

    res.status(201).json(result);
    return;
  }

  if (currentUser.role === "receptionist") {
    if (given_by && given_by !== "staff") {
      throw AppError.validation(
        "Receptionist must record consent on behalf as 'staff'"
      );
    }
    given_by = "staff";

    // staff_id is auto-set server-side from JWT, never trusted from body
    const result = await consentService.giveConsent({
      patient_id,
      given_by: "staff",
      staff_id: currentUser.id,
      policy_version,
      timestamp,
    });

    res.status(201).json(result);
    return;
  }

  // Doctors and other roles cannot create consent records
  throw AppError.forbidden(
    "Only patients and receptionists can record consent"
  );
}

export async function getConsent(req: Request, res: Response) {
  const caseId = req.params.caseId as string;
  let patientId: string | null = null;

  if (req.user!.role === "patient") {
    const [userRecord] = await db
      .select({ patientId: users.patientId })
      .from(users)
      .where(eq(users.id, req.user!.id));
    patientId = userRecord?.patientId ?? null;
  }

  const result = await consentService.getConsentByCaseId(caseId, {
    id: req.user!.id,
    role: req.user!.role,
    patientId,
  });

  res.status(200).json(result);
}
