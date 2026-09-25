/**
 * Isolated Optical Character Recognition (OCR) Engine
 *
 * Implements Section 8 of docs/triage-assistant-core-design.md and spec.md §13:
 * - Standalone image-to-text extraction using local Tesseract.js engine (zero API cost, zero network downtime).
 * - Layered defense: Validates image existence, non-zero size, explicit processing size limit,
 *   and magic-byte verification before dispatching to the OCR engine.
 * - Post-OCR quality gating: Detects empty, suspiciously short, or low-confidence/garbage extractions
 *   and treats them as extraction failures ({ success: false, reason: "..." }) rather than propagating
 *   garbage text downstream into clinical reasoning.
 */

import fs from "node:fs";
import { fileTypeFromFile } from "file-type";
import Tesseract from "tesseract.js";
import { sanitizeErrorMessage } from "../../shared/utils/sanitize-error.js";

export type OcrSuccessResult = {
  text: string;
  confidence: number;
};

export type OcrFailureResult = {
  success: false;
  reason: string;
};

export type OcrResult = OcrSuccessResult | OcrFailureResult;

export interface OcrOptions {
  /** Maximum file size in bytes to process (default: 5MB to avoid memory bloat) */
  maxFileSizeBytes?: number;
  /** Minimum acceptable OCR confidence percentage (0-100, default: 40) */
  minConfidence?: number;
  /** Minimum required alphanumeric characters to qualify as meaningful text (default: 4) */
  minAlphanumericChars?: number;
  /** OCR language (default: 'eng') */
  language?: string;
  /** Maximum processing timeout in milliseconds (default: 10,000ms) */
  timeoutMs?: number;
}

export const DEFAULT_MAX_OCR_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_MIN_OCR_CONFIDENCE = 40; // 40% confidence threshold
export const DEFAULT_MIN_ALPHANUMERIC_CHARS = 4;
export const DEFAULT_OCR_TIMEOUT_MS = 10_000; // 10 seconds
export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Extracts text from an image file using Tesseract.js with strict pre- and post-validation.
 *
 * @param filePath Absolute or relative path to the image file
 * @param options Configurable constraints for size, confidence, and language
 * @returns Promise resolving to `{ text, confidence }` on success, or `{ success: false, reason }` on failure
 */
export async function extractTextFromImage(
  filePath: string,
  options?: OcrOptions
): Promise<OcrResult> {
  const maxBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_OCR_FILE_SIZE_BYTES;
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_OCR_CONFIDENCE;
  const minChars = options?.minAlphanumericChars ?? DEFAULT_MIN_ALPHANUMERIC_CHARS;
  const language = options?.language ?? "eng";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;

  try {
    // 1. File existence validation
    if (!fs.existsSync(filePath)) {
      return { success: false, reason: `File does not exist: ${filePath}` };
    }

    // 2. File size validation
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) {
      return { success: false, reason: "Image file is empty (0 bytes)" };
    }

    if (stats.size > maxBytes) {
      return {
        success: false,
        reason: `Image file size (${stats.size} bytes) exceeds maximum OCR processing limit of ${maxBytes} bytes`,
      };
    }

    // 3. Magic bytes / MIME format verification at OCR layer
    const detected = await fileTypeFromFile(filePath);
    if (!detected || !ALLOWED_IMAGE_MIME_TYPES.has(detected.mime)) {
      return {
        success: false,
        reason: `Invalid or unsupported image format: detected ${detected?.mime ?? "unknown"}`,
      };
    }

    // 4. Timeout guard: create promise that rejects if timeout expires
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`OCR processing timed out after ${timeoutMs}ms`);
        timeoutErr.name = "TimeoutError";
        reject(timeoutErr);
      }, timeoutMs);
    });

    // 5. Execute OCR recognition with timeout race
    const ocrPromise = Tesseract.recognize(filePath, language, {
      errorHandler: (_err) => {
        // Suppress raw dumps to protect against PII leakage
      },
    });

    const result = await Promise.race([ocrPromise, timeoutPromise]);

    const rawText = result.data.text ?? "";
    const confidence = typeof result.data.confidence === "number" ? result.data.confidence : 0;
    const trimmedText = rawText.trim();

    // 6. Post-OCR Quality Check: Empty or whitespace-only text
    if (!trimmedText) {
      return {
        success: false,
        reason: "OCR extracted no readable text from image",
      };
    }

    // 7. Post-OCR Quality Check: Suspiciously short / non-alphanumeric garbage
    const alphanumericCount = trimmedText.replace(/[^a-zA-Z0-9]/g, "").length;
    if (alphanumericCount < minChars) {
      return {
        success: false,
        reason: `OCR extracted suspiciously short or meaningless text (${alphanumericCount} alphanumeric characters, minimum required: ${minChars})`,
      };
    }

    // 8. Post-OCR Quality Check: Low confidence threshold
    if (confidence < minConfidence) {
      return {
        success: false,
        reason: `OCR confidence score too low (${confidence}% < minimum ${minConfidence}%)`,
      };
    }

    // 9. Return verified text and confidence score
    return {
      text: trimmedText,
      confidence,
    };
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.message?.includes("timed out")) {
      return {
        success: false,
        reason: `OCR processing timed out after ${timeoutMs}ms`,
      };
    }
    return {
      success: false,
      reason: sanitizeErrorMessage(`OCR processing failed: ${err?.message ?? String(err)}`),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
