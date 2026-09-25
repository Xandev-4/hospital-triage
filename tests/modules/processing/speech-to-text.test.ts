import assert from "node:assert/strict";
import path from "node:path";
import {
  transcribeAudio,
  getAudioDurationSeconds,
  type SttSuccessResult,
  type SttFailureResult,
} from "../../../src/modules/processing/speech-to-text.js";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures");
const SAMPLE_AUDIO = path.join(FIXTURES_DIR, "sample-audio.wav");
const LONG_AUDIO = path.join(FIXTURES_DIR, "long-audio.wav");
const SHORT_AUDIO = path.join(FIXTURES_DIR, "short-audio.wav");
const EMPTY_AUDIO = path.join(FIXTURES_DIR, "empty-audio.wav");
const SPOOFED_AUDIO = path.join(FIXTURES_DIR, "fake-spoofed.wav");
const NON_EXISTENT_AUDIO = path.join(FIXTURES_DIR, "does-not-exist.wav");

export async function runSttTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Isolated Speech-to-Text (STT) Module   ");
  console.log("=======================================================");

  // -------------------------------------------------------------
  // Test 1: Local Audio Duration Inspection (via ffprobe / WAV)
  // -------------------------------------------------------------
  console.log("  → Test 1: Local audio duration inspection");
  const sampleDuration = await getAudioDurationSeconds(SAMPLE_AUDIO);
  assert.ok(sampleDuration !== null, "Expected duration to be successfully calculated");
  assert.ok(sampleDuration >= 3.4 && sampleDuration <= 3.6, `Expected ~3.5s duration, got ${sampleDuration}`);

  const longDuration = await getAudioDurationSeconds(LONG_AUDIO);
  assert.ok(longDuration !== null, "Expected long audio duration to be calculated");
  assert.ok(longDuration >= 124 && longDuration <= 126, `Expected ~125s duration, got ${longDuration}`);
  console.log(`    ✓ Accurately detected durations locally: sample=${sampleDuration.toFixed(2)}s, long=${longDuration.toFixed(2)}s`);

  // -------------------------------------------------------------
  // Test 2: Happy Path - Real audio transcription with valid speech
  // -------------------------------------------------------------
  console.log("  → Test 2: Successful speech transcription (happy path)");
  const happyResult = await transcribeAudio(SAMPLE_AUDIO, {
    mockTranscribeFn: async () => ({
      text: "Patient reports severe crushing chest pain radiating to left arm for two hours with diaphoresis.",
      confidence: 0.94,
    }),
  });

  assert.equal("success" in happyResult && happyResult.success === false, false, "Expected successful STT result");
  const success = happyResult as SttSuccessResult;
  assert.ok(success.text.includes("chest pain") && success.text.includes("two hours"));
  assert.equal(success.confidence, 0.94);
  console.log(`    ✓ Successfully transcribed speech (${success.text.length} chars, confidence: ${success.confidence}):`);
  console.log(`      "${success.text}"`);

  // -------------------------------------------------------------
  // Test 3: Local Duration Guard - Reject audio exceeding max duration
  // -------------------------------------------------------------
  console.log("  → Test 3: Local audio duration guard (exceeds max limit)");
  // sample-audio.wav is 3.5s, setting limit to 2s tests duration guard directly within file size bounds
  const longResult = await transcribeAudio(SAMPLE_AUDIO, { maxDurationSeconds: 2 });
  assert.equal("success" in longResult && longResult.success === false, true, "Expected failure for audio > 2s");
  const longFailure = longResult as SttFailureResult;
  assert.ok(longFailure.reason.includes("exceeds maximum limit of 2 seconds"), `Expected duration error, got: ${longFailure.reason}`);
  console.log(`    ✓ Blocked oversized audio locally before calling provider: "${longFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 4: Local Duration Guard - Reject audio below min duration
  // -------------------------------------------------------------
  console.log("  → Test 4: Local audio duration guard (too short)");
  const shortResult = await transcribeAudio(SHORT_AUDIO, { minDurationSeconds: 0.5 });
  assert.equal("success" in shortResult && shortResult.success === false, true, "Expected failure for audio < 0.5s");
  const shortFailure = shortResult as SttFailureResult;
  assert.ok(shortFailure.reason.includes("too short"), `Expected 'too short' error, got: ${shortFailure.reason}`);
  console.log(`    ✓ Blocked undersized audio: "${shortFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 5: Validation - File existence guard
  // -------------------------------------------------------------
  console.log("  → Test 5: File existence guard (missing audio file)");
  const missingResult = await transcribeAudio(NON_EXISTENT_AUDIO);
  assert.equal("success" in missingResult && missingResult.success === false, true);
  const missingFailure = missingResult as SttFailureResult;
  assert.ok(missingFailure.reason.includes("does not exist"));
  console.log(`    ✓ Handled missing file cleanly: "${missingFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 6: Validation - 0-byte file guard
  // -------------------------------------------------------------
  console.log("  → Test 6: Zero-byte file guard (empty audio)");
  const emptyResult = await transcribeAudio(EMPTY_AUDIO);
  assert.equal("success" in emptyResult && emptyResult.success === false, true);
  const emptyFailure = emptyResult as SttFailureResult;
  assert.ok(emptyFailure.reason.includes("empty"));
  console.log(`    ✓ Handled empty file cleanly: "${emptyFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 7: Validation - Magic bytes audio format validation
  // -------------------------------------------------------------
  console.log("  → Test 7: Magic bytes format validation (spoofed audio)");
  const spoofedResult = await transcribeAudio(SPOOFED_AUDIO);
  assert.equal("success" in spoofedResult && spoofedResult.success === false, true);
  const spoofedFailure = spoofedResult as SttFailureResult;
  assert.ok(spoofedFailure.reason.includes("Invalid or unsupported audio format"));
  console.log(`    ✓ Rejected spoofed binary format: "${spoofedFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 8: Post-STT Quality Check - Empty or silent recording
  // -------------------------------------------------------------
  console.log("  → Test 8: Post-STT silent recording quality check");
  const silentResult = await transcribeAudio(SAMPLE_AUDIO, {
    mockTranscribeFn: async () => ({
      text: "   \n\t ",
      confidence: 0.8,
    }),
  });
  assert.equal("success" in silentResult && silentResult.success === false, true);
  const silentFailure = silentResult as SttFailureResult;
  assert.ok(silentFailure.reason.includes("silent or unintelligible"));
  console.log(`    ✓ Silent/empty transcription rejected as soft failure: "${silentFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 9: Post-STT Quality Check - Suspiciously short / noise punctuation
  // -------------------------------------------------------------
  console.log("  → Test 9: Post-STT suspiciously short / noise check");
  const noiseResult = await transcribeAudio(SAMPLE_AUDIO, {
    mockTranscribeFn: async () => ({
      text: "...",
      confidence: 0.9,
    }),
  });
  assert.equal("success" in noiseResult && noiseResult.success === false, true);
  const noiseFailure = noiseResult as SttFailureResult;
  assert.ok(noiseFailure.reason.includes("suspiciously short or meaningless"));
  console.log(`    ✓ Garbage/noise transcription rejected: "${noiseFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 10: Post-STT Quality Check - Low confidence score threshold
  // -------------------------------------------------------------
  console.log("  → Test 10: Post-STT low confidence threshold guard");
  const lowConfResult = await transcribeAudio(SAMPLE_AUDIO, {
    mockTranscribeFn: async () => ({
      text: "Patient has headache",
      confidence: 0.25,
    }),
    minConfidence: 0.5,
  });
  assert.equal("success" in lowConfResult && lowConfResult.success === false, true);
  const lowConfFailure = lowConfResult as SttFailureResult;
  assert.ok(lowConfFailure.reason.includes("confidence score too low"));
  console.log(`    ✓ Low confidence rejected cleanly: "${lowConfFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 11: Missing Environment API Key Guard (without mock)
  // -------------------------------------------------------------
  console.log("  → Test 11: Missing API key guard (live provider mode)");
  const noKeyResult = await transcribeAudio(SAMPLE_AUDIO, { apiKey: "" });
  assert.equal("success" in noKeyResult && noKeyResult.success === false, true);
  const noKeyFailure = noKeyResult as SttFailureResult;
  assert.ok(noKeyFailure.reason.includes("GROQ_API_KEY is not configured"));
  console.log(`    ✓ Environment guard verified without crash: "${noKeyFailure.reason}"`);

  console.log("✓ All isolated Speech-to-Text (STT) tests passed successfully!\n");
}

if (process.argv[1]?.endsWith("speech-to-text.test.ts")) {
  runSttTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
