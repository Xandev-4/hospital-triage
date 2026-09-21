# Work Log — Multimodal Healthcare Triage Assistant (21-09-26)

Running log of decisions and progress. Newest entries at the top.

---

## Entry — Step 22: Comprehensive End-to-End & Security Test Suite

**What was done:**

Executed and documented full end-to-end HTTP integration testing against the live server on port 8000, explicitly covering positive flows and critical security edge cases (anti-enumeration, mode symmetry, expired consent):

### 1. Test Matrix & Results

| #     | Test Scenario                             | Request & Payload                                                         | Expected Result                        | Actual Result                                 | Security / Spec Objective                                                 |
| ----- | ----------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| **1** | **Case Creation without Consent**         | `POST /api/cases`<br>`{"chief_complaint": "fever and headache"}`          | `403 consent_required`                 | `403` `{"error":{"code":"consent_required"}}` | Strict consent gating: cannot touch `triage_cases` without valid consent. |
| **2** | **Record Fresh Consent**                  | `POST /api/consent`<br>`{"given_by": "self", "policy_version": "v1.0"}`   | `201 Created`<br>30m validity          | `201` `valid_until: +30min`                   | Patient self-consent recorded in Neon.                                    |
| **3** | **Case Creation with Active Consent**     | `POST /api/cases`<br>`{"chief_complaint": "fever and headache"}`          | `201 Created`<br>`status: "submitted"` | `201` `{"status":"submitted", "mode":"self"}` | Case successfully linked to active consent row.                           |
| **4** | **Retrieve Case (Legitimate Owner)**      | `GET /api/cases/:id`<br>Patient 1 Token                                   | `200 OK`<br>Full case object           | `200 OK`<br>Exact case match                  | Proper authorized access for patient owner.                               |
| **5** | **Anti-Enumeration Ownership Protection** | `GET /api/cases/:id`<br>Patient 2 Token (Non-owner)                       | `404 not_found`<br>_(NOT 403)_         | `404` `{"error":{"code":"not_found"}}`        | Privacy protection: prevents leaking case ID existence to other patients. |
| **6** | **Expired Consent Gating**                | `POST /api/cases`<br>(Consent timestamp set to 35m ago)                   | `403 consent_required`                 | `403` `{"error":{"code":"consent_required"}}` | Temporal safety: consent strictly expires after 30 minutes.               |
| **7** | **Submission Mode Mismatch**              | `POST /api/cases`<br>Receptionist submits assisted case with self-consent | `403 consent_required`                 | `403` `{"error":{"code":"consent_required"}}` | Mode symmetry: assisted intake strictly requires staff-recorded consent.  |

All 7 automated tests passed with 100% compliance against `docs/api-contract.md`.

---

## Entry — Cases HTTP Controllers & Routes Implementation (Step 21)

**What was done:**

- Implemented `src/modules/cases/cases.controller.ts`:
  - `createCase`: Express 5 handler delegating to `casesService.createCase(req.body, req.user)` returning `201 Created`.
  - `getCaseById`: Handler delegating to `casesService.getCaseById(req.params.id, req.user)` returning `200 OK`.
  - `listCases`: Handler parsing `req.query.status` and delegating to `casesService.listCases(req.user, filters)` returning `200 OK`.
- Implemented `src/modules/cases/cases.routes.ts`:
  - Enforced defense-in-depth role restriction on `POST /api/cases`: `requireAuth` + `requireRole("patient", "receptionist")` (strictly blocking doctors at the route layer).
  - Wired `GET /api/cases/:id` and `GET /api/cases` behind `requireAuth`.
- Mounted `casesRoutes` in `src/app.ts` under `/api/cases`.
- Live HTTP verification via curl against dev server on port 8000:
  - `POST /api/cases` with patient JWT created case and returned `201 Created` with `case_id`, `status: 'submitted'`, `consent_id`, and `mode: 'self'`.
  - `GET /api/cases/:id` returned `200 OK` with complete case details.
  - `GET /api/cases` returned `200 OK` with patient-filtered list.

---

## Entry — Cases Service Core Logic Implementation (Step 20)

**What was done:**

