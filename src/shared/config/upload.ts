import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { fileTypeFromFile } from "file-type";
import { AppError } from "../utils/AppError.js";

// ==============================================================================
// 1. Storage Location & Security Configuration
// ==============================================================================
// SECURITY RULE:
// Files are stored inside uploads/ at the repo root.
// This directory must NEVER be served statically by Express (no express.static('uploads')).
// Any file retrieval must go through an authenticated route that re-checks ownership.
export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

// Ensure upload directory exists synchronously on startup
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 10 MB file size limit per upload
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// ==============================================================================
// 2. Allowed MIME Types & Format Maps
// ==============================================================================
export const ALLOWED_AUDIO_MIMES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/flac",
] as const;

export const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/bmp",
] as const;

export type AllowedAudioMime = (typeof ALLOWED_AUDIO_MIMES)[number];
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

const MIME_EXTENSION_MAP: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
};

export function isAudioMime(mime: string): boolean {
  return (
    ALLOWED_AUDIO_MIMES.includes(mime.toLowerCase() as AllowedAudioMime) ||
    mime.toLowerCase().startsWith("audio/")
  );
}

export function isImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIMES.includes(mime.toLowerCase() as AllowedImageMime);
}

export function isAllowedMime(mime: string): boolean {
  return isAudioMime(mime) || isImageMime(mime);
}

/**
 * Generate a safe file extension from original name and validated mime type.
 * Never trust raw client-provided extensions directly.
 */
function getSafeExtension(originalName: string, mime: string): string {
  const mimeExt = MIME_EXTENSION_MAP[mime.toLowerCase()];
  if (mimeExt) return mimeExt;

  const rawExt = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (rawExt && rawExt.length <= 5) {
    return rawExt;
  }
  return ".bin";
}

// ==============================================================================
// 3. Multer Disk Storage Engine
// ==============================================================================
// Never use original filename as-is for storage.
// Generate a cryptographically random UUID + safe extension.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = getSafeExtension(file.originalname, file.mimetype);
    const uniqueFilename = `${crypto.randomUUID()}${ext}`;
    cb(null, uniqueFilename);
  },
});

// ==============================================================================
// 4. First-Pass File Filter (MIME Type Filtering)
// ==============================================================================
const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  const claimedMime = file.mimetype.toLowerCase();

  // Field-based routing (voice field vs image field)
  if (file.fieldname === "voice") {
    if (!isAudioMime(claimedMime)) {
      return cb(
        AppError.validation(
          "Invalid file type for voice upload. Only audio files (MP3, WAV, WebM, OGG, M4A, AAC) are permitted.",
          { field: file.fieldname, providedMime: claimedMime, required: "audio/*" }
        )
      );
    }
  } else if (file.fieldname === "image" || file.fieldname === "file") {
    // Also accept 'file' for backwards compatibility
    if (file.fieldname === "image" && !isImageMime(claimedMime)) {
      return cb(
        AppError.validation(
          "Invalid file type for image upload. Only image files (JPEG, PNG, WebP, TIFF) are permitted.",
          { field: file.fieldname, providedMime: claimedMime, required: "image/*" }
        )
      );
    } else if (file.fieldname === "file" && !isAllowedMime(claimedMime)) {
      return cb(
        AppError.validation(
          "Invalid file type. Only audio and image files are permitted.",
          { field: file.fieldname, providedMime: claimedMime }
        )
      );
    }
  } else {
    // Reject unexpected upload fields
    return cb(
      AppError.validation(
        `Unexpected upload field '${file.fieldname}'. Only 'voice' and 'image' are accepted.`,
        { field: file.fieldname }
      )
    );
  }

  cb(null, true);
};

// ==============================================================================
// 5. Shared Multer Instance & Field Middlewares
// ==============================================================================
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES, // 10MB per file
    files: 2, // At most 1 voice + 1 image per request
  },
});

// Multipart fields middleware for unified intake: POST /api/cases
export const uploadCaseFiles = upload.fields([
  { name: "voice", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

// ==============================================================================
// 6. Magic Bytes & Deep File Signature Verification
// ==============================================================================
/**
 * Deep inspection of file on disk using magic bytes (file-type).
 * Protects against spoofed Content-Type headers (e.g., .exe or script labeled image/jpeg).
 * Deletes invalid/spoofed files immediately from disk and throws AppError.validation.
 */
export async function validateUploadedFile(
  filePath: string,
  expectedModality?: "voice" | "image_ocr"
): Promise<{ verifiedMime: string; verifiedExt: string }> {
  try {
    const detected = await fileTypeFromFile(filePath);

    // If file-type could not determine binary signature
    if (!detected) {
      await cleanupFile(filePath);
      throw AppError.validation(
        "Corrupted or unrecognized file content. The file signature could not be verified.",
        { filePath: path.basename(filePath) }
      );
    }

    const detectedMime = detected.mime.toLowerCase();

    // Verify against expected modality if provided
    if (expectedModality === "voice") {
      const isDetectedAudio =
        detectedMime.startsWith("audio/") ||
        detectedMime === "video/webm" ||
        detectedMime === "video/ogg" ||
        detectedMime === "video/mp4"; // WebM/OGG/MP4 audio containers often report as audio or video container

      if (!isDetectedAudio) {
        await cleanupFile(filePath);
        throw AppError.validation(
          `Security rejection: File claimed to be voice audio, but detected content is '${detectedMime}'.`,
          { expected: "audio/*", detected: detectedMime }
        );
      }
    } else if (expectedModality === "image_ocr") {
      if (!isImageMime(detectedMime)) {
        await cleanupFile(filePath);
        throw AppError.validation(
          `Security rejection: File claimed to be image_ocr, but detected content is '${detectedMime}'.`,
          { expected: "image/*", detected: detectedMime }
        );
      }
    } else {
      // General check: must be either valid audio or image
      const isValid =
        isImageMime(detectedMime) ||
        detectedMime.startsWith("audio/") ||
        detectedMime === "video/webm" ||
        detectedMime === "video/ogg";

      if (!isValid) {
        await cleanupFile(filePath);
        throw AppError.validation(
          `Security rejection: Unsupported file content detected ('${detectedMime}').`,
          { detected: detectedMime }
        );
      }
    }

    return {
      verifiedMime: detected.mime,
      verifiedExt: `.${detected.ext}`,
    };
  } catch (error) {
    // If not already an AppError, ensure file is cleaned up and throw validation error
    await cleanupFile(filePath);
    if (error instanceof AppError) {
      throw error;
    }
    throw AppError.validation(
      "Failed to verify file integrity",
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Safely removes a file from the upload directory.
 */
export async function cleanupFile(filePath?: string | null): Promise<void> {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (err) {
    console.error(`[Upload Cleanup Error] Failed to delete file ${filePath}:`, err);
  }
}
