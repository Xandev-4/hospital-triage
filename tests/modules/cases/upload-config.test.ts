import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  UPLOAD_DIR,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_AUDIO_MIMES,
  ALLOWED_IMAGE_MIMES,
  isAudioMime,
  isImageMime,
  isAllowedMime,
  validateUploadedFile,
  cleanupFile,
  upload,
} from "../../../src/shared/config/upload.js";
import { AppError } from "../../../src/shared/utils/AppError.js";

export async function runUploadConfigTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Multer Upload Config & File Security       ");
  console.log("========================================================");

  // 1. Basic Configuration
  console.log("  → Verify storage directory and size limits");
  assert.ok(fs.existsSync(UPLOAD_DIR), "Upload directory must exist");
  assert.equal(MAX_FILE_SIZE_BYTES, 10 * 1024 * 1024, "Size limit should be 10MB");
  assert.ok(upload, "Multer instance must be defined");

  // 2. MIME Type Validation Logic
  console.log("  → Verify MIME type helpers");
  assert.ok(isAudioMime("audio/mpeg"), "MP3 should be valid audio");
  assert.ok(isAudioMime("audio/wav"), "WAV should be valid audio");
  assert.ok(isAudioMime("audio/webm"), "WebM should be valid audio");
  assert.ok(!isAudioMime("image/png"), "PNG should not be audio");
  assert.ok(!isAudioMime("application/x-msdownload"), "EXE should not be audio");

  assert.ok(isImageMime("image/jpeg"), "JPEG should be valid image");
  assert.ok(isImageMime("image/png"), "PNG should be valid image");
  assert.ok(isImageMime("image/webp"), "WebP should be valid image");
  assert.ok(!isImageMime("audio/mp3"), "MP3 should not be image");

  assert.ok(isAllowedMime("audio/mp3"), "Allowed MIME check");
  assert.ok(isAllowedMime("image/png"), "Allowed MIME check");
  assert.ok(!isAllowedMime("application/pdf"), "PDF is not allowed in triage audio/image");

  // 3. Magic Bytes Deep Inspection
  console.log("  → Verify magic bytes validation on disk");

  // Test 3a: Valid 1x1 PNG image
  const validPngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const testPngPath = path.join(UPLOAD_DIR, "test-valid-image.png");
  fs.writeFileSync(testPngPath, validPngHeader);

  const pngResult = await validateUploadedFile(testPngPath, "image_ocr");
  assert.equal(pngResult.verifiedMime, "image/png");
  assert.equal(pngResult.verifiedExt, ".png");
  assert.ok(fs.existsSync(testPngPath), "Valid file must be retained on disk");
  await cleanupFile(testPngPath);
  assert.ok(!fs.existsSync(testPngPath), "cleanupFile must delete file");

  // Test 3b: Spoofed file (bash script / text disguised as image)
  console.log("  → Verify spoofed file rejection (magic bytes vs claimed type)");
  const spoofedPath = path.join(UPLOAD_DIR, "test-spoofed.jpg");
  fs.writeFileSync(
    spoofedPath,
    "#!/bin/bash\necho 'malicious script pretending to be a jpeg image'"
  );

  let spoofRejected = false;
  try {
    await validateUploadedFile(spoofedPath, "image_ocr");
  } catch (err) {
    if (err instanceof AppError && err.code === "validation_error") {
      spoofRejected = true;
    }
  }

  assert.ok(spoofRejected, "Spoofed image must be rejected with AppError validation");
  assert.ok(!fs.existsSync(spoofedPath), "Spoofed file must be deleted from disk immediately");

  // Test 3c: Mismatched modality (valid image submitted as voice)
  console.log("  → Verify modality mismatch rejection (image uploaded for voice modality)");
  const mismatchedPath = path.join(UPLOAD_DIR, "test-mismatch.png");
  fs.writeFileSync(mismatchedPath, validPngHeader);

  let modalityRejected = false;
  try {
    await validateUploadedFile(mismatchedPath, "voice");
  } catch (err) {
    if (err instanceof AppError && err.code === "validation_error") {
      modalityRejected = true;
    }
  }

  assert.ok(modalityRejected, "Image uploaded as voice must be rejected");
  assert.ok(!fs.existsSync(mismatchedPath), "Mismatched file must be cleaned up from disk");

  console.log("  ✓ All Multer upload configuration & security tests passed!\n");
}

// Direct execution support
if (process.argv[1]?.endsWith("upload-config.test.ts")) {
  runUploadConfigTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
