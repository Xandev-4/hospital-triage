# Work Log — Multimodal Healthcare Triage Assistant (21-09-26)

Summary of architecture, features built, and verification completed on September 21, 2026. Organized category-wise across domain modules.

---

## 1. Consent Management Module (`src/modules/consent/`)

### Architecture & Clinical Rationale

In multimodal healthcare triage, patient consent is a strict legal and safety gatekeeper. No case may be created, stored in `triage_cases`, or analyzed by the AI rules engine without an active, unexpired consent record.

### Key Implementation Decisions

- **Strict 30-Minute Temporal Window**: Hospital admissions and patient presentations are dynamic. Consent is not permanent; when granted via `giveConsent`, `valid_until` is calculated server-side as $\text{now} + 30\text{ minutes}$. Any consent older than 30 minutes is rejected as expired with `403 consent_required`.
- **Mode Symmetry (`self` vs `assisted`)**:
  - `given_by: "self"` is restricted exclusively to self-intake cases (`mode: "self"`).
  - `given_by: "staff"` is recorded by hospital receptionists/nurses for assisted intakes (`mode: "assisted"`).
  - Cross-mode usage (e.g. receptionist attempting assisted intake with a self-consent) is strictly rejected with `403 consent_required`.
- **Anti-Tampering Server-Side Identity Resolution**: For self-consent, `patient_id` is resolved server-side from `actor.id -> users.patientId`. Client attempts to supply a forged `patient_id` in the body are intercepted and blocked with `403 forbidden`.
- **The Gatekeeper (`checkValidConsent`)**: Invoked at the very beginning of case intake before touching `triage_cases`. Queries active consent by `patientId`, `validUntil > now`, and matching mode.

### Endpoints Built

- `POST /api/consent` — Records new consent row with 30-minute validity timestamp.
- `GET /api/consent/active` — Retrieves active consent record or 404 if missing/expired.

### Verification (`tests/modules/consent/consent.test.ts`)

- Automated tests verifying window calculation, active retrieval, mode mismatch rejection, expired consent rejection (>30m), and anti-tampering rejection on forged patient IDs.

---

## 2. Case Intake & Lifecycle Management (`src/modules/cases/`)

### Domain State Machine (`cases.state-machine.ts`)

To prevent invalid workflows or skipped review stages, case status progression is strictly enforced via a pure finite state machine:

- `submitted` $\rightarrow$ `processing`
- `processing` $\rightarrow$ `queued` | `manual_fallback`
- `manual_fallback` $\rightarrow$ `queued` (skip-AI manual re-evaluation path)
- `queued` $\rightarrow$ `assigned` (doctor assignment)
- `assigned` $\rightarrow$ `closed` (terminal state)
- `closed` is strictly terminal (no outgoing transitions).
- Any illegal transition throws `AppError.invalidStateTransition(from, to)` yielding a `409 invalid_state_transition`.

### Case Intake (`createCase`)

- Validates consent first via `checkValidConsent`, failing closed with `403 consent_required`.
- Enforces server-side resolution of `patientId` for self-intake from `users.patientId` (never trusting client-supplied `patient_id` or `created_by`).
- Enforces field length limits (`chief_complaint <= 1000`, `symptoms <= 5000`, `duration <= 100`).
- Inserts initial case row with status `"submitted"` and records `intake_submitted` audit event.
- **Internal-Only Trigger Wiring**: Invokes `processCase(createdCase.id, actor)` directly as an internal TypeScript function call. There is no external Express route for `/process` (external requests return `404 Not Found`).
- **Response Privacy Shield**: Returns a minimal safe payload (`{ case_id, status, consent_id, mode }`). Under no circumstances are internal AI stack traces or raw model errors leaked in HTTP responses.

### Row-Level Ownership & Anti-Enumeration Protections

- `getCaseById`: Patients can only view their own cases; receptionists can only view cases they created; doctors have queue-wide access. Unauthorized lookups return `404 not_found` (NOT `403 forbidden`) to prevent enumeration of valid case IDs.
- `listCases`: Applies the same row-level filtering to list queries and truncates `chief_complaint` to 100 characters for list views.
- `getCaseReport`: Implemented `GET /api/cases/:id/report` returning the latest versioned clinical report from `case_report_versions` including extracted fields, risk level, disagreement banner, and missing info checklist.

