# Multimodal Healthcare Triage Assistant

**Phased, Safety-First Build Plan — Aligned to Core Design & Versioned Roadmap**

_This revision reconciles the original project report with two governing documents: `triage-assistant-core-design.md` (the full system specification) and `triage-assistant-build-roadmap-versioned.md` (the phased V1 / V2 / V3 delivery plan). Every feature below is tagged with the stage at which it is built, and no V1 item is ever removed to make room for a later one._

---

## 1. Executive Summary

Healthcare facilities receive patient information in inconsistent forms — typed text, spoken descriptions, photographed reports, multiple languages, and often incomplete data. This project builds a triage assistant that turns that information into a structured, reviewable case: an AI layer extracts and summarizes, a deterministic rules layer independently checks safety conditions, and a qualified human reviewer makes every final decision.

Unlike a single-shot build, this project is planned in three stages — V1, V2, V3 — so that a complete, demoable, safety-compliant product exists at every checkpoint, regardless of how much time remains. V1 is the non-negotiable floor; V2 and V3 are additive and never weaken a V1 safety or privacy mechanic.

## 2. The Five Rules That Never Break

These hold at every build stage, per the roadmap's non-negotiables:

- Consent is captured before any processing begins.
- A human always makes the final case decision — the AI never assigns a doctor or diagnoses.
- Every important action is logged in an append-only audit trail.
- Only synthetic demo data is used, and the non-diagnostic disclaimer is always shown.
- Failures are made visible to reviewers — never silently hidden.

## 3. What the Application Does

The workflow has six conceptual stages, matching the core design's pipeline:

- **Consent** — captured first, before any data is processed (V1).
- **Collect** — patient or receptionist submits text plus at least one of voice or image/OCR upload; both modalities are built in V1 (Section 4).
- **Structure** — an AI model extracts a structured draft: chief complaint, duration, symptoms, vitals, missing information (V1).
- **Check** — the full deterministic risk-rules engine runs unabridged from V1, since the roadmap notes it is already fully specified and cheap to include.
- **Review** — a human (Doctor role in V1; split into Triage Coordinator + Doctor from V2) reviews the AI-tagged queue.
- **Decide** — the reviewer approves, edits, escalates, or refers; this decision, not the AI's, is final.

## 4. Roles by Build Stage

| Role               | Introduced at | Notes                                                                                                                         |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Patient            | V1            | Self-service intake from home.                                                                                                |
| Receptionist       | V1            | Assisted intake from the hospital; confirms consent on the patient's behalf (logged as staff-given).                          |
| Doctor             | V1            | In V1 this role also performs the coordinator's queue review and assignment — the human-assignment step is one role, not two. |
| Triage Coordinator | V2            | Split back out from Doctor once V1 is stable; restores the two-step "AI suggests, human assigns" chain from the core design.  |
| Admin              | V3 (optional) | Facility, user, and audit-log management; can stay conceptual if facility data remains static/seeded.                         |

> **Deliberate V1 simplification:** The core design specifies five roles including a distinct Triage Coordinator. The roadmap folds that role into Doctor for V1 to keep the human-assignment step simple, while preserving the rule that AI never assigns a specific doctor. This is corrected in V2, not skipped.

## 5. Core Product Features, Staged

