# Multimodal Healthcare Triage Assistant — API Reference (V1)

Consolidated endpoint list with the fixed consent contract and role-access matrix.

---

## 1. Consent — Fixed Contract

Consent is **patient-scoped, not case-scoped** — it must exist before any case does, so it cannot carry a `case_ref`.

### `POST /api/consent`

**Body:**

```json
{
  "patient_id": "...",
  "given_by": "self | staff",
  "staff_id": "... (required if given_by = staff)",
  "policy_version": "...",
  "timestamp": "..."
}
```

Returns `consent_id`.

### `POST /api/cases`

Before creating the case row, validates:

1. A consent record exists for this `patient_id`.
2. `given_by` matches the submission mode — self-service intake must be `self`; receptionist-assisted intake must be `staff`.
3. Consent is valid for **30 minutes** from its `timestamp`. One consent record covers multiple case submissions within that window (per `patient_id`) — the patient doesn't need to re-consent for every case.

If no valid consent is found (missing, or `timestamp` older than 30 minutes) → **403** with `consent_required`, not a silent case creation. This is the actual enforcement of the safety rule — a real rejection path, not just documentation. The frontend handles this by routing the user back through the consent screen.

On success, the new case stores `consent_id` (FK), permanently linking the two. The submission mode is also stored as a `mode` field (`self` | `assisted`) on the case row, enforced against `consent.given_by` at creation time.

**Frontend flow implication:** consent is a gate in front of intake, not a step inside it.
`Consent screen → POST /consent → (only then) intake form submit → POST /cases`

---

## 2. Full Endpoint List

### Auth

| Method & Path             | Purpose                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register` | Patient self-registration only. No `role` param — always creates `role: patient`. Receptionist/Doctor accounts are seeded directly into the DB. |
| `POST /api/auth/login`    | Issue JWT on valid credentials                                                                                                                  |
| `POST /api/auth/logout`   | Invalidate/blacklist token (or client-side discard)                                                                                             |
| `GET /api/auth/me`        | Return current user's profile + role, for frontend role-gating                                                                                  |

### Consent

| Method & Path              | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `POST /api/consent`        | Record patient-scoped consent before any case exists. See contract above. |
| `GET /api/consent/:caseId` | Fetch consent record for audit/review, via the case's linked `consent_id` |

### Patients (receptionist-only lookup/creation)

| Method & Path                 | Purpose                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/patients/search?q=` | Search existing patients by name/ID — receptionist-only, used when starting an assisted intake. Logged as a `patient_search` audit event (direct patient-table access).                                                                            |
| `POST /api/patients`          | Create a new patient record for a walk-in — receptionist-only. Name + contact info only, **no password/email required** — this is not an account, deliberately separate from `POST /api/auth/register`. Logged as a `patient_created` audit event. |

### Intake / Case Creation

| Method & Path                | Purpose                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/cases`            | Create a case — text is required, plus **at least one** of voice or image/OCR upload (both modalities are built in V1; the patient/receptionist picks whichever fits the case, not required to submit both). Validates consent (see contract above) before insert. Sets `status = submitted`, `mode` field (self vs assisted), links `consent_id`. |
| `POST /api/cases/:id/upload` | Attach the voice/OCR file to an existing case                                                                                                                                                                                                                                                                                                      |
| `GET /api/cases/:id`         | Fetch a single case's full current state                                                                                                                                                                                                                                                                                                           |
| `GET /api/cases`             | List cases — patient: their own; receptionist: cases they created; doctor: filtered/sorted queue                                                                                                                                                                                                                                                   |

### AI Structuring + Rules Engine

| Method & Path                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/cases/:id/process`        | Server-triggered only — never called directly by any frontend role. Runs AI extraction + rules engine (chief complaint, duration, symptoms, vitals, missing-info flags, risk tag). Sets `status = processing → queued` on success. On AI/OCR failure or low confidence, sets `status = manual_fallback` instead of retrying-and-hiding or advancing (Demo Scenario D). Accepts an internal `skip_ai: true` flag for a rules-only re-run after manual fallback fill. |
| `GET /api/cases/:id/report`          | Fetch the structured report + rules-engine risk tag + missing-info flags. Includes a `source` field per structured field (`ai` vs `manual`).                                                                                                                                                                                                                                                                                                                        |
| `GET /api/cases/:id/report/versions` | List all report versions (original AI draft + any doctor edits) — doctor-only.                                                                                                                                                                                                                                                                                                                                                                                      |

### Manual Fallback

