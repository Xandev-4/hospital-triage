import assert from "node:assert/strict";
import path from "node:path";
import {
  extractTextFromImage,
  type OcrSuccessResult,
  type OcrFailureResult,
} from "../../../src/modules/processing/ocr.js";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures");
const SAMPLE_IMAGE = path.join(FIXTURES_DIR, "sample-vital-slip.png");
const BLANK_IMAGE = path.join(FIXTURES_DIR, "blank-image.png");
const EMPTY_IMAGE = path.join(FIXTURES_DIR, "empty-file.png");
const SPOOFED_IMAGE = path.join(FIXTURES_DIR, "fake-spoofed.png");
const NON_EXISTENT_IMAGE = path.join(FIXTURES_DIR, "does-not-exist.png");

export async function runOcrTests() {
  console.log("\n=======================================================");
  console.log("   TEST SUITE: Isolated OCR Engine (ocr.ts)            ");
  console.log("=======================================================");

  // -------------------------------------------------------------
  // Test 1: Happy Path - Real test image with printed vitals
  // -------------------------------------------------------------
  console.log("  → Test 1: Real test image extraction (valid text & high confidence)");
  const happyResult = await extractTextFromImage(SAMPLE_IMAGE);

  assert.equal("success" in happyResult && happyResult.success === false, false, "Expected successful OCR extraction");
  const success = happyResult as OcrSuccessResult;
  assert.ok(typeof success.text === "string", "Expected text to be a string");
  assert.ok(success.text.length > 10, "Expected non-trivial text length");
  assert.ok(
    success.text.includes("PATIENT") || success.text.includes("REPORT") || success.text.includes("BP"),
    `Expected extracted text to include keywords from vital slip, got: "${success.text}"`
  );
  assert.ok(success.confidence >= 70, `Expected high confidence (>= 70), got ${success.confidence}`);
  console.log(`    ✓ Successfully extracted text (${success.text.length} chars, confidence: ${success.confidence}%):`);
  console.log(`      "${success.text.replace(/\n/g, " ")}"`);

  // -------------------------------------------------------------
  // Test 2: Validation - Non-existent file
  // -------------------------------------------------------------
  console.log("  → Test 2: File existence guard (missing file)");
  const missingResult = await extractTextFromImage(NON_EXISTENT_IMAGE);
  assert.equal("success" in missingResult && missingResult.success === false, true, "Expected failure for non-existent file");
  const missingFailure = missingResult as OcrFailureResult;
  assert.ok(missingFailure.reason.includes("does not exist"), `Expected 'does not exist' reason, got: ${missingFailure.reason}`);
  console.log(`    ✓ Handled gracefully without throwing: "${missingFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 3: Validation - 0-byte empty file
  // -------------------------------------------------------------
  console.log("  → Test 3: Zero-byte file guard (empty image)");
  const emptyResult = await extractTextFromImage(EMPTY_IMAGE);
  assert.equal("success" in emptyResult && emptyResult.success === false, true, "Expected failure for 0-byte file");
  const emptyFailure = emptyResult as OcrFailureResult;
  assert.ok(emptyFailure.reason.includes("empty"), `Expected 'empty' reason, got: ${emptyFailure.reason}`);
  console.log(`    ✓ Handled gracefully: "${emptyFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 4: Validation - Explicit processing file size limit
  // -------------------------------------------------------------
  console.log("  → Test 4: Max file size processing guard");
  // Set tiny limit of 50 bytes on a real 10KB+ image
  const sizeResult = await extractTextFromImage(SAMPLE_IMAGE, { maxFileSizeBytes: 50 });
  assert.equal("success" in sizeResult && sizeResult.success === false, true, "Expected failure for oversized file");
  const sizeFailure = sizeResult as OcrFailureResult;
  assert.ok(sizeFailure.reason.includes("exceeds maximum"), `Expected 'exceeds maximum' reason, got: ${sizeFailure.reason}`);
  console.log(`    ✓ Enforced OCR size threshold: "${sizeFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 5: Validation - Spoofed / invalid magic bytes
  // -------------------------------------------------------------
  console.log("  → Test 5: Magic bytes format validation (spoofed image)");
  const spoofedResult = await extractTextFromImage(SPOOFED_IMAGE);
  assert.equal("success" in spoofedResult && spoofedResult.success === false, true, "Expected failure for spoofed binary");
  const spoofedFailure = spoofedResult as OcrFailureResult;
  assert.ok(spoofedFailure.reason.includes("Invalid or unsupported"), `Expected unsupported format reason, got: ${spoofedFailure.reason}`);
  console.log(`    ✓ Rejected corrupted/spoofed image: "${spoofedFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 6: Post-OCR Quality Check - Blank white image (no readable text)
  // -------------------------------------------------------------
  console.log("  → Test 6: Blank image quality check (no text / meaningless output)");
  const blankResult = await extractTextFromImage(BLANK_IMAGE);
  assert.equal("success" in blankResult && blankResult.success === false, true, "Expected failure for blank image");
  const blankFailure = blankResult as OcrFailureResult;
  assert.ok(
    blankFailure.reason.includes("no readable text") || blankFailure.reason.includes("suspiciously short"),
    `Expected empty/short text reason, got: ${blankFailure.reason}`
  );
  console.log(`    ✓ Blank image rejected: "${blankFailure.reason}"`);

  // -------------------------------------------------------------
  // Test 7: Post-OCR Quality Check - Strict confidence threshold
  // -------------------------------------------------------------
  console.log("  → Test 7: Low confidence rejection threshold");
  // Set impossible 99.9% confidence requirement
  const strictResult = await extractTextFromImage(SAMPLE_IMAGE, { minConfidence: 99.9 });
  assert.equal("success" in strictResult && strictResult.success === false, true, "Expected failure when below strict confidence");
  const strictFailure = strictResult as OcrFailureResult;
  assert.ok(strictFailure.reason.includes("confidence score too low"), `Expected low confidence reason, got: ${strictFailure.reason}`);
  console.log(`    ✓ Low-confidence rejected properly: "${strictFailure.reason}"`);

  console.log("✓ All isolated OCR engine tests passed successfully!\n");
}

if (process.argv[1]?.endsWith("ocr.test.ts")) {
  runOcrTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test failed:", err);
      process.exit(1);
    });
}
