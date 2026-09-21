# Work Log — Multimodal Healthcare Triage Assistant (21-09-26)

Running log of decisions and progress. Newest entries at the top.

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
