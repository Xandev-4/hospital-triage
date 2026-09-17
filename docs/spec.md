# Multimodal Healthcare Triage Assistant — Project Spec

Hackathon Problem Statement 3. This is the single source of truth for the project — when in doubt, this doc wins over memory of a past conversation.

Companion docs (do not duplicate here, link out):

- `docs/build-roadmap.md` — full V1/V2/V3 phase breakdown
- `docs/api-reference.md` — full endpoint list + role matrix
- `docs/frontend-pages.md` — page-by-page UI spec
- `docs/core-design.md` — original full system design (all 30 sections)

---

## 1. Problem Statement

Healthcare facilities (government hospitals, PHCs, health camps, company clinics, campus health centers) receive patient information in inconsistent forms — typed text, spoken descriptions, photographed reports, multiple languages, often incomplete. This project turns that input into a structured, reviewable triage case: AI extracts and summarizes, a deterministic rules engine independently checks safety conditions, and a qualified human makes every final decision.

## 2. Non-Negotiable Constraint

**The system is explicitly non-diagnostic.** It organizes information and highlights urgency — it never prescribes treatment, never diagnoses, and never assigns a doctor. A human always makes the final call. The disclaimer is shown at every point a person interacts with AI output: before intake, on the AI-generated report, and in the reviewer's view.

## 3. The Five Rules That Never Break

These hold at every build stage — never weakened to make room for a feature:

1. Consent is captured before any processing begins.
2. A human always makes the final case decision — the AI never assigns a doctor or diagnoses.
3. Every important action is logged in an append-only audit trail.
4. Only synthetic demo data is used, and the non-diagnostic disclaimer is always shown.
5. Failures are made visible to reviewers — never silently hidden.

## 4. User Roles

| Role               | Function                                                                                                                                          | Introduced                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Patient            | Self-service intake from home                                                                                                                     | V1                              |
| Receptionist       | Assisted intake from the hospital; confirms consent on patient's behalf                                                                           | V1                              |
| Doctor             | V1: reviews AI-tagged queue _and_ makes human assignment (coordinator behavior folded in). V2 onward: reviews assigned case, treats, may escalate | V1                              |
| Triage Coordinator | Reviews AI-tagged queue, manually assigns a specific doctor                                                                                       | V2 (split back out from Doctor) |
| Admin              | Manages facility, users, audit logs                                                                                                               | V3 (optional)                   |

**V1 simplification, stated plainly:** the full design has 5 roles including a distinct Coordinator. V1 folds Coordinator into Doctor to keep the human-assignment step to one role. The rule "AI never assigns a specific doctor" still holds either way — this is a role-count simplification, not a safety simplification. V2 restores the split.

## 5. Architecture

- Single backend: Express + PostgreSQL
- Single JWT-based auth; `role` field determines access and UI
- Role-based middleware protecting routes (e.g. `requireRole('doctor')`), enforced **at the row level** too — e.g. `case.patient_id === req.user.id` — not just role-level
- One shared intake UI component for patient and receptionist, differentiated by a `mode` flag (`self` vs `assisted`)
- Identity/contact data (`patients` table: `id, phone_number`) is separated from clinical case data (`triage_cases` table) — required for follow-up reminders (V3) without exposing contact info on every case review

## 6. End-to-End Flow (V1 baseline)

1. Consent captured (`POST /api/consent`) — hard gate, not a step inside intake
2. Patient/receptionist intake: text (required) + at least one of voice or image/OCR upload
3. Server auto-triggers structured AI extraction (chief complaint, duration, symptoms, vitals)
4. Full deterministic risk-rules engine runs (unabridged from V1 — not simplified)
5. Draft triage note produced; missing-info flagged
6. Human review: Doctor role, queue sorted by risk
7. Approve / edit / close
8. Audit event recorded at every step above

**V2 changes to this flow:** re-inserts Coordinator as a distinct hand-off between steps 4 and 6; adds critical-case escalation between steps 4 and 5; strips PII before the external AI call in step 3.

**V3 changes to this flow:** follow-up scheduling can start this same pipeline via a "push" event (a reminder job) instead of a patient-initiated "pull" — everything downstream of the trigger is unchanged.

## 7. Case Status State Machine

V1 (reduced): `submitted → processing → queued → assigned → closed`

Also exists structurally from V1: `manual_fallback` (AI/OCR couldn't extract cleanly) and `withdrawn` (reserved field; patient-facing revoke action is V3).

`case_type` (`walk_in` vs `follow_up`, from V3) is independent of `status` — one records _why_ a case exists, the other records _where it is in the pipeline_.

## 8. AI vs Human Responsibility

| AI does                          | Human does                                      |
| -------------------------------- | ----------------------------------------------- |
| Summarizes symptoms/reports      | Makes the actual doctor assignment              |
| Applies the rules-based risk tag | Can override/edit the AI summary (versioned)    |
| Suggests a department            | Can change the risk level (must state a reason) |
| Drafts follow-up questions       | Makes all clinical decisions                    |
| Never assigns a specific doctor  | Reviews and sends referrals                     |

If AI and the rules engine disagree, **the rules engine result wins**, and the disagreement is shown to the reviewer, not hidden.

## 9. Security, Privacy, Consent

- Consent captured first, before any processing (V1)
- Consent is patient-scoped, not case-scoped, and valid 30 minutes from timestamp (covers multiple case submissions in that window)
- Env-var secrets, hashed passwords, upload type/size validation (V1)
- PII stripped before any external AI API call (V2 — shared utility function)
- `facility_id` scoping applies once multi-tenancy ships (V2); V1 is single-facility
- Synthetic demo data only; disclaimer always shown (V1)
- Consent revocation (`withdrawn`, patient-facing) is V3; the status field is reserved earlier

## 10. Non-Goals (explicit)

- Not a diagnostic tool — never suggests a diagnosis or treatment
- AI never assigns a specific doctor
- No real patient data at any stage — synthetic only
- V1 does not include: multi-tenancy, full multilingual rollout, critical-case escalation UI, referral drafting, real-time sockets, follow-up scheduling UI, offline intake, admin UI, full audit-log viewer, consent withdrawal UI, monitoring dashboard (all deferred to V2/V3 — see roadmap doc)

## 11. Definition of Done (V1 — the actual grading bar)

- Consent captured before intake begins
- A case can be created via text + at least one of voice/image-OCR
- Full deterministic risk-rules engine runs and can override the AI's read
- Missing information is explicitly represented
- Case moves through the five-state machine
- Doctor reviews risk-sorted queue and approves/closes cases
- Core events audit-logged: consent, intake, AI report, edits, risk overrides (with reason), assignment, closure, every status transition
- Basic security in place (env secrets, hashed passwords, upload validation)
- Disclaimer shown before intake and on the report
- Synthetic demo data reproduces: normal, missing-info, disagreement, failure scenarios

## 12. Suggested Pacing (45 days)

| Weeks | Focus                                                                      |
| ----- | -------------------------------------------------------------------------- |
| 1–2   | V1 complete; first internal demo run                                       |
| 3–4   | V2 items 1–3: coordinator split, critical escalation, PII stripping        |
| 5     | V2 items 5–8 if on track; otherwise consolidate and polish                 |
| 6     | V3 stretch only if V1+V2 solid; otherwise demo rehearsal + pitch narrative |

## 13. Open Items (not yet finalized)

- Which single on-site scenario to build for the live demo (e.g. OPD queue triage vs campus fever triage) — blocks synthetic data prep
- Exact disclaimer wording (placement is decided — Section 2)
- Final data retention policy details
- LLM/STT provider choice — depends on team API budget/access
