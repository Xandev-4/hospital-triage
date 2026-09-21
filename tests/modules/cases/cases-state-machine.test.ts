import {
  assertValidTransition,
  isValidTransition,
  type CaseStatus,
} from "../../../src/modules/cases/cases.state-machine.js";
import { AppError } from "../../../src/shared/utils/AppError.js";

export async function runCasesStateMachineTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Case State Machine (api-contract.md §11)   ");
  console.log("========================================================");

  // 1. Legal transitions
  const legalPairs: [CaseStatus, CaseStatus][] = [
    ["submitted", "processing"],
    ["processing", "queued"],
    ["processing", "manual_fallback"],
    ["manual_fallback", "queued"],
    ["queued", "assigned"],
    ["assigned", "closed"],
  ];

  for (const [from, to] of legalPairs) {
    if (!isValidTransition(from, to)) {
      throw new Error(`Expected legal transition: ${from} -> ${to}`);
    }
    assertValidTransition(from, to);
    console.log(`✓ Legal transition allowed: ${from} -> ${to}`);
  }

  // 2. Illegal transitions (reverse, bypass, terminal, and withdrawn)
  const illegalPairs: [CaseStatus, CaseStatus, string][] = [
    ["submitted", "queued", "Bypassing processing"],
    ["submitted", "closed", "Direct jump to closed"],
    ["queued", "submitted", "Illegal reverse transition"],
    ["assigned", "queued", "Illegal reverse transition"],
    ["closed", "assigned", "Transition out of terminal state"],
    ["closed", "submitted", "Transition out of terminal state"],
    ["submitted", "withdrawn", "Transition into reserved withdrawn status"],
    ["processing", "withdrawn", "Transition into reserved withdrawn status"],
    ["withdrawn", "closed", "Transition out of reserved withdrawn status"],
  ];

  for (const [from, to, reason] of illegalPairs) {
    if (isValidTransition(from, to)) {
      throw new Error(
        `Expected illegal transition (${reason}): ${from} -> ${to}`
      );
    }
    let threw = false;
    try {
      assertValidTransition(from, to);
    } catch (err: any) {
      if (err instanceof AppError && err.code === "invalid_state_transition") {
        threw = true;
      }
    }
    if (!threw) {
      throw new Error(
        `Expected assertValidTransition to throw 409 for ${from} -> ${to}`
      );
    }
    console.log(
      `✓ Illegal transition blocked (409): ${from} -> ${to} [${reason}]`
    );
  }

  console.log(">> All State Machine unit assertions passed successfully!");
}

if (process.argv[1]?.endsWith("cases-state-machine.test.ts")) {
  runCasesStateMachineTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
