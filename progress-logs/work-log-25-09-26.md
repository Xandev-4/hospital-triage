# Work Log — Multimodal Healthcare Triage Assistant (25-09-26)

Summary of features built, security patterns enforced, and end-to-end verification completed on September 25, 2026.

---

## 1. Case Consent Retrieval Endpoint (`src/modules/consent/`)

### Architecture & Anti-Fishing Design
Per `docs/api-contract.md §2`, looking up patient consent must not expose an unauthenticated or arbitrary query vector that allows probing for another patient's consent records. 

### Key Implementations
- **`getConsentByCase(caseId, actor)` in `consent.service.ts`**:
  - **Ownership Gate**: Evaluates case ownership before touching consent records:
    - `patient`: Caller's `patient_id` must match `case.patient_id`.
    - `receptionist`: Caller's `user.id` must match `case.created_by`.
    - `doctor`: Unrestricted clinical access.
  - **Anti-Enumeration (`404 not_found`)**: If the case does not exist or caller does not have ownership, returns `404 not_found` (never `403 forbidden`) to prevent case ID enumeration.
  - **Foreign Key Traversal**: Resolves consent via `case.consent_id` foreign key rather than searching by `patient_id`, preventing unauthorized cross-record probing.
  - **Response Payload**: Matches contract specification `{ consent_id, patient_id, given_by, staff_id, policy_version, given_at }`.
- **Route & Controller Wiring**:
  - Mounted `GET /api/consent/:caseId` with `requireAuth` in `consent.routes.ts`.
- **Verification**:
  - Verified in `tests/modules/consent/consent.test.ts` covering patient ownership, receptionist creator matching, doctor universal access, and anti-enumeration 404 responses.

---

## 2. Manual Fallback Pipeline (`src/modules/cases/`)

### Clinical Rationale & Safe Recovery
When AI extraction fails (malformed input, upstream timeout, or low-confidence classification < 0.65), cases transition to `manual_fallback`. To prevent patient drop-off while maintaining clinical safety, human-entered fallback data must be rigorously validated and run through the deterministic rules engine.

### Key Implementations
- **`submitManualFallback` in `cases.service.ts`**:
  - **Strict Status Guard**: Only cases currently in `manual_fallback` status are accepted; all other statuses are rejected with `409 invalid_state_transition`.
  - **Ownership Order & Anti-Enumeration**: Ownership check executes before disclosing state transitions to prevent leaking whether an unauthorized case is in fallback state.
  - **Rigorous Input Validation**: Manually-entered vitals undergo physiological boundary validation (e.g., heart rate 20–300 bpm, SpO2 50–100%, systolic BP 40–300 mmHg).
  - **Versioned Record Insertion**: Inserts a new row into `case_report_versions` with `source: 'manual'`, preserving full structured field history with per-field `{ value, source: 'manual' }`.
  - **Rules Engine Re-Execution**: Deterministic rules engine runs against the manual input to compute the final verified `risk_level` and identify triggered safety rules.
  - **Atomic State Transition**: Transitions status `manual_fallback -> queued` with concurrency idempotency guard, updating top-level search columns and emitting `status_changed` audit logs.
- **Route & Controller**:
  - Mounted `PATCH /api/cases/:id/manual-fallback` with `[requireAuth, requireRole("patient", "receptionist")]`.
- **Verification (`tests/modules/cases/cases-manual-fallback.test.ts`)**:
  - Validated double-submission idempotency, role guarding, physiological vitals constraints, and full failure-recovery loop (`bad input -> manual_fallback -> rules re-run -> queued -> doctor queue`).

---

## 3. Clinical Report & Version History Endpoints (`src/modules/cases/`)

### Clinical Transparency & Auditability
Doctors must be able to inspect not only the latest clinical findings, but also precisely distinguish which parts of a report were extracted by AI vs. entered manually during fallback vs. edited by a reviewing physician.

### Key Implementations
- **Field-Level Source Verification**:
  - Confirmed and unified `{ value, source: 'ai' | 'manual' | 'doctor_edit' }` representation across:
    - AI Extraction (`processing.service.ts` $\rightarrow$ `source: 'ai'`).
    - Manual Fallback (`cases.service.ts` $\rightarrow$ `source: 'manual'`).
    - Doctor Review Edits (`review.service.ts` $\rightarrow$ `source: 'doctor_edit'`).
- **`getReport(caseId, actor)` in `cases.service.ts`**:
  - Enforces airtight row-level ownership matching `getConsentByCase` (`404 not_found` for unauthorized callers).
  - Fetches the latest version from `case_report_versions` and normalizes fields to ensure contract-exact payload:
    `case_id`, `status`, `chief_complaint`, `duration`, `symptoms`, `vitals` (with per-field `{ value, source }`), `missing_info`, `risk_level`, and `ai_rules_disagreement`.
  - Provides graceful fallback for cases without versions yet (defaults to `source: 'manual'`).
  - Retains backwards-compatible alias `getCaseReport = getReport`.
- **`getReportVersions(caseId, actor)` in `cases.service.ts` (Doctor-Only)**:
  - Enforces doctor-only role check (`403 forbidden` for patient/receptionist).
  - Queries all `case_report_versions` for the case, ordered ascending by `version_number` (`1 → N`).
  - **Single-Version Cases**: For cases that have never been edited, cleanly returns an array with one version item (`[{ version_number: 1, ... }]`) rather than an error or null.
  - **Multi-Version Cases**: Accurately tracks progression (e.g. `v1: ai` followed by `v2: manual` or `v2: doctor_edit`).
