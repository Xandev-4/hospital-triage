/**
 * Isolated Speech-to-Text (STT) Module
 *
 * Implements Section 8 of docs/triage-assistant-core-design.md and spec.md §13:
 * - Standalone audio-to-text transcription using Groq Whisper (whisper-large-v3) with Indian language support.
 * - Defensive Pre-STT Checks:
 *   1. File existence and non-zero size checks.
 *   2. File size limit enforcement (default: 10 MB).
 *   3. Magic bytes / audio format validation (wav, mp3, ogg, webm, m4a).
 *   4. Local Audio Duration Guard (via ffprobe / WAV header parser): Rejects files exceeding duration
 *      limits (default: 120s) locally before dispatching to provider to save cost and avoid rate limits.
 * - Post-STT Quality Gating:
 *   Detects empty output, silent recordings, or suspiciously short/garbage output and treats them
 *   as soft failures ({ success: false, reason: "..." }) instead of passing empty/junk content downstream.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileTypeFromFile } from "file-type";
import { sanitizeErrorMessage } from "../../shared/utils/sanitize-error.js";

const execFileAsync = promisify(execFile);

export type SttSuccessResult = {
  text: string;
  confidence: number;
};

export type SttFailureResult = {
  success: false;
  reason: string;
};

export type SttResult = SttSuccessResult | SttFailureResult;

export interface SttOptions {
  /** Maximum audio duration in seconds to process (default: 120s) */
  maxDurationSeconds?: number;
  /** Minimum acceptable audio duration in seconds (default: 0.5s) */
  minDurationSeconds?: number;
  /** Maximum file size in bytes (default: 10 MB) */
  maxFileSizeBytes?: number;
  /** Minimum required alphanumeric characters to qualify as valid speech (default: 4) */
  minAlphanumericChars?: number;
  /** Minimum confidence score (0.0 to 1.0, default: 0.4) */
  minConfidence?: number;
  /** Specific language code (e.g. 'en', 'hi') or omit for auto-detect */
  language?: string;
  /** Task type: 'transcribe' (speech to text in spoken language) or 'translate' (transcribe & translate to English) */
  task?: "transcribe" | "translate";
  /** Groq API Key override (falls back to process.env.GROQ_API_KEY) */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 10,000ms) */
  timeoutMs?: number;
  /** Testing / local mock transcription handler (bypasses live network in unit tests) */
  mockTranscribeFn?: (filePath: string) => Promise<{ text: string; confidence: number }>;
}

export const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 120; // 2 minutes
export const DEFAULT_MIN_AUDIO_DURATION_SECONDS = 0.5; // 500 ms
export const DEFAULT_MAX_AUDIO_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MIN_ALPHANUMERIC_CHARS = 4;
export const DEFAULT_MIN_STT_CONFIDENCE = 0.4; // 40%
export const DEFAULT_STT_TIMEOUT_MS = 10_000; // 10 seconds

export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/webm",
  "audio/x-m4a",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
]);

/**
 * Inspects audio file duration in seconds locally using ffprobe or WAV header inspection.
 * Rejects without calling external APIs if duration exceeds bounds.
 */
export async function getAudioDurationSeconds(filePath: string): Promise<number | null> {
  // 1. Try local ffprobe if installed
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration) && duration >= 0) {
      return duration;
    }
  } catch {
    // ffprobe failed or not present, proceed to pure-JS header parsing
  }

  // 2. Pure-JS WAV header fallback
  try {
    const buffer = Buffer.alloc(44);
    const fd = await fs.promises.open(filePath, "r");
    await fd.read(buffer, 0, 44, 0);
    await fd.close();

    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE"
    ) {
      const byteRate = buffer.readUInt32LE(28);
      const dataSize = buffer.readUInt32LE(40);
      if (byteRate > 0 && dataSize > 0) {
        return dataSize / byteRate;
      }
    }
  } catch {
    // Cannot inspect duration
  }

  return null;
}

/**
 * Transcribes an audio file into text using Groq Whisper with strict pre- and post-validation.
 *
 * @param filePath Path to the audio file on disk
 * @param options Configurable bounds for duration, size, confidence, and testing mocks
 * @returns Promise resolving to `{ text, confidence }` on success, or `{ success: false, reason }` on failure
 */
