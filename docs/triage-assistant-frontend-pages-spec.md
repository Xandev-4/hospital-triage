# Multimodal Healthcare Triage Assistant — Frontend Page Spec (V1)

Page-by-page breakdown of what each role actually sees and can do. Scoped to V1 per the roadmap — V2/V3-only features are called out separately at the bottom so they don't get accidentally built early.

---

## Shared Pages (all roles pass through these)

### 1. Language Picker (shown right after opening the app, before Landing Page)

- Asks the user to choose their language; English is the pre-selected default
- Selection drives client-side i18n for everything downstream; translation via Indian language models (Bhashini/IndicTrans2)
- Choice can be changed later from a persistent toggle (see Cross-Cutting Components) — this first screen isn't a one-time lock-in

### 2. Landing Page

- Project name/logo, one-line pitch ("AI-assisted triage, human-reviewed")
- "Log in" and "Sign up" buttons
- Non-diagnostic disclaimer visible somewhere on this page (not just at intake) — sets expectations before anyone even logs in

### 3. Login Page

- Email/username + password fields
- "Log in" button → `POST /api/auth/login`
- Error state: invalid credentials (generic message, don't reveal whether email exists)
- On success: `GET /api/auth/me` → redirect based on role (patient → dashboard, doctor → queue, receptionist → dashboard)

### 4. Signup Page

- **Patient only** — no role selector (per the finalized contract, staff are seeded, not self-registered)
- Fields: name, email, password, confirm password
- `POST /api/auth/register`
- On success: auto-login or redirect to login page with a success message

---

## Patient Pages

### 5. Patient Dashboard (home after login)

- On load: `GET /api/cases` (own cases only, server-filtered)
- Greeting + quick status of their most recent case (if any): "Your last case: Queued — submitted 2 hours ago"
- Primary CTA: "Start a new case" button
- List/cards of past cases with status badges (submitted, processing, queued, manual_fallback, assigned, closed)
- Clicking a case → Case Status Page (`GET /api/cases/:id`)

### 6. Consent Page

- Explains what data is collected and why, in plain language
- Policy version shown/linked
- Checkbox: "I consent to my information being processed for triage"
- "Continue" button → `POST /api/consent` (`given_by: "self"`, only enabled once checkbox is checked)
- This page is a hard gate — the intake form is not reachable without passing through here first

### 7. Intake Form Page ("New Case")

- Non-diagnostic disclaimer shown again here (V1 requirement: shown at both pre-intake and on report) — `GET /api/disclaimer` if not hardcoded
- Text field: chief complaint / describe symptoms (free text, required)
- Two modality options, **at least one required** alongside text:
  - Voice recorder widget
  - Image/OCR upload widget
  - File type/size validation client-side, mirrored server-side
  - Upload/recording progress indicator
- "Submit" button → `POST /api/cases`, then `POST /api/cases/:id/upload` for whichever file(s) were attached
- On submit: server auto-triggers `POST /api/cases/:id/process` internally (no frontend call) — redirect to Case Status Page, which begins polling `GET /api/cases/:id` for the transition out of `processing`

### 8. Case Status Page

- On load: `GET /api/cases/:id`
- While `status = processing`: page polls `GET /api/cases/:id` on an interval (e.g. every few seconds) until it transitions to `queued` or `manual_fallback` — server-side `POST /api/cases/:id/process` runs automatically on submit/upload, there is no user-facing "process" action or button
- Current status badge, large and clear (submitted / processing / queued / manual_fallback / assigned / closed)
- Plain-language explanation under the badge ("A doctor is reviewing your case" / "We need a bit more information from you")
- If `status = manual_fallback`: inline form appears here (see below) instead of a separate page
- If `status = closed`: shows the final note/outcome the doctor approved (read-only) — `GET /api/cases/:id/report`
- Timestamps: submitted at, last updated at
- Consent record link/expandable section — `GET /api/consent/:caseId`
- Audit trail (see Cross-Cutting Components) — `GET /api/cases/:id/audit`

### 9. Manual Fallback Form (inline component on Case Status Page, shown conditionally)

- Explains briefly why it appeared: "We couldn't automatically read your submission — please fill this in"
- Structured fields: chief complaint, duration, symptoms, vitals (manual entry, same fields AI would have extracted)
- "Submit" button → `PATCH /api/cases/:id/manual-fallback`
- On submit: status flips back to `queued`, form disappears, normal status view resumes

---

## Receptionist Pages

Same shape as the patient flow, but "assisted" — every action is done on behalf of a walk-in patient.

### 10. Receptionist Dashboard

- On load: `GET /api/cases` (server-filtered to cases this receptionist created)
- "Create new case for a patient" primary CTA
- List of cases _this receptionist created_, with status badges (not all patients' cases — row-level ownership)
- Search/filter by patient name (useful at a real front desk)

### 11. Patient Lookup / Selection Step

- Search existing patient by name/ID: `GET /api/patients/search?q=` (receptionist-only, new endpoint — not in the original reference doc, added here to close the gap)
- "Register new patient" inline: `POST /api/patients` (receptionist-only, new endpoint — deliberately **not** `POST /api/auth/register`, since that creates a login-capable account with a password; a walk-in patient record is a person, not a login. Fields: name, contact info — no password/email required)
- Both endpoints touch the `patients` table directly, so both need audit log entries per the core design's rule that direct patient-table access is logged — add `patient_search` and `patient_created` as audit event types
- This determines whose `patient_id` consent and the case will be tied to

### 12. Consent Page (assisted variant)

- Same as patient's consent page, but framed as "Confirm the patient has consented"
- `POST /api/consent` with `given_by: "staff"`, `staff_id` set automatically from the logged-in receptionist
- Optional: patient signs/confirms on a shared screen or verbally, receptionist checks a box

### 13. Intake Form Page (assisted variant)

- Identical to patient's intake form, filled in by the receptionist on the patient's behalf
- Same disclaimer, same modality upload, same submit → `POST /api/cases`, then `POST /api/cases/:id/upload` if a file was attached

### 14. Case Status Page (assisted variant)

- On load: `GET /api/cases/:id`
- Same as patient's, but for cases this receptionist created
- Same manual-fallback form appears here if triggered — `PATCH /api/cases/:id/manual-fallback`
- Audit trail — `GET /api/cases/:id/audit`

---

## Doctor Pages

### 15. Doctor Queue Page (home after login)

- On load: `GET /api/queue`
- Table/list of cases, sorted by risk level (critical → high → medium → low)
- Columns: patient (or anonymized ID), chief complaint (truncated), risk tag, time submitted, status
- Risk tag shown as a colored badge
- Row click → Case Review Page (`GET /api/cases/:id/review`)
- Filter/sort controls: by status, by risk level, by date
- Empty state: "No cases in queue"

### 16. Case Review Page

- On load: `GET /api/cases/:id/review`, `GET /api/cases/:id/report`, `GET /api/cases/:id/report/versions`
- Full case detail:
  - AI-generated structured report: chief complaint, duration, symptoms, vitals
  - Per-field source indicator (AI-derived vs manually entered, from the fallback path)
  - Rules-engine risk tag, shown separately from any AI-suggested risk read
  - **AI/rules disagreement flag** if present — visually distinct (e.g. warning banner): "AI suggested X, rules engine flagged Y — rules result applies"
  - Missing-information list, clearly called out
  - Uploaded modality (audio player or image viewer, if applicable)
- Actions available on this page:
  - **Edit summary** — inline editable text area; saving creates a new version (`PATCH /api/cases/:id/edit`); original AI version stays viewable via a "view original" toggle or version history link
  - **Override risk level** — dropdown/selector, requires a reason field before it can be submitted (`PATCH /api/cases/:id/risk-level`)
  - **Approve** — confirms the case as reviewed, sets `assigned` (`POST /api/cases/:id/approve`)
  - **Close** — closes the case (`POST /api/cases/:id/close`)
- Version history panel (from `GET /api/cases/:id/report/versions`): list of versions with source (ai / doctor_edit), timestamp, editor — expandable to see each version's content

### 17. Failure Case View (state, not a separate page)

- If a case's processing failed (Demo Scenario D), this shows plainly on the Case Review Page rather than looking like a normal case — a distinct banner: "Processing failed — reviewed data may be incomplete" so the doctor knows to treat it carefully. Never silently hidden or retried invisibly.

---

## Cross-Cutting / Small Components (appear on multiple pages)

- **Disclaimer banner** — reusable component, shown pre-intake and on any report/result view — `GET /api/disclaimer` (optional; can be hardcoded frontend-side instead)
- **Status badge** — reusable component mapping each state to a color/label, used on dashboards, status pages, and the queue — driven by whatever `status` comes back from `GET /api/cases/:id`, `GET /api/cases`, or `GET /api/queue`
- **Audit trail view** — a simple expandable/collapsible list on the Case Status Page (patient/receptionist, own case) and Case Review Page (doctor) showing timestamped events: consent given, intake submitted, AI report generated, edits, assignment, closure — `GET /api/cases/:id/audit`
- **Language toggle** — persistent control (nav/header), lets the user change from their initial Language Picker choice at any time; English is default, translation via Indian language models (Bhashini/IndicTrans2); no dedicated endpoint, drives client-side i18n only
- **Logout control** — in the nav/header on every authenticated page; clears the local token client-side, no server call for V1 (`POST /api/auth/logout` exists in the reference doc but isn't wired up unless server-side token blacklisting is added later)

---

## Explicitly NOT in V1 (so nobody builds it early)

- Facility picker / multi-tenancy UI (V2)
- Coordinator-specific pages or a coordinator role in the queue (V2 — folded into Doctor for V1)
- Critical-case escalation banners/alerts beyond the basic risk badge (V2)
- Full multi-language rollout beyond the V1 language picker (V2 — V1 ships the picker + English default + Indian-model translation; more languages are additive later)
- Auto-drafted referral note UI (V2)
- Real-time live queue updates via sockets (V2 — V1 can just poll or refresh manually)
- Follow-up scheduling UI, "set follow-up" checkbox (V3)
- Offline-first intake / local queueing (V3)
- Admin role, facility management UI (V3)
- Full filterable audit-log viewer page (V3 — V1 only needs the simple inline view above)
- Consent withdrawal / "revoke consent" action (V3 — status exists structurally, no UI yet)
- Monitoring dashboard for API/fallback health (V3)