- Implemented `src/modules/cases/cases.service.ts`:
  - `createCase`: Order-strictly validates consent first via `checkValidConsent(resolvedPatientId, mode)`, failing closed with `403 consent_required` before touching `triage_cases`. Enforces server-side resolution of `patientId` for self-mode from `users.patientId` (never trusting client-provided `patient_id` or `created_by`). Enforces length limits on free-text inputs (`chief_complaint <= 1000`, `symptoms <= 5000`, `duration <= 100`). Inserts case with initial status `'submitted'`.
  - `getCaseById`: Implements strict row-level ownership checking (patient can only view own cases, receptionist can only view cases they created, doctor has queue-wide access). Returns anti-enumeration `404 not_found` on unauthorized access attempts.
  - `listCases`: Applies caller role-based filtering (patient sees only their cases, receptionist sees created-by-them, doctor sees all queue-eligible cases) with optional status filtering and truncation of `chief_complaint` per contract.
- Verified in isolation against Neon database with live test script covering consent requirement, valid creation, anti-enumeration ownership protection, list filtering, and length limit enforcement.

---

## Entry — Case State Machine Implementation (Step 19)

**What was done:**

- Implemented `src/modules/cases/cases.state-machine.ts` encoding the state transition graph from `docs/api-contract.md §11`:
  - `submitted` → `processing`
  - `processing` → `queued` | `manual_fallback`
  - `manual_fallback` → `queued`
  - `queued` → `assigned`
  - `assigned` → `closed`
  - Blocked all transitions out of `closed` (terminal state) and blocked all incoming/outgoing transitions for `withdrawn` (reserved for V3).
- Implemented `assertValidTransition(from, to)` throwing `AppError.invalidStateTransition()` (`409`) on any illegal status transition.
- Included an explicit truth-table header comment to prevent accidental bidirectional or erroneous mappings.
- Verified in isolation via unit assertions covering all 6 legal transitions and 8 illegal transitions (including reverse and withdrawn attempts).

---

## Entry — Consent Module Implementation & HTTP Verification (Steps 15–17)

**What was done:**

- Implemented `src/modules/consent/consent.service.ts`:
  - `giveConsent`: Validates `patient_id`, `policy_version`, and `given_by` (`self` | `staff`). Enforces app-level constraint that `staff_id` is required if `given_by === "staff"` and forced to `null` if `"self"`. Inserts row and returns envelope with computed `valid_until` (+30m).
  - `checkValidConsent`: Queries latest consent for a patient, verifies submission mode alignment (`self` mode requires `given_by === "self"`, `assisted` mode requires `given_by === "staff"`), enforces the 30-minute validity window, and fails closed with `AppError.consentRequired()` (`403`).
  - `getConsentByCaseId`: Audits consent for a given case via `triage_cases.consentId` foreign key, adhering to role access matrix and anti-enumeration rules.
- Implemented `src/modules/consent/consent.controller.ts`:
  - `createConsent`: Authorizes caller role:
    - **Self-Consent**: Strictly resolves `patient_id` server-side from `req.user.id` -> `users.patientId`. Never trusts a client-provided `patient_id`; rejects ID tampering attempts with `403 forbidden`.
    - **Staff Consent**: Receptionist records consent on behalf with `staff_id` auto-set server-side from JWT (`currentUser.id`).
    - **Doctors / Others**: Rejected with `403 forbidden`.
  - `getConsent`: Retrieves case consent with anti-enumeration protection.
- Implemented `src/modules/consent/consent.routes.ts`:
  - Exposed `POST /api/consent` and `GET /api/consent/:caseId` behind `requireAuth`.
- Mounted `consentRoutes` in `src/app.ts` under `/api/consent`.
- Live HTTP verification via curl against dev server on port 8000:
  - Authenticated as patient and submitted `POST /api/consent` with `given_by: "self"`. Confirmed server-side `patient_id` resolution (even when omitted in body).
  - Attempted ID tampering with someone else's UUID; confirmed immediate `403 forbidden` rejection.
  - Queried Neon database directly, verifying row persistence, correct `given_at`, `patient_id`, and `staff_id: null`.
