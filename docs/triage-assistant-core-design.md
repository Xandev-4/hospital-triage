# Multimodal Healthcare Triage Assistant — Core Design

_Hackathon Problem Statement 3: Multimodal Healthcare Triage Assistant for Government and Institutional Health Facilities_

## Contents

1. Project Overview
2. User Roles
3. Architecture
4. End-to-End Flow
5. Case Status State Machine
6. Critical-Case Escalation
7. Risk Rules Definition
8. Missing-Info Detection Logic
9. Intake UI: Patient vs Receptionist
10. Audit Logging
11. AI vs Human Responsibility
12. Handling AI/OCR Failure
13. Language Handling
14. Data Retention
15. Grading Alignment (for reference)
16. Role-Based UI Implementation
17. File Storage & Security
18. PII Handling in External API Calls
19. Failure Handling & Reliability
20. Scaling Assumption
21. Multi-Tenancy
22. Facility Selection (Patient Side)
23. API Design
24. Third-Party Dependency Risk
25. Notifications
26. Monitoring vs. Audit Log
27. Environment & Secrets Management
28. Testing Strategy
29. Follow-Up Scheduling (Maternal-Health & Chronic-Disease Scenarios)
30. Open Items

---

## 1. Project Overview

A human-in-the-loop healthcare triage assistant for government hospitals, PHCs, health camps, company clinics, industrial-estate health units, and campus health centers. It summarizes patient-provided symptoms, uploaded reports, and basic visual inputs into a structured triage note for qualified review.

**Non-negotiable constraint:** the system is explicitly **non-diagnostic**. It organizes information and highlights urgency signals — it never prescribes treatment or replaces a qualified professional.

**Disclaimer placement:** the non-diagnostic disclaimer is shown in three places — before intake starts, on the AI-generated report itself, and in the doctor's review view — so the constraint is visible at every point a person interacts with AI output, not just stated once in an about page.

## 2. User Roles

| Role                                         | Function                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| **Patient**                                  | Data intake — from home (self-service)                                            |
| **Receptionist**                             | Data intake — assisted, from hospital                                             |
| **Triage Coordinator** (nurse/OPD in-charge) | Reviews AI-tagged queue, makes the actual human assignment to a doctor            |
| **Doctor**                                   | Receives assigned case, reviews structured note, treats, may escalate to referral |
| **Admin** (optional)                         | Manages facility, users, audit logs                                               |

## 3. Architecture

- Single backend: Express + PostgreSQL
- Single JWT-based auth system; `role` field determines access and UI
- Role-based middleware protecting API routes (e.g. `requireRole('coordinator')`)
- One shared intake UI component for patient and receptionist, differentiated by a `mode` flag (`self` vs `assisted`)

## 4. End-to-End Flow

1. **Consent capture** — must happen before any data is collected. Logged with `given_by` (self/staff), policy version, timestamp.
2. **Intake** — patient (home) or receptionist (hospital, assisted) submits symptoms via text/voice, and/or uploads a report/image for OCR.
3. **AI report generation** — OCR (if applicable) → translation (if needed) → LLM summarization into a structured note (chief complaint, timeline, missing info, follow-up questions) → rules-based risk tagging (kept separate from the LLM for explainability) → suggested department tag. Output is explicitly marked advisory, never diagnostic.
   - **Image scope:** "basic visual inputs" covers more than document OCR — patients may also upload a symptom photo (e.g. a rash or wound). The AI describes visible features into the note as a plain description, explicitly flagged **unverified/non-diagnostic**; it never attempts to identify a condition from the image.
4. **Department queue** — cases sorted by risk level within a department, not assigned to any specific doctor by the AI.
5. **Coordinator review** — a human (triage coordinator/OPD in-charge) reviews the queue and manually assigns a specific doctor, based on real-world factors (availability, specialty match, load) the AI cannot see. Coordinator may edit the AI summary (versioned, original preserved) or change the risk level — any risk-level change requires a stated reason.
6. **Doctor review** — doctor sees only their assigned queue, reviews the note, and takes clinical action outside the system's scope. Marks the case closed or needing referral.
7. **Referral (optional)** — if escalation is needed, a referral note is auto-drafted from the existing AI summary + doctor's notes, reviewed and sent by the doctor.

