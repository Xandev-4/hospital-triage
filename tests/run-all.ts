import { runCasesStateMachineTests } from "./modules/cases/cases-state-machine.test.js";
import { runRulesEngineTests } from "./modules/processing/rules-engine.test.js";
import { runAiExtractionTests } from "./modules/processing/ai-extraction.test.js";
import { runProcessingServiceTests } from "./modules/processing/processing.service.test.js";
import { runAuthTests } from "./modules/auth/auth.test.js";
import { runConsentTests } from "./modules/consent/consent.test.js";
import { runCasesTests } from "./modules/cases/cases.test.js";
import { runPipelineFullLoopTests } from "./modules/processing/pipeline-full-loop.test.js";
import { runQueueServiceTests } from "./modules/queue/queue.service.test.js";
import { runQueueRoutesTests } from "./modules/queue/queue.routes.test.js";
import { runReviewServiceTests } from "./modules/review/review.service.test.js";
import { runReviewFullLoopTests } from "./modules/review/review-full-loop.test.js";
import { runUploadConfigTests } from "./modules/cases/upload-config.test.js";
import { runCasesUploadServiceTests } from "./modules/cases/cases-upload.test.js";
import { runCasesUploadRouteTests } from "./modules/cases/cases-upload-route.test.js";
import { runCasesMultipartTests } from "./modules/cases/cases-multipart.test.js";
import { runCasesManualFallbackTests } from "./modules/cases/cases-manual-fallback.test.js";
import { runCasesReportTests } from "./modules/cases/cases-report.test.js";
import { runDisclaimerTests } from "./modules/disclaimer/disclaimer.test.js";
import { runAuditRepositoryTests } from "./modules/audit/audit.repository.test.js";
import { runAuditLoggerTests } from "./modules/audit/audit-logger.test.js";
import { runAuditRoutesTests } from "./modules/audit/audit.routes.test.js";

async function main() {
  console.log(
    "=================================================================="
  );
  console.log(
    "     MULTIMODAL HEALTHCARE TRIAGE ASSISTANT — TEST RUNNER        "
  );
  console.log(
    "=================================================================="
  );

  const startTime = Date.now();

  try {
    // 1. Pure domain state machine logic
    await runCasesStateMachineTests();

    // 2. Pure deterministic rules engine
    await runRulesEngineTests();

    // 3. AI extraction & validation guard
    await runAiExtractionTests();

    // 4. Processing Orchestrator & Rules-wins safety invariant
    await runProcessingServiceTests();

    // 5. Auth module & anti-enumeration
    await runAuthTests();

    // 6. Consent module & 30m window verification
    await runConsentTests();

    // 7. Cases intake, row-level ownership, & mode symmetry
    await runCasesTests();

    // 8. Full Pipeline E2E Loop
    await runPipelineFullLoopTests();

    // 9. Doctor Queue Service
    await runQueueServiceTests();

    // 10. Doctor Queue HTTP Routes & Role Guarding
    await runQueueRoutesTests();

    // 11. Clinical Review Service Operations & Transitions
    await runReviewServiceTests();

    // 12. Full Vertical Slice End-to-End Loop
    await runReviewFullLoopTests();

    // 13. Multer Upload Configuration & File Type/Signature Security
    await runUploadConfigTests();

    // 14. Cases Service: attachUpload, Status Validation & Orphan Guard
    await runCasesUploadServiceTests();

    // 15. Cases HTTP Route: POST /api/cases/:id/upload & Auth Pipeline
    await runCasesUploadRouteTests();

    // 16. Unified Multipart Intake: POST /api/cases (Design 1)
    await runCasesMultipartTests();

    // 17. Manual Fallback: PATCH /api/cases/:id/manual-fallback & Rules Evaluation
    await runCasesManualFallbackTests();

    // 18. Clinical Report & Version History: GET /api/cases/:id/report & /report/versions
    await runCasesReportTests();

    // 19. Non-Diagnostic Disclaimer & Misc API (API §9): GET /api/disclaimer & /api/health
    await runDisclaimerTests();

    // 20. Audit Repository (Lowest Layer): insertAuditEvent & single write-path integrity
    await runAuditRepositoryTests();

    // 21. Audit Logger (Shared Layer): logAuditEvent, 10-enum safety, metadata sanitization & fail-open
    await runAuditLoggerTests();

    // 22. Audit Routes & Ownership (API §8): GET /api/cases/:id/audit, anti-enumeration & write-route paranoia
    await runAuditRoutesTests();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(
      "\n=================================================================="
    );
    console.log(`✓ ALL TEST SUITES PASSED SUCCESSFULLY in ${elapsed}s!`);
    console.log(
      "=================================================================="
    );
    process.exit(0);
  } catch (err) {
    console.error("\n❌ TEST SUITE FAILED:", err);
    process.exit(1);
  }
}

main();
