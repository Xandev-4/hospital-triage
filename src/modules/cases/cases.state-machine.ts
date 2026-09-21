import { AppError } from "../../shared/utils/AppError.js";

/**
 * ==============================================================================
 * Case State Machine — Transition Truth Table (api-contract.md §11)
 * ==============================================================================
 *
 * Graph:
 * submitted → processing → queued → assigned → closed
 *                  ↓
 *           manual_fallback → queued
 *
 * Legal Transitions:
 * - submitted        → processing
 * - processing       → queued
 * - processing       → manual_fallback
 * - manual_fallback  → queued
 * - queued           → assigned
 * - assigned         → closed
 *
 * Terminal / Blocked:
 * - closed           → (no transitions allowed)
 * - withdrawn        → (reserved for V3; no incoming/outgoing transitions in V1)
 * ==============================================================================
 */

export type CaseStatus =
  | "submitted"
  | "processing"
  | "queued"
  | "manual_fallback"
  | "assigned"
  | "closed"
  | "withdrawn";

export const ALLOWED_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  submitted: ["processing"],
  processing: ["queued", "manual_fallback"],
  manual_fallback: ["queued"],
  queued: ["assigned"],
  assigned: ["closed"],
  closed: [],
  withdrawn: [],
} as const;

/**
 * Validates whether a status transition is permitted.
 * Throws AppError.invalidStateTransition (409) if the transition is illegal.
 */
export function assertValidTransition(from: CaseStatus, to: CaseStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];

  if (!allowed || !allowed.includes(to)) {
    throw AppError.invalidStateTransition(
      `Cannot transition case status from '${from}' to '${to}'`,
      { from, to, allowedTransitions: allowed ?? [] }
    );
  }
}

/**
 * Boolean predicate check for transition validity.
 */
export function isValidTransition(from: CaseStatus, to: CaseStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}