Audit logging runs alongside every stage (see Section 10).

## 5. Case Status State Machine

Every case holds a concrete `status` field — a coordinator's queue view is just `WHERE status = 'queued'`, and the audit log needs a real, constrained value to log transitions of.

**Status values:**

- `submitted` — intake received, not yet processed
- `processing` — AI/OCR/translation pipeline running
- `manual_fallback` — AI/OCR couldn't extract cleanly; patient/receptionist filled data manually (Section 12)
- `queued` — AI report complete, sitting in the department queue awaiting a coordinator
- `assigned` — coordinator has assigned the case to a specific doctor
- `closed` — doctor has reviewed and finished with it
- `referred` — doctor escalated to a higher facility
- `withdrawn` — patient revoked consent; the case is marked `withdrawn` and excluded from active review queues

**Note on follow-up cases:** a case originating from a scheduled reminder (Section 29) is **not** a separate status. It's tagged via a distinct `case_type` field (`walk_in` vs. `follow_up`) and otherwise runs through this exact same status sequence like any other case — `case_type` records _why_ the case exists, `status` records _where_ it currently is in the review pipeline.

**Allowed transitions:**

```
submitted → processing
processing → queued              (AI/OCR succeeded)
processing → manual_fallback     (AI/OCR failed / low confidence)
manual_fallback → queued         (human filled it in, ready for review)
queued → assigned
assigned → closed
assigned → referred
[submitted, processing, queued, assigned] → withdrawn   (consent pulled)
```

Explicitly listing allowed transitions (not just the possible values) prevents invalid jumps — e.g. a case moving straight from `submitted` to `closed`, skipping human review entirely. Enforcing this at the transition level is what makes "a human always decides" (Section 11) a rule the system actually enforces, not just a UI convention.

**Implementation:**

- Postgres: a `status` column, either a `CHECK` constraint on `TEXT`, or a proper `ENUM` type (`CREATE TYPE case_status AS ENUM (...)`) — the enum catches typos at the database level.
- All status changes go through a single backend function (e.g. `transitionStatus(case, newStatus)`) that validates the transition is legal before writing — no endpoint should overwrite `status` directly.
- Every successful transition through that function is the trigger point for the corresponding audit log entry (Section 10).

## 6. Critical-Case Escalation

A CRITICAL case sitting at the top of a sorted list is only as urgent as the next time someone happens to check that list — sorting it higher is not the same as handling it urgently.

**Two parts:**

1. **Bypass** — a CRITICAL case does not simply sort to the top of the normal `queued` list; it's immediately surfaced to the coordinator's active view the moment the tag fires, skipping passive queue placement.
2. **Alert** — an active interrupt, not something the coordinator has to notice on their own:
   - **Visual:** a distinct, unmissable treatment (e.g. red banner/pulsing highlight), separate from the normal HIGH/MEDIUM/LOW badge styling
   - **Audio:** a sound plays in the coordinator's dashboard the moment the tag fires, since a coordinator managing a busy queue may not be looking at the screen
   - **Real-time push, not poll:** delivered instantly via the same real-time channel used for general dashboard updates (Socket.IO), not on the coordinator's next manual refresh

**Implementation:**

- A dedicated event, `case_critical_alert`, fired the instant a case's risk tag transitions to CRITICAL — hooked into the same state-machine transition point defined in Section 5, and logged via the same audit mechanism (Section 10).
- The coordinator's dashboard subscribes to this event specifically (not just the general queue-updated event), rendering the distinct visual and sound.
- **Explicit acknowledgment rule:** a CRITICAL alert remains visibly flagged until a coordinator actively acknowledges it (e.g. by opening the case) — it doesn't just flash once and disappear.

## 7. Risk Rules Definition

The actual rules behind "rules-based risk tagging" (referenced in Sections 4, 6, and 11) — a condition → risk-level mapping, not left as an unspecified black box.