### Endpoints Built

- `POST /api/cases` — Role-gated to `patient`, `receptionist`. Validates consent and triggers internal processing.
- `GET /api/cases/:id` — Retrieves case with row-level ownership and anti-enumeration.
- `GET /api/cases/:id/report` — Retrieves latest clinical report version.
- `GET /api/cases` — Lists cases filtered by caller role.

### Verification (`tests/modules/cases/`)

- `cases-state-machine.test.ts`: 17 unit test assertions covering all legal transitions, terminal locks, and error codes.
- `cases.test.ts`: 9 integration scenarios verifying consent gating, anti-enumeration, mode mismatch, expired consent, list filtering, and 404 on external `/process` requests.

---

## 3. Clinical Safety & Processing Engine (`src/modules/processing/`)

### Architecture: Deterministic Safety Over Probabilistic AI

Probabilistic LLMs cannot be solely trusted with clinical risk assessment. The system architecture strictly enforces:

1. **AI extracts and structures** unstructured clinical text and vitals.
2. **A deterministic rules engine tags clinical risk**, strictly overriding the AI on any disagreement.

### 1. Pure Deterministic Rules Engine (`rules-engine.ts`)

- Completely decoupled from Express, Drizzle ORM, database models, and AI providers. Pure function: `evaluateRisk(structuredData)`.
- Zero randomness, no `Date.now()`. Guaranteed identical output on identical inputs across runs.
- **Section 7 Clinical Rules Implemented**:
  - **7 CRITICAL Rules (`RR-CRIT-01` to `RR-CRIT-07`)**: $\text{SpO}_2 < 90\%$; unconscious/unresponsive; uncontrolled bleeding; severe dyspnea + cyanosis; active seizure; severe abdominal pain in pregnancy; chest pain radiating to arm, jaw, neck, shoulder, or back.
  - **7 HIGH Rules (`RR-HIGH-01` to `RR-HIGH-07`)**: Chest pain + diaphoresis; severe breathlessness without cyanosis; fever $> 103^\circ\text{F}$ + confusion; blood sugar $< 60$ or $> 300\text{ mg/dL}$; hematemesis/hemoptysis; FAST stroke red flags; hypertensive emergency (systolic $\ge 180$ or diastolic $\ge 120$).
  - **5 MEDIUM Rules (`RR-MED-01` to `RR-MED-05`)**: Fever persisting $> 3\text{ days}$; persistent vomiting; exertional dyspnea; worsening chronic condition; trauma with swelling.
  - **Fail-Closed Anomaly & Missing Data Safety Floors**:
    - `RR-ANOMALY-01`: Out-of-range impossible vitals (e.g. OCR error: temp $300^\circ\text{F}$, negative heart rate, $\text{SpO}_2 > 100\%$) flag an anomaly and enforce a minimum risk floor of `medium` (never silently downgrading to low).
    - `RR-MISSING-01`: Fever without duration enforces `medium` risk floor.
    - `RR-MISSING-02`: Acute cardiopulmonary complaints without vitals enforce `medium` risk floor.
  - **LOW Default (`RR-LOW-01`)**: Applied only when zero red-flag, anomaly, or missing-info rules fire.

### 2. AI Extraction & Multimodal Wrapper (`ai-extraction.ts`)

- Pure wrapper `extractStructuredData(rawInput, options)`. Built in stub mode by default to enable thorough local testing without API costs or external network dependencies.
- **Timeout Guard**: Configurable `timeoutMs` (default: 5000ms) with `AbortController` cleanup. Aborts hanging requests and returns `{ success: false, reason: "ai_extraction_timeout" }`.
- **Strict Vitals Validation Guard (`validateAndSanitizeOutput`)**: Catches non-numeric vitals (e.g. `{ heartRate: "abc" }`) and fails closed with `{ success: false, reason: "ai_malformed_output" }`.
- **Failure & Low-Confidence Signalling (Demo Scenario D)**: Unclear handwriting or low confidence ($< 0.70$) cleanly returns `{ success: false, reason: "low_confidence", data: partialData }` routing to `manual_fallback`.
- **Section 8 Symptom Checklist Engine**: Evaluates clinical narratives across 11 categories (`fever`, `chest_pain`, `breathing_difficulty`, `abdominal_pain`, etc.) to detect missing critical information (`duration`, `spo2_reading`, `peak_temperature`, `radiation_pattern`, `bp_reading`).
- **PII-Safe Logging**: All internal logging is gated behind `DEBUG_AI === "true"` and strictly restricted to operational metadata, never logging patient text or names.

