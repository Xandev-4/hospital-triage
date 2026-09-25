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

---

## 6. Audit Repository — Single Write-Path Architecture (`src/modules/audit/audit.repository.ts`)

### Security Rationale & Timestamp Immutability
Per `docs/triage-assistant-core-design.md Section 10` and `api-contract.md §8`:
1. **Single Write Path**: Direct queries to `db.insert(auditLog)` across arbitrary services create fragmentation, risk missing events, and open vectors for audit log corruption. `audit.repository.ts:insertAuditEvent` is established as the sole write path in the codebase.
2. **Strict Timestamp Immutability**: `insertAuditEvent` refuses caller-supplied timestamps (`createdAt` is excluded from parameters). Every entry strictly relies on PostgreSQL's `now()` default, preventing backdating, chronological tampering, or history reordering.
3. **Nullable `case_id`**: Supports non-case audit events (e.g. `patient_search`, `patient_created`) where no triage case exists.
4. **Transaction Support**: Accepts an optional transaction executor `executor: DbExecutor = db` so atomic operations (intake creation, fallback submissions) can insert audit events within their transactions.

### Key Implementations
- **`insertAuditEvent` in `audit.repository.ts`**:
  - Implemented with `{ caseId, actorId, eventType, metadata }`.
  - Excluded `createdAt` parameter; relies exclusively on DB `now()`.
  - Returns `Promise<AuditLogEntry>` using `.returning()`.
- **Codebase-Wide Grep & Retrofit**:
  - Audited all existing `.insert(auditLog)` occurrences across the codebase.
  - Refactored `src/modules/audit/audit-logger.ts` to delegate directly to `insertAuditEvent`.
  - Refactored `src/modules/cases/cases.service.ts` (intake submission at line 210, manual fallback at line 1024) to call `insertAuditEvent(..., tx)`.
  - Confirmed via ripgrep that `audit.repository.ts` is now the only file in `src/` calling `.insert(auditLog)`.
- **Automated Verification (`tests/modules/audit/audit.repository.test.ts`)**:
  - Test 1: Insert audit event with valid `caseId` and metadata verifies DB-generated `now()` timestamp.
  - Test 2: Insert non-case audit event with `caseId === null` (`patient_search`).
  - Test 3: Insert audit event within `db.transaction(async (tx) => ...)`.
  - Registered in `tests/run-all.ts` as Step 20.

---

## 7. Audit Logger — Shared Function & Resilience Layer (`src/modules/audit/audit-logger.ts`)

### Compile-Time Safety & Resilience Design
1. **10-Event Union Type Safety**:
   - Explicitly defines `AUDIT_EVENT_TYPES` covering the exact 10 Postgres enum values:
     `consent_given`, `intake_submitted`, `ai_report_generated`, `status_changed`, `report_edited`, `risk_overridden`, `assigned`, `closed`, `patient_search`, `patient_created`.
   - Typos fail immediately at compile time, eliminating invalid or silently corrupted audit data.
2. **Fail-Open Operational Tradeoff**:
   - Operational integrity takes precedence over secondary logging. A doctor closing a case, patient submitting intake, or staff reviewing triage must never be blocked or rolled back if an audit write encounters an issue.
   - Write failures are safely caught internally and logged with a standardized, grep-friendly prefix:
     `[AUDIT WRITE FAILED] Failed to record event_type='...' actor_id='...' case_id='...': <error>`.
3. **Data Privacy & Structural Metadata Boundary**:
   - Metadata is strictly constrained to small, structural facts and delta attributes (e.g. `{ from, to }`, `{ reason }`, `{ disposition }`, `{ version_number }`).
   - Callers are explicitly documented never to pass full entity records (e.g. full patient objects) to prevent unbounded data duplication into a table with different access control.
   - Includes automatic redaction for sensitive credential keys (`password`, `passwordHash`, `token`, `secret`, `jwt`).

### Automated Verification (`tests/modules/audit/audit-logger.test.ts`)
- Test 1: Verifies all 10 canonical enum event types match the Postgres schema.
- Test 2: Happy-path audit event logging with structural delta metadata.
- Test 3: Metadata sanitization verifies sensitive credential keys are redacted to `"[REDACTED]"`.
  - Registered in `tests/run-all.ts` as Step 21.

---

## 8. Audit Read Service & Endpoint (`src/modules/audit/audit.service.ts`, `audit.routes.ts`)

### Clinical Transparency & Anti-Enumeration Architecture
Per `docs/api-contract.md §8` and `docs/triage-assistant-api-reference.md`:
1. **Row-Level Ownership & Anti-Enumeration**:
   - `patient`: Accessible only for their own case (`case.patient_id === actor.patientId`).
   - `receptionist`: Accessible only for cases they created (`case.created_by === actor.id`).
   - `doctor`: Unrestricted clinical access across all cases.
   - Non-owner callers and non-existent case IDs strictly receive `404 not_found` (never `403 forbidden`) to prevent probe-based case enumeration.
2. **Chronological Event Delivery**:
   - Events are fetched via `audit.repository.ts:getAuditEventsByCaseId` ordered chronologically ascending (`created_at ASC`).
   - Response payload conforms strictly to `api-contract.md §8`:
     `{ events: [{ event_type, actor_id, metadata, created_at }] }`.
