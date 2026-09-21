import { runCasesStateMachineTests } from "./modules/cases/cases-state-machine.test.js";
import { runAuthTests } from "./modules/auth/auth.test.js";
import { runConsentTests } from "./modules/consent/consent.test.js";
import { runCasesTests } from "./modules/cases/cases.test.js";

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

    // 2. Auth module & anti-enumeration
    await runAuthTests();

    // 3. Consent module & 30m window verification
    await runConsentTests();

    // 4. Cases intake, row-level ownership, & mode symmetry
    await runCasesTests();

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