| Feature                                                           | Stage | What it means                                                                                                                                                   |
| ----------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent capture                                                   | V1    | First step in the pipeline; nothing is processed before it.                                                                                                     |
| Disclaimer (pre-intake and on report)                             | V1    | Non-diagnostic notice shown at both points.                                                                                                                     |
| Text intake                                                       | V1    | Baseline modality, required.                                                                                                                                    |
| Voice + image/OCR upload                                          | V1    | Both modalities built in V1 (not staggered); patient/receptionist picks whichever fits the case, at least one required alongside text.                          |
| Structured AI extraction                                          | V1    | Chief complaint, duration, symptoms, vitals.                                                                                                                    |
| Full deterministic risk-rules engine                              | V1    | Built unabridged — not simplified — because it is already fully specified.                                                                                      |
| Missing-info detection via checklists                             | V1    | Also fully specified already; kept as-is.                                                                                                                       |
| Case state machine (reduced)                                      | V1    | submitted → processing → queued → assigned → closed.                                                                                                            |
| Risk-sorted queue view                                            | V1    | Basic sort by risk level.                                                                                                                                       |
| Doctor review (view / edit / approve / close)                     | V1    | Final human decision point.                                                                                                                                     |
| Audit log (append-only, core events)                              | V1    | Consent, intake, AI report, assignment, closure.                                                                                                                |
| Basic security (env secrets, hashed passwords, upload validation) | V1    | Minimum security bar.                                                                                                                                           |
| Synthetic demo dataset (4 scenarios)                              | V1    | Normal, missing-info, disagreement, failure.                                                                                                                    |
| Single facility, no multi-tenancy                                 | V1    | Facility picker deferred.                                                                                                                                       |
| Language picker (English default)                                 | V1    | User is asked to choose their language right after opening the app; English is the default. Translation via Indian language models (e.g. Bhashini/IndicTrans2). |
| Coordinator role split back out                                   | V2    | Restores two-step assignment chain.                                                                                                                             |
| Critical-case escalation (bypass + alert)                         | V2    | High visual impact relative to effort.                                                                                                                          |
| PII stripping before external API calls                           | V2    | Shared utility function; answers the anonymization requirement.                                                                                                 |
| Facility selection + multi-tenancy                                | V2    | facility_id scoping throughout; matters for India-wide relevance grading.                                                                                       |
| Full multi-language support (Bhashini/IndicTrans2)                | V2    | Across all patient-facing screens.                                                                                                                              |
| Auto-drafted referral notes                                       | V2    | Already lightweight in the original design.                                                                                                                     |
| Real-time dashboard updates (Socket.IO)                           | V2    | Demo polish, not safety-critical — lowest V2 priority.                                                                                                          |
| Follow-up scheduling (maternal/chronic reminders)                 | V3    | Build the schedule table + a doctor "set follow-up" checkbox; simulate the reminder firing rather than running real scheduled infrastructure.                   |
| Offline-first intake                                              | V3    | Valuable to mention as architecture-ready even if unbuilt.                                                                                                      |
| Admin role + facility management UI                               | V3    | Can stay conceptual if facilities are static/seeded.                                                                                                            |
| Full audit-log viewer UI                                          | V3    | V1/V2 only need the log to exist and be queryable.                                                                                                              |
| Consent revocation ("withdrawn") flow                             | V3    | The withdrawn status already exists structurally; the patient-facing action is V3 polish.                                                                       |
| Monitoring dashboard (API status, stuck-in-fallback cases)        | V3    | Can be pitched as a future addition even if unbuilt.                                                                                                            |

## 6. End-to-End System Flow (V1 baseline)

1. Consent captured
2. Patient input (text + at least one of voice/image-OCR)
3. Structured AI extraction
4. Full deterministic safety rules
5. Draft triage note, missing-info flagged
6. Human review (Doctor role, queue sorted by risk)
7. Approve / edit / close
8. Audit event recorded at each step

V2 re-inserts the Coordinator as a distinct hand-off between steps 4 and 6, adds critical-case escalation between steps 4 and 5, and strips PII before any external AI call in step 3. V3 adds a follow-up scheduling trigger that can start this flow via a "push" event instead of a patient- or receptionist-initiated "pull" — everything downstream of that trigger reuses the same pipeline unchanged.

## 7. Case Status State Machine

V1 uses the reduced state machine specified in the roadmap:

**submitted → processing → queued → assigned → closed**

The core design's additional `withdrawn` status exists structurally from V1 (the field is reserved) but the patient-facing withdrawal action is not built until V3. A case's `case_type` field (`walk_in` vs. `follow_up`) records why a case exists and is independent of `status`, which records where it is in the pipeline — this distinction applies starting whenever follow-up scheduling (V3) is introduced.

## 8. AI / Human Division of Responsibility

| AI does                          | Human does                                      |
| -------------------------------- | ----------------------------------------------- |
| Summarizes symptoms/reports      | Makes the actual doctor assignment              |
| Applies the rules-based risk tag | Can override/edit the AI summary (versioned)    |
| Suggests a department            | Can change the risk level (must state a reason) |
| Drafts follow-up questions       | Makes all clinical decisions                    |
| Never assigns a specific doctor  | Reviews and sends referrals                     |