export async function transcribeAudio(
  filePath: string,
  options?: SttOptions
): Promise<SttResult> {
  const maxDuration = options?.maxDurationSeconds ?? DEFAULT_MAX_AUDIO_DURATION_SECONDS;
  const minDuration = options?.minDurationSeconds ?? DEFAULT_MIN_AUDIO_DURATION_SECONDS;
  const maxBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_AUDIO_FILE_SIZE_BYTES;
  const minChars = options?.minAlphanumericChars ?? DEFAULT_MIN_ALPHANUMERIC_CHARS;
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_STT_CONFIDENCE;
  const task = options?.task ?? "transcribe";
  const language = options?.language;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;

  try {
    // 1. File existence validation
    if (!fs.existsSync(filePath)) {
      return { success: false, reason: `Audio file does not exist: ${filePath}` };
    }

    // 2. File size validation
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) {
      return { success: false, reason: "Audio file is empty (0 bytes)" };
    }

    if (stats.size > maxBytes) {
      return {
        success: false,
        reason: `Audio file size (${stats.size} bytes) exceeds maximum limit of ${maxBytes} bytes`,
      };
    }

    // 3. Magic bytes / MIME format verification
    const detected = await fileTypeFromFile(filePath);
    if (!detected || !ALLOWED_AUDIO_MIME_TYPES.has(detected.mime)) {
      return {
        success: false,
        reason: `Invalid or unsupported audio format: detected ${detected?.mime ?? "unknown"}`,
      };
    }

    // 4. Local Audio Duration Guard (cheap local check before external network/billing)
    const duration = await getAudioDurationSeconds(filePath);
    if (duration !== null) {
      if (duration < minDuration) {
        return {
          success: false,
          reason: `Audio duration too short (${duration.toFixed(2)}s < minimum ${minDuration}s)`,
        };
      }
      if (duration > maxDuration) {
        return {
          success: false,
          reason: `Audio duration (${duration.toFixed(2)}s) exceeds maximum limit of ${maxDuration} seconds`,
        };
      }
    }

    // 5. Execute Transcription (Mock Hook for offline/unit testing OR Live Groq Whisper API)
    let rawText = "";
    let confidence = 0.85; // default nominal confidence if provider does not return logprobs

    const abortController = new AbortController();
    const timer = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      if (options?.mockTranscribeFn) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          abortController.signal.addEventListener("abort", () => {
            const timeoutErr = new Error(`STT processing timed out after ${timeoutMs}ms`);
            timeoutErr.name = "TimeoutError";
            reject(timeoutErr);
          });
        });
        const mockRes = await Promise.race([
          options.mockTranscribeFn(filePath),
          timeoutPromise,
        ]);
        rawText = mockRes.text;
        confidence = mockRes.confidence;
      } else {
        const apiKey = options?.apiKey ?? process.env.GROQ_API_KEY;
        if (!apiKey) {
          return {
            success: false,
            reason: "GROQ_API_KEY is not configured in environment",
          };
        }

        // Build multipart request for Groq Whisper endpoint
        const endpoint =
          task === "translate"
            ? "https://api.groq.com/openai/v1/audio/translations"
            : "https://api.groq.com/openai/v1/audio/transcriptions";

        const fileBuffer = await fs.promises.readFile(filePath);
        const blob = new Blob([fileBuffer], { type: detected.mime });
        const formData = new FormData();
        formData.append("file", blob, path.basename(filePath));
        formData.append("model", "whisper-large-v3");
        formData.append("response_format", "verbose_json");
        if (language) {
          formData.append("language", language);
        }

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
          signal: abortController.signal,
        });

        if (!response.ok) {
          const rawError = await response.text();
          const cleanError = sanitizeErrorMessage(rawError);
          return {
            success: false,
            reason: `Groq Whisper API returned HTTP ${response.status}: ${cleanError}`,
          };
        }

        const data = (await response.json()) as {
          text?: string;
          segments?: Array<{ avg_logprob?: number }>;
        };

        rawText = data.text ?? "";

        // Derive confidence from avg_logprob across segments if available:
        // avg_logprob ranges typically between 0 (certain) and -1 (less certain); exp(logprob) ~ probability
        if (data.segments && data.segments.length > 0) {
          const avgLogprob =
            data.segments.reduce((acc, s) => acc + (s.avg_logprob ?? -0.2), 0) /
            data.segments.length;
          confidence = Math.max(0, Math.min(1, Math.exp(avgLogprob)));
        }
      }
    } finally {
      clearTimeout(timer);
    }

    // 6. Post-STT Quality Check: Empty or whitespace-only transcription
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      return {
        success: false,
        reason: "STT returned no transcribed speech (audio is silent or unintelligible)",
      };
    }

    // 7. Post-STT Quality Check: Suspiciously short / non-alphanumeric noise (e.g. '.', '...', '!')
    const alphanumericCount = trimmedText.replace(/[^a-zA-Z0-9]/g, "").length;
    if (alphanumericCount < minChars) {
      return {
        success: false,
        reason: `STT returned suspiciously short or meaningless transcription ("${trimmedText}", ${alphanumericCount} chars < min ${minChars})`,
      };
    }

    // 8. Post-STT Quality Check: Confidence threshold
    if (confidence < minConfidence) {
      return {
        success: false,
        reason: `STT confidence score too low (${(confidence * 100).toFixed(1)}% < minimum ${(minConfidence * 100).toFixed(1)}%)`,
      };
    }

    // 9. Return verified speech transcription
    return {
      text: trimmedText,
      confidence: Math.round(confidence * 100) / 100,
    };
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError" || err?.message?.includes("timed out")) {
      return {
        success: false,
        reason: `STT processing timed out after ${timeoutMs}ms`,
      };
    }
    return {
      success: false,
      reason: sanitizeErrorMessage(`STT processing failed: ${err?.message ?? String(err)}`),
    };
  }
}