| Method & Path                          | Purpose                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /api/cases/:id/manual-fallback` | Patient/receptionist manually fills structured fields AI/OCR failed to extract. On submit, transitions `manual_fallback → queued`; rules engine still runs against the manually-entered data. |

### Doctor Queue & Review

| Method & Path                     | Purpose                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/queue`                  | Doctor's risk-sorted queue — queued/assigned cases                                                                                                                                                                                                |
| `GET /api/cases/:id/review`       | Full reviewable case detail: AI report, rules-engine tag, missing-info list, AI/rules disagreement flag                                                                                                                                           |
| `PATCH /api/cases/:id/edit`       | Doctor edits the AI-drafted summary. Never overwrites — inserts a new `case_report_versions` row (`case_id`, `version_number`, `source: ai\|doctor_edit`, `content`, `edited_by`, `created_at`). Audit entry references the new `version_number`. |
| `PATCH /api/cases/:id/risk-level` | Doctor overrides the risk level — requires a `reason` field                                                                                                                                                                                       |
| `POST /api/cases/:id/approve`     | Doctor approves the case as-is, sets `status = assigned`                                                                                                                                                                                          |
| `POST /api/cases/:id/close`       | Doctor closes the case, sets `status = closed`                                                                                                                                                                                                    |

### Audit Log

| Method & Path              | Purpose                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/cases/:id/audit` | Append-only audit trail for one case (consent, intake, AI report generated, edit versions, assignment, closure, status transitions). Query endpoint only — no full viewer UI for V1. |

_(Audit rows are written server-side as a side effect of other state-changing endpoints — never created directly via API.)_

**Status transitions** (including `processing → manual_fallback` and `manual_fallback → queued`) are logged as their own `status_changed` event type, with `{from, to}` metadata. Every status write happens inside a single `transitionStatus()` function — never written directly by an individual endpoint — so this event type is guaranteed to fire on every transition rather than depending on each endpoint remembering to log it.

### Misc / Support

| Method & Path         | Purpose                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `GET /api/disclaimer` | Serve the non-diagnostic disclaimer text (optional — can hardcode frontend-side) |
| `GET /api/health`     | Basic health check                                                               |

---

## 3. Roles Allowed Per Endpoint

| Endpoint                               | Patient               | Receptionist                 | Doctor               |
| -------------------------------------- | --------------------- | ---------------------------- | -------------------- |
| `POST /api/auth/register`              | ✓ (self)              | —                            | —                    |
| `POST /api/auth/login`                 | ✓                     | ✓                            | ✓                    |
| `GET /api/auth/me`                     | ✓                     | ✓                            | ✓                    |
| `POST /api/consent`                    | own (`given_by=self`) | on behalf (`given_by=staff`) | —                    |
| `GET /api/consent/:caseId`             | own case              | case they created            | ✓                    |
| `GET /api/patients/search?q=`          | —                     | ✓                            | —                    |
| `POST /api/patients`                   | —                     | ✓                            | —                    |
| `POST /api/cases`                      | own                   | on behalf                    | —                    |
| `POST /api/cases/:id/upload`           | own case              | case they created            | —                    |
| `GET /api/cases/:id`                   | own case              | case they created            | ✓                    |
| `GET /api/cases`                       | own only              | own-created only             | all (queue-filtered) |
| `POST /api/cases/:id/process`          | — (server-triggered)  | — (server-triggered)         | — (server-triggered) |
| `PATCH /api/cases/:id/manual-fallback` | own case              | case they created            | —                    |
| `GET /api/cases/:id/report`            | own case              | case they created            | ✓                    |
| `GET /api/cases/:id/report/versions`   | —                     | —                            | ✓                    |
| `GET /api/queue`                       | —                     | —                            | ✓                    |
| `GET /api/cases/:id/review`            | —                     | —                            | ✓                    |
| `PATCH /api/cases/:id/edit`            | —                     | —                            | ✓                    |
| `PATCH /api/cases/:id/risk-level`      | —                     | —                            | ✓                    |
| `POST /api/cases/:id/approve`          | —                     | —                            | ✓                    |
| `POST /api/cases/:id/close`            | —                     | —                            | ✓                    |
| `GET /api/cases/:id/audit`             | own case              | own-created case             | ✓                    |

### Notes on ambiguous cells

- **"Own case" / "case they created"** means ownership is enforced at the **row level**, not just the role level — middleware needs `requireRole('patient')` (or `'receptionist'`) _plus_ a query-time filter: `case.patient_id === req.user.id` for patients, `case.created_by === req.user.id` for receptionists.
- **`/process` is server-triggered only** — no role has direct access. It's invoked internally after case creation or by a retry mechanism, never hit directly from a frontend button. Worth actively blocking external calls (internal-only middleware, or simply never exposing it in the frontend) rather than relying on the frontend to just not call it.
- **`GET /api/consent/:caseId`** and **`GET /api/cases/:id/audit`** deliberately mirror the same ownership pattern so a patient/receptionist can't pull another patient's consent or audit trail by guessing IDs. This is a privacy-leak vector, not just a 403 annoyance — worth an explicit test case.
