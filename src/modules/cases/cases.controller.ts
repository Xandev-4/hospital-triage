import type { Request, Response } from "express";
import * as casesService from "./cases.service.js";
import type { CaseStatus } from "./cases.state-machine.js";
import { AppError } from "../../shared/utils/AppError.js";
import { validateUploadedFile, cleanupFile } from "../../shared/config/upload.js";

export async function createCase(req: Request, res: Response) {
  const files = req.files as
    | { [fieldname: string]: Express.Multer.File[] }
    | undefined;

  const voiceFile = files?.voice?.[0] || req.body?.voice_file;
  const imageFile = files?.image?.[0] || req.body?.image_file;

  // Real magic bytes signature validation for any attached files before database operations
  if (voiceFile?.path) {
    await validateUploadedFile(voiceFile.path, "voice");
  }
  if (imageFile?.path) {
    await validateUploadedFile(imageFile.path, "image_ocr");
  }

  // Gracefully handle vitals if passed as JSON string in multipart form-data
  let vitals = req.body?.vitals;
  if (typeof vitals === "string") {
    try {
      vitals = JSON.parse(vitals);
    } catch {
      vitals = undefined;
    }
  }

  const result = await casesService.createCase(
    {
      ...req.body,
      vitals,
      voice_file: voiceFile
        ? {
            path: voiceFile.path,
            mimetype: voiceFile.mimetype,
            size: voiceFile.size,
            originalname: voiceFile.originalname,
          }
        : null,
      image_file: imageFile
        ? {
            path: imageFile.path,
            mimetype: imageFile.mimetype,
            size: imageFile.size,
            originalname: imageFile.originalname,
          }
        : null,
    },
    req.user!
  );

  res.status(201).json(result);
}

export async function getCaseById(req: Request, res: Response) {
  const caseId = req.params.id as string;
  const result = await casesService.getCaseById(caseId, req.user!);
  res.status(200).json(result);
}

export async function listCases(req: Request, res: Response) {
  const status = req.query.status as CaseStatus | undefined;
  const result = await casesService.listCases(req.user!, { status });
  res.status(200).json(result);
}

export async function getCaseReport(req: Request, res: Response) {
  const caseId = req.params.id as string;
  const result = await casesService.getCaseReport(caseId, req.user!);
  res.status(200).json(result);
}

export async function attachUpload(req: Request, res: Response) {
  const caseId = req.params.id as string;
  const modality = req.body?.modality as "voice" | "image_ocr";

  if (!req.file) {
    throw AppError.validation("Uploaded file is required in 'file' field");
  }

  if (modality !== "voice" && modality !== "image_ocr") {
    await cleanupFile(req.file.path);
    throw AppError.validation(
      "modality is required and must be either 'voice' or 'image_ocr'",
      { provided_modality: modality }
    );
  }

  // Real magic bytes signature validation on disk before treating as authentic
  await validateUploadedFile(req.file.path, modality);

  const result = await casesService.attachUpload(
    caseId,
    modality,
    {
      path: req.file.path,
      mimetype: req.file.mimetype,
      size: req.file.size,
      originalname: req.file.originalname,
    },
    req.user!
  );

  res.status(201).json(result);
}