**Rule format:** each rule is a simple, single condition (or a small AND of 2–3 conditions) mapped to a risk level, with a stable ID so a fired rule can be shown on the triage note (see Section 11's AI-vs-rules design) rather than just producing a bare label:

```json
{
  "id": "RR-004",
  "condition": "spo2 < 90",
  "risk_level": "CRITICAL",
  "source": "clinical reference threshold",
  "active": true
}
```

**Rule set:**

_CRITICAL_

- spo2 < 90
- unconscious / unresponsive
- active/uncontrolled bleeding
- severe difficulty breathing + blue lips/face
- seizure (ongoing or just occurred)
- severe abdominal pain + pregnancy (maternal-specific)
- chest pain radiating to arm/jaw

_HIGH_

- chest pain + sweating
- severe breathlessness (without blue lips)
- high fever (>103°F/39.4°C) + confusion
- reported blood sugar reading very low or very high (chronic-disease-specific)
- vomiting blood
- sudden vision loss or slurred speech (stroke red flag)

_MEDIUM_

- fever > 3 days
- persistent vomiting (no blood)
- moderate breathlessness on exertion only
- worsening chronic condition symptom (e.g. increased swelling for a known hypertension/diabetes patient)
- injury with visible swelling/deformity, patient can still move the area

_LOW_

- mild, localized pain, no red flags
- single-day mild fever, no other symptoms
- routine follow-up check-in, no new complaints
- no red-flag rule matched → LOW/unflagged (default)

**Where it lives:** a single static JSON/YAML file (e.g. `risk-rules.json`) in the backend codebase — not a database table, not an admin UI. Edited directly by the team.

**How it's used:** after the LLM's structured extraction (chief complaint, symptoms, vitals), the extracted data is checked against each rule using a rules-engine library (e.g. `json-rules-engine`, or plain conditionals for hackathon scope). The first/highest-severity matching rule sets the case's rules-based risk level and records which rule ID fired. This is what's compared against the AI's own risk opinion (Section 11) and what triggers the CRITICAL alert behavior (Section 6) on a CRITICAL match.

**Scope note:** rule editing/versioning/governance (who can change a rule, requiring a stated reason, audit-logging changes) is intentionally out of scope for the hackathon build — rules are static for the demo and edited directly in the file by the team, not through the running application.

## 8. Missing-Info Detection Logic

The actual method behind "the AI identifies missing information" (referenced in the structured output schema and throughout the flow) — a concrete comparison method, not an unexplained AI behavior. This directly supports "Quality of information extraction and summarization" (20% of grading — Section 15).

**Method — symptom checklists per complaint type:** for common complaint categories, define the fields a complete picture should include. Whatever the LLM's structured extraction leaves empty against that checklist becomes the `missingInformation` list, which in turn drives the `followUpQuestions` shown to the coordinator/doctor.

**Checklist set:**

| Complaint type                 | Expected fields                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fever`                        | duration, peak temperature, associated symptoms (chills, body ache, rash), recent travel, medication already taken                                                    |
| `breathing_difficulty`         | duration, spo2 reading (if available), at rest or on exertion, chest pain presence, prior respiratory history                                                         |
| `abdominal_pain`               | duration, location, severity, associated symptoms (vomiting, fever, blood in stool) — pregnancy status relevant here, ties to the maternal CRITICAL rule in Section 7 |
| `chest_pain`                   | duration, character (sharp/dull/pressure), radiation (arm/jaw/back), associated symptoms (sweating, breathlessness), triggered by exertion or at rest                 |
| `headache`                     | duration, severity, sudden vs. gradual onset, associated symptoms (vision changes, neck stiffness, vomiting), prior history of similar headaches                      |
| `injury_trauma`                | mechanism (fall, accident, blow), affected area, swelling/deformity present, able to move/bear weight, time since injury                                              |
| `skin_rash_wound`              | duration, location, spreading or stable, associated symptoms (fever, itching, pain), photo attached (yes/no)                                                          |
| `maternal_checkin`             | gestational week (if known), swelling, headache, vision changes, fetal movement noticed, bleeding/discharge                                                           |
| `chronic_diabetes_checkin`     | current blood sugar reading (if available), medication adherence, new symptoms since last visit, diet/appetite changes                                                |
| `chronic_hypertension_checkin` | current BP reading (if available), medication adherence, headache/dizziness, swelling in legs/feet                                                                    |
| `general_fatigue_weakness`     | duration, sleep pattern, appetite changes, associated symptoms (fever, weight loss), ability to perform daily activities                                              |

**How it fits the pipeline:**

1. LLM produces structured extraction (`chiefComplaint`, `symptoms`, `vitals`, etc.)
2. `chiefComplaint` is matched to a complaint category
3. The matching checklist is looked up and compared against the extraction
4. Empty expected fields populate `missingInformation`
5. Missing fields drive the `followUpQuestions` surfaced to the reviewer

**Where it lives:** same pattern as the risk rules (Section 7) — a static file, e.g. `symptom-checklists.json`, mapping complaint category → expected fields. Not a database table, not admin-editable for the hackathon; the team edits the file directly.

## 9. Intake UI: Patient vs Receptionist

One shared `IntakeForm` component, with a `mode` prop:

| Aspect        | Patient (self)                          | Receptionist (assisted)                               |
| ------------- | --------------------------------------- | ----------------------------------------------------- |
| Identity      | Enters own details                      | Searches/registers patient record                     |
| Consent       | Accepts themselves                      | Confirms on patient's behalf, logged as `staff`-given |
| Pacing        | Fully self-paced, low-literacy-friendly | Denser UI, staff-operated                             |
| Queue context | No physical urgency                     | May flag "patient present in waiting room"            |

## 10. Audit Logging

Append-only `audit_log` table: `id, case_id, actor_id, actor_role, action, metadata (JSON), timestamp`. Inserted server-side (never from frontend) so entries can't be skipped or spoofed.

Logged events by stage:

- **Consent:** `consent_given` — case_id, given_by, staff_id (if any), policy_version, timestamp
- **Intake:** `intake_submitted` — case_id, submitted_by, mode, input_types, timestamp
- **AI report:** `ai_report_generated` — case_id, pipeline version, risk_tag, department_suggested, source input references, timestamp
- **Queue view:** `queue_viewed` (optional but recommended) — viewer_id, department, timestamp
- **Assignment:** `case_assigned` — case_id, coordinator_id, assigned_doctor_id, timestamp
- **Report edit:** `report_edited` — case_id, editor_id, field_changed, old value, new value, timestamp
- **Risk change:** `risk_updated` — case_id, changed_by, old_level, new_level, **reason** (required), timestamp
- **Doctor view:** `case_viewed` — doctor_id, case_id, timestamp (every open, not just once)
- **Case closure/escalation:** `case_closed` / `case_escalated` — doctor_id, case_id, outcome, timestamp
- **Referral:** `referral_generated` — case_id, generated_by, referred_to_facility, report version referenced, timestamp
- **External API call:** `external_api_call` — case_id, service, timestamp (see Section 18)
- **Patient record access:** logged whenever the `patients` table is queried directly (see Section 29)

## 11. AI vs Human Responsibility

| AI does                         | Human does                                   |
| ------------------------------- | -------------------------------------------- |
| Summarizes symptoms/reports     | Makes the actual doctor assignment           |
| Applies rules-based risk tag    | Can override/edit the AI summary (versioned) |
| Suggests a department           | Can change risk level (must state reason)    |
| Drafts follow-up questions      | Makes all clinical decisions                 |
| Never assigns a specific doctor | Reviews and sends referrals                  |

## 12. Handling AI/OCR Failure

When the AI/OCR pipeline can't extract data clearly:

- Patient or receptionist can manually fill in the data
- They attach a copy of the document/image directly
- Case is tagged `source: manual_fallback` (and `status: manual_fallback` — Section 5) so the coordinator/doctor can see at a glance that it wasn't AI-verified and needs direct review
- **OCR confidence & handwriting:** Tesseract (Section 24) is weak on handwritten Indian lab reports. Low OCR confidence — including handwriting specifically, not just blurry/unclear images — explicitly routes here rather than silently returning a poor extraction.

## 13. Language Handling

- **Patient-facing:** multilingual (English/Hindi/regional languages), since accessibility is a grading criterion
- **Staff-facing** (receptionist, coordinator, doctor): English only, to keep the build scoped for the hackathon
- **Translation approach:** proper i18n (translation files per language, e.g. via `react-i18next`), not a live third-party translate widget — needed for control over medical terminology accuracy and consistency with the app's own AI translation pipeline
- **Translation source: Bhashini** — the Government of India's National Language Translation Mission platform (Ministry of Electronics and IT), offering open APIs across all 22 constitutionally recognized Indian languages, including translation, speech-to-text, and text-to-speech. Chosen over a generic consumer widget because:
  - It's a public, government-backed platform — a strong narrative fit for a project built around government/institutional health facilities
  - It can cover both **UI/text translation** and **voice-based symptom intake** through one integration, rather than separate services for each
  - An existing open-source reference implementation (webpage translation via Bhashini APIs) shows the pattern is already proven for this use case
- **Accuracy caveat:** Bhashini's translation quality isn't independently benchmarked per-language/use-case in public metrics, so medical terminology (symptom names, consent wording) should be spot-checked manually after generation rather than trusted blindly — especially in a health context
- **Demo-day reliability:** translation files should be **pre-generated** (batch-translated ahead of time and stored as static JSON) rather than translated live during the demo, to avoid depending on live API uptime/latency in front of judges
- **Alternative considered:** AI4Bharat's IndicTrans2 (IIT Madras) — an open-source model often cited as the quality benchmark for English↔Indic translation; worth using instead of or alongside Bhashini if raw translation accuracy matters more than the government-platform narrative
- **LLM/STT provider:** still to be named — see Section 30 (Open Items). Naming an actual provider alongside Tesseract (OCR) and Bhashini/IndicTrans2 (translation) would round out a complete, credible tooling story for the pitch, but the choice depends on team API budget/access.

## 14. Data Retention

- Case-specific test/report data purged after 30 days of account inactivity, enforced by a daily cron job that checks for expired cases and deletes/anonymizes them
- A separate long-term reference profile is retained per patient for continuity of care across visits
- **Tentative, pending team discussion:** what exactly counts as "inactive," and whether the long-term profile needs its own distinct consent from the case-level consent

## 15. Grading Alignment (for reference)

| Criteria                              | Weight | Where it's addressed                                               |
| ------------------------------------- | ------ | ------------------------------------------------------------------ |
| Safety-first triage workflow          | 20%    | Non-diagnostic boundary, human assignment, low-confidence fallback |
| Info extraction/summarization quality | 20%    | AI report generation pipeline                                      |
| Multimodal capability                 | 15%    | Text, voice, OCR, image upload                                     |
| India-wide relevance & accessibility  | 15%    | Patient-facing multilingual support                                |
| Human-review & escalation logic       | 15%    | Coordinator assignment, doctor review, referral                    |
| Privacy & responsible AI controls     | 10%    | Consent capture, audit log, retention policy                       |
| Demo quality                          | 5%     | —                                                                  |

## 16. Role-Based UI Implementation

- **Patient / Receptionist intake:** one shared `IntakeForm` component, internally branching on a `mode` prop (`self` vs `assisted`) — they share ~90% of the same UI
- **Coordinator / Doctor:** separate route trees (`/coordinator/*`, `/doctor/*`) since their dashboards are structurally different (queue view vs. assigned-cases view). JWT includes `role`; a route guard checks it on load and redirects on mismatch

## 17. File Storage & Security

**Storage**

- Uploaded files (reports, images) live in object storage (e.g. S3), not the database — Postgres stores only a reference/path
- Files are keyed by case ID, not original filename, to prevent collisions and stop enumeration of other patients' files

**Validation**

- Restrict accepted MIME types, verified by file signature/magic bytes (not just extension)
- Enforce a max file size (e.g. 5–10MB)
- Never execute or directly serve a file from its original upload path — always process/re-save it

**Access control**

- No public file URLs. Coordinators/doctors get short-lived signed URLs, generated only for cases they're authorized on (same role check as case access)

**Encryption**

- At rest: server-side encryption on the storage bucket (e.g. S3 SSE)
- In transit: HTTPS everywhere
- Field-level encryption in Postgres (e.g. patient name/contact) is a nice-to-have, not required for hackathon scope

**Auth basics**

- Login rate-limiting, hashed passwords, and session/token expiry — addresses "secure role-based access mockups" explicitly rather than by assumption

**Anti-abuse**

- Rate-limit the upload endpoint per user to prevent OCR/LLM cost abuse and storage flooding

## 18. PII Handling in External API Calls

Section 17 secures data **at rest** (encrypted storage, signed URLs, role checks). This section covers what happens to data **in transit to third-party services** — the LLM, OCR, and translation APIs the pipeline depends on — since encryption at rest says nothing about what's inside a request sent to an outside vendor.

**The gap:** if a request to an external API includes the patient's actual name and phone number alongside their symptoms, that identifiable health data has left the system entirely, regardless of how well the database itself is protected. This is what "anonymization" in the problem statement's guidelines actually means — not identifiable to whoever is processing it, including external vendors.

**Core method — strip before sending, re-link after receiving:**

1. Before any call to an external API, remove the patient's name/phone from the payload
2. Replace identity with the case ID (a UUID meaningless outside the system)
3. Send only the case ID + clinical content (symptoms, image, report text) to the external service
4. When the response returns, the backend re-attaches it to the real patient record locally, using the case ID — the external service never learns who the case ID belongs to

**Per service:**

- **OCR:** the image itself is usually safe to send, but if a name appears on the document (e.g. a hospital letterhead), extracted name fields are redacted/replaced before the text moves further down the pipeline
- **Translation:** input is symptom text, which is naturally low-risk — the rule is simply to never include patient name/phone in the string sent for translation
- **LLM summarization:** the highest-risk call, since it receives the most structured context. The payload sent contains only case ID, symptoms, extracted report text, and language — never patient name or phone number as fields

**Implementation:**

- A single shared function (e.g. `sanitizeForExternalCall(caseData)`) that every AI-service call goes through, stripping identity fields and returning a clean payload — centralizes the rule instead of relying on every call site remembering it
- Re-linking relies on the case ID already being the primary reference throughout the system, consistent with the patients/clinical-data separation defined in Section 29
- Logged in the audit trail as its own event: `external_api_call` — `case_id, service, timestamp` — so it can be demonstrated, not just claimed, that no identity data left the system on a given call

## 19. Failure Handling & Reliability

- **LLM failure:** retry up to 5 times with exponential backoff; if still unsuccessful, prompt the patient/receptionist to try later or type the information manually, and send a message/log to the admin
- **Low-bandwidth handling:** queue uploads locally, show pending status/queue position to the user, sync and notify once uploads succeed and the AI report is ready
- **Offline-first fallback:** if there is no connectivity at all, intake data queues locally on the device and syncs once connectivity returns, rather than failing outright
- **Mid-wait re-escalation:** if a patient's condition worsens while still waiting after being tagged low-risk, a re-submission re-runs the AI report and risk rules, re-scoring and re-prioritizing the case rather than leaving the original tag standing
- **Latency/performance:** all OCR/translation/LLM calls are asynchronous; the UI shows a processing status rather than blocking, so pipeline latency doesn't stall the intake experience
- **Query-level access control:** role checks enforced in the database query itself (e.g. a doctor's query only ever returns cases where `assigned_doctor_id = self`), not just hidden in the UI

## 20. Scaling Assumption

- Stateless backend (JWT-based, no server-side session state) — horizontally scalable behind a load balancer if needed, though not built out for the hackathon
- Single Postgres instance is sufficient for a single facility's load; DB read replicas would be the next step for multi-facility scale
- Stated as a design assumption for the pitch, not something to be built or load-tested during the hackathon

## 21. Multi-Tenancy

- The system serves many facilities (hospitals, PHCs, camps, clinics), so a `facility_id` should be attached to users, cases, and queues from the start
- A coordinator/doctor at one facility must never see another facility's queue or cases — enforced at the query level alongside the existing role checks

## 22. Facility Selection (Patient Side)

Multi-tenancy (Section 21) established that every case, queue, and staff account belongs to a specific `facility_id`. This section covers how a **patient actually chooses which facility** their case belongs to in the first place.

**Why this matters:** a city or town typically has multiple hospitals/PHCs/clinics under this system, and a patient may not always want the nearest one — they might specifically want a hospital in another town (a specialist there, a facility they trust, family living nearby, etc.). The design needs to support both "nearest facility, easy default" and "any facility, deliberate choice," without making the deliberate choice painful to reach.

**How it works, step by step:**

1. **Location narrowing first, not a flat list.** Given this is meant to be India-wide, a single dropdown listing every registered facility would be unusable — potentially hundreds or thousands of entries. Instead, the patient first provides a city or pincode (auto-suggested from device location where possible, but always manually editable), and the facility list is filtered down to that area.
2. **Then a searchable facility picker.** Within that narrowed list, the patient selects the actual facility — searchable by name, shown with basic identifying info (type: government hospital / PHC / clinic / camp, and ideally which departments it has).
3. **Override for out-of-town choice.** Because the location step is just a filter and not a restriction, a patient wanting a hospital outside their default area simply changes the city/pincode field before searching — same flow, no separate "advanced" mode needed.
4. **`facility_id` is set at the very start of the case.** As soon as the patient confirms a facility, that ID is attached to the case record from creation onward — before consent, before intake details are even filled in. Everything downstream is automatically scoped to that one facility, because it's just a query filter on `facility_id`.

**Data requirement this introduces:** a `facility` table — `id, name, city, pincode, type, departments[]` — separate from the `users`, `triage_cases`, and `audit_log` tables. Departments listed per facility also make the picker more useful, and this reuses the same department tags the AI report's department-suggestion step already produces.

**Difference from staff accounts:** patients choose a facility fresh on every case (since they might visit different hospitals over time). Receptionists, coordinators, and doctors do **not** choose a facility per session — their `facility_id` is fixed on their user account at onboarding, since they're employed at one specific facility. Staff queries are always scoped to their own fixed `facility_id`, while patient-side queries scope dynamically to whatever facility they picked for that case.

## 23. API Design

- RESTful endpoints, e.g. `POST /cases`, `GET /cases/:id`, `PATCH /cases/:id/assign`, `POST /cases/:id/referral` — a full endpoint list (with roles allowed per endpoint) should be drafted before parallel development starts. With 5 roles and ~10 audit event types, this is the highest-leverage planning artifact still missing.
- Consistent error response shape (e.g. `{ error: { code, message } }`) across all endpoints.

## 24. Third-Party Dependency Risk

- External services in the pipeline: LLM API, OCR (Tesseract), speech-to-text, translation (Bhashini/IndicTrans2)
- Each service's failure is handled independently, falling into the same manual-fallback path already defined for low-confidence AI/OCR output (Section 12)
- Naming actual planned providers in the pitch shows deliberate tooling choices rather than a vague "an LLM will do it"

## 25. Notifications

**Decided: SMS** is the notification channel (upload/report success, follow-up reminders per Section 29) — chosen over in-app-only or push because it works for patients on basic phones in lower-digital-maturity contexts, matching the accessibility criterion, and doesn't require the patient to have the app open or installed at all. In-app notifications can still be shown as a secondary confirmation for users actively in the app, but SMS is the channel the system depends on for reaching a patient who isn't.

## 26. Monitoring vs. Audit Log

- The audit log tracks _who did what_ for compliance and review
- Separately, basic operational monitoring (LLM API health, count of cases stuck in `manual_fallback`, queue depth per facility) is a distinct concern — not required for the hackathon demo, but worth acknowledging as a future addition

## 27. Environment & Secrets Management

- API keys (LLM, OCR, SMS provider, etc.) must live in environment variables, never hardcoded or committed to the repo

## 28. Testing Strategy

- Full coverage isn't expected for a hackathon, but safety-critical rules (e.g. "consent blocks intake") should be explicitly tested and demonstrable, rather than just claimed

## 29. Follow-Up Scheduling (Maternal-Health & Chronic-Disease Scenarios)

Covers the two India-wide scenarios from the problem statement that don't fit the reactive, one-shot case model used everywhere else in the system: **maternal-health follow-up reminders** and **chronic disease check-in support**. Both need the system to proactively reach out to a patient on a schedule, rather than waiting for the patient to submit a case.

**Why this is different from the rest of the flow:** every other scenario is "pull" — a patient or receptionist decides to start a case. Follow-up is "push" — a schedule decides when to ask the patient something. Everything _after_ that initial trigger (AI report, risk tagging, queue, coordinator, doctor review) reuses the existing pipeline unchanged; only the trigger itself is new.

**1. New table — `follow_up_schedule`**
`patient_id, facility_id, condition_type` (e.g. "maternal", "chronic-diabetes"), `frequency` (e.g. every 7 days), `next_due_date, active, created_by` (the doctor who set it up). Created when a doctor closes a relevant case and opts to schedule follow-ups (e.g. "set weekly follow-up for 6 weeks").

**2. Reminder job**
A daily scheduled job queries for schedules where `next_due_date` = today, sends a reminder via SMS (Section 25) with a way for the patient to respond, then advances `next_due_date` to the next interval.

**3. Patient response becomes a normal, tagged case**
The reply goes through the same intake pipeline (text/voice) already built, creating a new case with `case_type: follow_up` (a field separate from `status` — see Section 5), linked to the same `patient_id`'s long-term profile — not a new unrelated patient record. Its `status` follows the identical `submitted → processing → queued → assigned → closed` path as any other case.

**4. Doctor sees it with history**
Because it's linked to the long-term profile, the reviewing doctor sees the patient's prior visits/ongoing condition alongside the new follow-up case — this is the direct use case for the long-term reference profile defined under Data Retention (Section 14).

**Identity/contact separation this requires:**
Sending a reminder requires a way to reach the patient (e.g. phone number), which conflicts with fully anonymous storage. Resolution: split **identity/contact data** from **clinical case data** into separate tables:

- `patients` table: `id, phone_number` — minimal, contact-focused, **no `facility_id`** (a patient is not tied to one facility — see Section 22, where facility is chosen per case, so pinning it to the patient record would break for anyone who visits more than one hospital)
- `triage_cases` table: references `patient_id` and holds its own `facility_id` (the facility chosen for that specific case), plus clinical content — does not duplicate the phone number
- `follow_up_schedule` table: also holds its own `facility_id`, since a recurring follow-up is tied to whichever facility set it up
- Only the `follow_up_schedule` table and the reminder-sending job touch contact info; coordinators/doctors reviewing clinical cases see an ID, not a phone number
- Access to the `patients` table (i.e. who looked up a phone number) is itself logged in the audit trail
- Requires a **separate, explicit consent** ("enable follow-up reminders for this condition?") distinct from the general case-level consent, since storing contact info for future outreach is a different commitment than one-time processing

**Hackathon scope:** build the `follow_up_schedule` table and the doctor's "set follow-up" option, and the `case_type` field — but don't run a real cron job/live SMS sending during judging. Instead, simulate it: a demo button that manually triggers "7 days later, reminder sent → patient responds," so the concept is shown end-to-end without depending on real scheduled infrastructure, similar to how the specialist-lookup step is simulated.

## 30. Open Items (not yet finalized)

- Final data retention policy (pending team discussion — Section 14)
- Which single scenario to build for the live demo (e.g. OPD queue triage vs campus fever triage) — blocks synthetic data prep, since the two are interdependent
- Synthetic data set and sample documents (to be prepared during build/testing)
- Exact disclaimer wording (placement is decided — see Section 1)
- **API endpoint list — highest-leverage remaining artifact, needed before parallel development starts (see Section 23)**
- Team role split / build order
- LLM/STT provider choice (see Section 13) — depends on team API budget/access