3. **Strict Query-Only Guarantee (No Write Endpoints)**:
   - Verified that `GET /api/cases/:id/audit` is the sole endpoint exposed.
   - There are strictly no `POST`, `PUT`, `PATCH`, or `DELETE` write routes on `/audit`. All audit rows are created server-side exclusively as side effects of domain operations.
4. **Future Granularity Note**:
   - Documented in `audit.service.ts` that if future internal deliberation events are added to the audit log, case ownership may be augmented with event-type level filtering to protect internal clinician discussions.

### Key Implementations
- **`getCaseAuditTrail(caseId, actor)` in `audit.service.ts`**:
  - Implements anti-enumeration ownership matching `getConsentByCase` and `getReport`.
  - Fallback lookup to `users.patientId` if caller token lacks explicit patient profile ID.
- **`getCaseAuditTrail` Handler in `audit.controller.ts`**:
  - Unpacks params and actor context, delegating to service.
- **`auditRoutes` in `audit.routes.ts` & `cases.routes.ts`**:
  - Defined query-only route `GET /:id/audit` with `requireAuth`.
  - Mounted onto `casesRoutes` at `/api/cases/:id/audit`.
- **Automated Verification (`tests/modules/audit/audit.routes.test.ts`)**:
  - Part 1: Ownership tests (patient own case $\rightarrow$ 200, patient non-owner $\rightarrow$ 404, receptionist non-creator $\rightarrow$ 404, receptionist creator $\rightarrow$ 200, doctor $\rightarrow$ 200, non-existent $\rightarrow$ 404, unauthenticated $\rightarrow$ 401).
  - Part 2: Chronological ordering (`created_at ASC`) and exact ISO8601 string formatting verified.
  - Part 3: Paranoia test confirming `POST`, `PATCH`, and `DELETE` on `/audit` are strictly rejected with 404.
  - Registered in `tests/run-all.ts` as Step 22.

---

## 9. Comprehensive Module-by-Module Audit Retrofit & Transactional Atomicity

### Transactional Consistency vs. Fail-Open Architecture
1. **In-Transaction Audit Writes**:
   - `audit.repository.ts:insertAuditEvent` and `audit-logger.ts:logAuditEvent` accept an optional `executor: DbExecutor = db`.
   - When operations run inside a database transaction (`db.transaction(async (tx) => ...)`), passing `tx` binds the audit log insert to the exact same atomic transaction as the domain state change.
   - If the business operation fails and rolls back, the audit record rolls back with it, eliminating "phantom" audit records.
2. **Deterministic Tiebreaker Ordering**:
   - Updated `getAuditEventsByCaseId` to order by `asc(auditLog.createdAt), asc(auditLog.id)`.
   - Guarantees deterministic, reproducible chronological ordering when multiple audit events occur within the same millisecond or transaction.
3. **Module-by-Module Retrofit Audit**:
   - **Auth Module**: Confirmed zero raw writes; no retrofit needed.
   - **Consent Module**: Verified `consent_given` is captured cleanly; no raw writes.
   - **Cases Module**:
     - `intake_submitted` in `createCaseWithFiles`: retrofitted from raw insert to `logAuditEvent(..., tx)`.
     - `status_changed` in `submitManualFallback`: retrofitted from raw insert to `logAuditEvent(..., tx)`.
     - Removed raw `insertAuditEvent` and `auditLog` schema imports from `cases.service.ts`.
   - **Processing Module**:
     - `ai_report_generated` and `status_changed` in `processing.service.ts`: confirmed already using shared `logAuditEvent`.
   - **Review Module**:
     - Wrapped `overrideRiskLevel`, `approveCase`, and `closeCase` in `db.transaction(async (tx) => ...)`.
     - Pass `tx` into `logAuditEvent(..., tx)` for `risk_overridden`, `assigned`, and `closed`.
     - Moved `report_edited` audit logging inside the transaction block with `tx`.

### Full Lifecycle Verification (`tests/modules/review/review-full-loop.test.ts`)
- Re-tested the complete end-to-end case lifecycle (`created → processed → reviewed → closed`):
  1. `intake_submitted` (Patient creates case)
  2. `status_changed` (`submitted` $\rightarrow$ `queued`)
  3. `ai_report_generated` (Processing engine emits clinical report)
  4. `status_changed` (`queued` $\rightarrow$ `queued` rules run)
  5. `report_edited` (Doctor edits report content)
  6. `risk_overridden` (Doctor overrides risk level with justification)
  7. `assigned` (Doctor approves case $\rightarrow$ transitions `queued` $\rightarrow$ `assigned`)
  8. `closed` (Doctor closes case $\rightarrow$ transitions `assigned` $\rightarrow$ `closed`)
- Direct HTTP verification of `GET /api/cases/:id/audit`:
  - Exactly 8 events returned in stable, ascending chronological sequence.
  - Ownership checked for both doctor and patient tokens.
- Master Test Runner (`npx tsx tests/run-all.ts`):
  - **All 22 test suites passed successfully with 0 failures** across the entire codebase in 240.77s.