- **Route Mounting in `cases.routes.ts`**:
  - Mounted `GET /api/cases/:id/report/versions` with `[requireAuth, requireRole("doctor")]` before `/:id/report`.
  - Mounted `GET /api/cases/:id/report` with `requireAuth` (ownership gate in service).

### Automated Verification (`tests/modules/cases/cases-report.test.ts`)
- Part 1: `GET /api/cases/:id/report`:
  - Patient fetching own report: `200 OK` with field-level `{ value, source: 'ai' }`.
  - Patient fetching other patient's report: `404 not_found` (anti-enumeration).
  - Receptionist fetching other creator's report: `404 not_found`.
  - Receptionist fetching own created report: `200 OK`.
  - Doctor fetching any case report: `200 OK`.
  - Non-existent case ID: `404 not_found`.
  - Case with no versions yet: `200 OK` fallback.
- Part 2: `GET /api/cases/:id/report/versions`:
  - Direct calls with patient token: `403 forbidden`.
  - Registered in `tests/run-all.ts`: **All 18 test suites passing 100%**.

---

## 4. Missing-Info Detection & Signal Separation (`src/modules/processing/`)

### Clinical Rationale & Distinct Failure Modes
Per `core-design.md Section 8` ("missing-info detection via checklists"):
1. **Missing Info vs. Malformed Info Distinction**:
   - Genuinely absent info (patient never provided a duration or vitals were unmeasured) must trigger specific checklist follow-up questions (`missing_info: ["duration", "vitals", ...]`).
   - Malformed/garbage input (e.g. `duration = "the color blue"`) must NOT be treated as missing info, nor must it silently pass truthiness checks (`if (duration)`) and evade duration guards. It is flagged as an anomaly (`anomaliesDetected: ["malformed_duration: ..."]`) and triggers `RR-ANOMALY-01`, failing closed to a `medium` risk floor.
2. **Fixed Canonical Enum Keys**:
   - `missing_info` entries are strictly constrained to canonical enum-like keys: `"duration"`, `"vitals"`, `"symptoms"`, `"peak_temperature"`, `"spo2_reading"`, `"bp_reading"`, `"blood_sugar_reading"`, `"heart_rate"`, `"onset_speed"`, `"severity"`, `"radiation"`, `"location"`, `"pregnancy_status"`.
   - Prevents arbitrary, noisy free text from breaking frontend follow-up prompt renderers.

### Key Implementations
- **`validateDuration` & `detectMissingInfoFromChecklists` in `rules-engine.ts`**:
  - Differentiates `"absent"` (null/empty/unspecified), `"valid"` (matches temporal patterns/keywords), and `"malformed"` (present string with zero temporal semantics).
  - Malformed inputs trigger anomaly detection and fail-closed safety floor (`medium`).
  - Evaluates Section 8 checklists for chest pain, shortness of breath, fever, abdominal pain, neurological, pediatric, and pregnancy presentations.
- **AI Extraction & Rules Engine Integration (`ai-extraction.ts` & `processing.service.ts`)**:
  - Combined `extractedData.missingInfo` and `evaluatedRisk.missingCriticalInfo` into deduplicated canonical list.
  - Persisted into `case_report_versions.content.missing_info` and exposed directly in `GET /api/cases/:id/report`.
- **Automated Verification (`tests/modules/cases/cases-report.test.ts`)**:
  - Test 1.8: Incomplete intake (omitted duration & vitals) yields `["duration", "vitals", ...]` in `missing_info` via `GET /api/cases/:id/report`.
  - Full suite passed: 18 test suites, 0 failures.

---

## 5. Non-Diagnostic Disclaimer Endpoint (`src/app.ts`, `docs/api-contract.md §9`)

### Clinical Rationale & Compliance
Per `docs/spec.md`, `docs/triage-assistant-core-design.md`, and `docs/api-contract.md §9`:
The system is explicitly non-diagnostic. Rather than requiring the frontend to hardcode legal/clinical disclaimers in client bundles, `GET /api/disclaimer` exposes the canonical non-diagnostic notice via an unauthenticated, zero-DB endpoint. This ensures single-source-of-truth text management across pre-intake, patient reports, and physician review views.

### Key Implementations
- **`GET /api/disclaimer` in `src/app.ts`**:
  - Unauthenticated, static response matching `api-contract.md §9`: `{ "text": "..." }`.
  - Exports `NON_DIAGNOSTIC_DISCLAIMER_TEXT` constant containing the explicit non-diagnostic notice, human provider primacy, and scope boundary.
- **Automated Verification (`tests/modules/disclaimer/disclaimer.test.ts`)**:
  - Test 1: Unauthenticated `GET /api/disclaimer` returns `200 OK` with `{ text }`.
  - Test 2: Semantic check verifying "non-diagnostic", "organizes information / triage", and human medical provider authority.
  - Test 3: `GET /api/health` sanity check returns `200 OK` `{ status: "ok" }`.
- **Master Test Runner Integration**:
  - Registered in `tests/run-all.ts`: **All 19 test suites passed 100% (262.62s)**.