## 9. Security, Privacy, and Consent

- Consent is captured first, before any processing (V1) — corrected from the original report, which omitted this.
- Env-var secrets, hashed passwords, upload type/size validation (V1).
- PII stripped before any external AI API call (V2) — not assumed from V1, since it is a distinct utility to be built.
- Facility-scoped authorization (`facility_id`) only applies once multi-tenancy is built in V2 — V1 is single-facility, so scoping checks are simpler by construction.
- Retention limits on raw audio/images; synthetic demo data only, disclaimer always shown (V1).
- Consent revocation ("withdraw consent") is a V3 patient-facing action; the underlying `withdrawn` status exists earlier but is not user-triggerable until then.

## 10. Demo Scenarios (V1 dataset)

- **A — Normal text intake:** AI structures symptoms, no critical rule fires, Doctor approves.
- **B — Missing information:** system flags missing fields and suggests follow-up questions.
- **C — AI/rules disagreement:** AI drafts a lower-risk read; the rules engine independently detects higher risk; the rules result wins and the reason is shown.
- **D — Failure case:** a processing failure (e.g., OCR or AI timeout) is shown to the reviewer rather than hidden or fabricated.

Voice and OCR demo variants (equivalent to the original report's Scenarios D and E) are both available from V1, since both modalities are built in V1.

## 11. Suggested Pacing (45 days)

| Weeks | Focus                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 1–2   | V1 complete; first internal demo run.                                                                                   |
| 3–4   | V2 items 1–3: coordinator split, critical escalation, PII stripping.                                                    |
| 5     | V2 items 5–8 if on track; otherwise consolidate V1/V2 and polish.                                                       |
| 6     | V3 stretch items only if V1+V2 are fully stable; otherwise demo rehearsal, synthetic data quality, and pitch narrative. |

## 12. Definition of Done (V1 — the actual grading bar)

- Consent is captured before intake begins.
- A case can be created via text plus at least one of voice or image/OCR upload.
- The full deterministic risk-rules engine runs and can override the AI's read.
- Missing information is explicitly represented.
- The case moves through the five-state machine (submitted → processing → queued → assigned → closed).
- The Doctor role reviews the risk-sorted queue and approves/closes cases.
- Core events are audit-logged: consent, intake, AI report, report edits, risk-level overrides (with reason), assignment, closure — plus every status transition, logged as a `status_changed` event.
- Basic security (env secrets, hashed passwords, upload validation) is in place.
- The disclaimer is shown before intake and on the report.
- Synthetic demo data reproduces normal, missing-info, disagreement, and failure scenarios.

> **Framing for the pitch:** Unbuilt V2/V3 items (full multilingual support, Coordinator split, critical escalation, follow-up scheduling, offline-first intake, admin UI, monitoring dashboard) should be presented as "architecture-ready, not built for this demo due to time." This is the roadmap's stated, legitimate framing — not a weakness to hide.

## 13. What Changed From the Original Report

- **Added:** consent capture and disclaimer as explicit, first-class V1 requirements (previously absent).
- **Corrected roles:** Receptionist restored (was missing); Nurse/Facility-Administrator-as-V1 replaced with the roadmap's V1 role set (Patient, Receptionist, Doctor) plus V2/V3 role introductions.
- **Rescoped multi-tenancy:** `facility_id` and facility selection moved from the core schema/architecture into V2, matching the roadmap's "single facility only for V1" rule.
- **Language handling:** English is the default; the user is asked to pick a language right after opening the app, translated via Indian language models (Bhashini/IndicTrans2).
- **Modality scope:** both voice and image/OCR are built in V1 (not staggered across V1/V2) — this was the original plan the roadmap had staggered; the team has confirmed both are core hackathon requirements.
- **Added** PII stripping before external AI calls as an explicit V2 item (previously unmentioned).
- **Replaced** the original 12-phase, single-track backend schedule with the roadmap's three-tier V1/V2/V3 structure, so a complete product exists at every stopping point.
- **Aligned** the state machine to the roadmap's simplified V1 version, with the core design's full state set (including `withdrawn`) phased in at V3.
