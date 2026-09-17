# Multimodal Healthcare Triage Assistant — Phased Build Roadmap

Companion document to `triage-assistant-core-design.md`. Splits the full design into three build stages so the team always has a working, demoable product, and only takes on more scope if time allows. Section references point to the core design doc.

**Guiding rule:** V1 must be a complete, demoable, end-to-end product on its own. V2 and V3 are additive — never remove or water down a V1 safety/privacy mechanic to make room for a V2/V3 feature.

---

## V1 — Core Demoable Product (build this first, no matter what)

Everything needed for one convincing end-to-end demo: a patient/receptionist submits a case, AI processes it, a human reviews and decides. This is the non-negotiable minimum — if the hackathon ended the day this is done, you'd still have a credible submission.

**Roles:** Patient, Receptionist, Doctor (coordinator behavior folded into Doctor for V1 — see note below)

**Included:**

- Consent capture, first step in the pipeline (Section 1, 4)
- Intake: text + at least one of voice or image/OCR upload — **both modalities built in V1**, since they're core hackathon requirements (not staggered across V1/V2)
- AI report generation: structured extraction (chief complaint, duration, symptoms, vitals)
- **Risk rules — full rule set, not simplified** (Section 7): this is cheap and already fully specified, no reason to cut it
- **Missing-info detection via checklists** (Section 8): same — already spec'd, keep it
- Case status state machine (Section 5) — even a reduced version: `submitted → processing → queued → assigned → closed`
- Basic queue view, sorted by risk level
- Doctor review: view note, edit, approve/close
- Audit log: append-only table logging the core events (consent, intake, AI report, assignment, closure)
- Disclaimer shown before intake and on the report (Section 1)
- Basic security: env-var secrets, hashed passwords, file type/size validation on uploads (Section 17)
- Synthetic demo data: 3–4 sample cases (normal, missing-info, disagreement, failure — per the demo script in your teammate's report)

**Deliberately simplified for V1:**

- **Coordinator role merged into Doctor** — the doctor both sees the queue and closes cases. The _behavior_ "AI never assigns a doctor" still holds (AI only suggests risk/department), but the human-assignment step is a single role instead of two. Splitting it out is V2.
- Single facility only — no facility picker, no multi-tenancy (Section 21, 22)
- Language picker shown right after opening the app; English is the default. Translation via Indian language models (Bhashini/IndicTrans2) from V1 — not deferred to V2.
- Manual fallback exists but is simple (Section 12) — no confidence scoring nuance yet

**Why this is enough to demo:** it proves every one of your five "rules that never break" (AI drafts, rules back it up, minimal collection, everything logged, consent first) end-to-end, which is what's actually being graded — not feature count.

---

## V2 — If Time Allows (strengthens safety/scale story)

Add these once V1 is fully working and demoed successfully at least once internally. This is where you recover the scope your teammate's simplified report cut, but selectively — prioritizing what actually affects grading over what's just "more features."

**Included, roughly in priority order:**

1. **Split Coordinator role back out from Doctor** (Section 2, 11) — restores the full "AI suggests, human assigns" chain as two distinct roles/steps. Mostly a role + one assignment endpoint, not a large lift.
2. **Critical-case escalation** (Section 6) — bypass + visual/audio alert for CRITICAL cases. High visual impact for the demo relative to the effort.
3. **PII stripping before external API calls** (Section 18) — one shared utility function; cheap, and directly answers the "anonymization" requirement in the guidelines.
4. **Facility selection + multi-tenancy** (Section 21, 22) — patient picks a facility, `facility_id` scoping throughout. Matters for the "India-wide relevance" grading criterion.
5. **Full multi-language expansion beyond the V1 language picker** (Section 13) — additional languages across patient-facing screens, on top of the English-default/Indian-model translation already in V1.
6. **Referral generation** (auto-drafted referral note) — was already lightweight in the original design.
7. **Real-time dashboard updates** (Socket.IO) — nice demo polish, not safety-critical, hence lower priority than the above.

---

## V3 — Stretch Goals (only if V1 and V2 are solid with time to spare)

These are the parts that add genuine scope/complexity, or are more valuable to _mention in the pitch_ than to fully build. Don't start V3 until V2 is stable — a half-built V3 feature actively hurts more than an unstarted one.

**Included:**

1. **Follow-up scheduling** (Section 29) — maternal-health/chronic-disease reminders. Recommend building only the schedule table + doctor's "set follow-up" checkbox, and **simulating** the reminder firing live rather than running real scheduled infrastructure (as already planned).
2. **Offline-first intake** (queue locally, sync later) — valuable to mention as architecture-ready even if not fully implemented.
3. **Admin role + facility management UI** — if facilities are still seeded/static data, this can stay conceptual.
4. **Full audit-log viewer UI** — a simple filterable table showing a case's full timeline; V1/V2 just need the log to exist and be query-able, not a polished UI for it.
5. **Consent revocation flow** (Section 5) — the `withdrawn` status already exists structurally; building the actual patient-facing "withdraw consent" action is V3 polish.
6. **Monitoring dashboard** (Section 26) — operational health (API status, cases stuck in fallback) — mentioned in the pitch as a future addition regardless of whether it's built.

---

## What never gets cut, at any stage

Regardless of how far you get through V2/V3, these are non-negotiable because they're either explicit guideline requirements or core to the "safety-first" grading criterion:

- Consent captured before any processing
- A human always makes the final case decision — AI never assigns a doctor or diagnoses
- Every important action is logged in the audit trail
- Synthetic data only, disclaimer clearly shown
- Failures are visible to reviewers, never silently hidden

---

## Suggested pacing across 45 days

| Weeks | Focus                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2   | V1 complete, first internal demo run                                                                                                      |
| 3–4   | V2 items 1–3 (coordinator split, critical escalation, PII stripping)                                                                      |
| 5     | V2 items 5–8 if on track, otherwise consolidate V1/V2 and polish                                                                          |
| 6     | V3 stretch items only if V1+V2 are fully stable; otherwise spend this week on demo rehearsal, synthetic data quality, and pitch narrative |

Slides/pitch should describe the full design (including unbuilt V3 items) as **"architecture-ready, not built for this demo due to time"** — this is a legitimate and expected framing for a hackathon submission, not a weakness to hide.