### 3. Processing Orchestrator (`processing.service.ts`)

- Manages state transitions: `submitted -> processing -> queued` or `manual_fallback`.
- **The Core Safety Invariant**: Compares AI suggested risk against deterministic rules output. If they disagree, flags `aiRulesDisagreement: true` and the rules result **strictly overrides** the AI recommendation.
- Appends versioned report to `case_report_versions` (`source: "ai"`, `version_number: 1`).
- Logs distinct, non-batched audit events for status transitions and AI generation milestones.
- **Skip-AI Re-Evaluation (`skip_ai: true`)**: Re-evaluates `manual_fallback` cases after staff edit, transitioning directly `manual_fallback -> queued` with `source: "manual"`.
- **Fault-Tolerance**: Catches unexpected runtime exceptions and safely falls back to `manual_fallback` (`is_bug: true`) so cases are never left orphaned in `processing`.

---

## 4. End-to-End Pipeline & Integration Verification

### Full Loop Testing (`tests/modules/processing/pipeline-full-loop.test.ts`)

Executed full HTTP integration loop against live server on port 8000:

1. **Critical Rule Trigger**: $\text{SpO}_2: 84\%$, heart rate: $110$ $\rightarrow$ auto-processing transitions `submitted -> processing -> queued` $\rightarrow$ `GET /api/cases/:id/report` confirms `risk_level: "critical"` via `RR-CRIT-01`.
2. **AI vs Rules Disagreement**: Acute coronary syndrome symptoms (_"Severe crushing chest pain radiating to left arm and jaw"_) with AI suggesting `"low"` $\rightarrow$ rules engine strictly overrides to `"critical"`, report stores `risk_level: "critical"`, `ai_rules_disagreement: { present: true, ai_suggested: "low", rules_result: "critical", note: "rules result applies" }`.
3. **Manual Fallback Routing (Demo Scenario D)**: Illegible scan with low AI confidence $\rightarrow$ auto-routes to `status: "manual_fallback"`, report returns `status: "manual_fallback"` and `risk_level: null`.
4. **Missing-Info Checklist & Fail-Closed Floor**: Acute chest pain without vitals or duration $\rightarrow$ report checklist flags missing items (`missing_info: ["duration", "radiation_pattern"]`) and `RR-MISSING-02` enforces `medium` risk floor.

### Subtle Edge Cases Caught & Fixed During Verification

- **Radiation Pattern Regex**: Enhanced `RR-CRIT-07` regex to match anatomical directional modifiers (`left`/`right`/`the`) in pain radiation patterns (e.g. `radiating to left arm and jaw`).
- **Vitals `rawPresent` Guard**: Fixed `normalizeAndValidateVitals` so `rawPresent` checks for actual non-null, non-empty values rather than checking `Object.keys().length > 0` on null-initialized vital objects.
- **Omitted Duration Preservation**: Fixed stub extraction so omitted durations remain unpopulated, allowing Section 8 missing-info detector to flag them accurately.

---

## 5. Test Suite Summary

All 8 backend test suites pass 100% cleanly via `npm test` in 58.74s:

1. `cases-state-machine.test.ts` (Domain transition rules)
2. `rules-engine.test.ts` (Deterministic clinical rules engine)
3. `ai-extraction.test.ts` (AI extraction wrapper, validation guard, timeout)
4. `processing.service.test.ts` (Orchestrator, overrides, error recovery)
5. `auth.test.ts` (Auth flows, anti-enumeration, atomic transactions)
6. `consent.test.ts` (Consent window, mode symmetry, anti-tampering)
7. `cases.test.ts` (Intake, row ownership, blocked external routes)
8. `pipeline-full-loop.test.ts` (E2E HTTP loop, critical trigger, disagreement, fallback)
