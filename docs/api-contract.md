# Multimodal Healthcare Triage Assistant — API Contract (V1)

Status: **frozen for V1 build**. Any change here needs a one-line note in the PR description — this doc is the thing frontend and backend both build against, not the code.

Conventions used throughout:

- All request/response bodies are JSON unless noted (file upload endpoint is `multipart/form-data`).
- All authenticated endpoints require `Authorization: Bearer <jwt>`.
- Timestamps are ISO 8601 UTC strings.
- IDs are UUIDs (string).
- Every error response uses the same envelope (see §0).
- `role` values: `patient | receptionist | doctor`.

---

## 0. Common Error Envelope

All non-2xx responses share this shape:

```json
{
  "error": {
    "code": "consent_required",
    "message": "Human-readable explanation",
    "details": {}
  }
}
```

| HTTP | `error.code`               | When                                                                          |
| ---- | -------------------------- | ----------------------------------------------------------------------------- |
| 400  | `validation_error`         | Missing/malformed fields                                                      |
| 401  | `unauthorized`             | Missing/invalid/expired JWT                                                   |
| 403  | `forbidden`                | Valid JWT, wrong role or not the resource owner                               |
| 403  | `consent_required`         | No valid consent record when creating a case                                  |
| 404  | `not_found`                | Resource doesn't exist or isn't visible to this user                          |
| 409  | `invalid_state_transition` | Action not valid for the case's current `status`                              |
| 429  | `rate_limit_exceeded`      | Rate limit quota reached (login brute-force, register, case, upload, consent) |
| 500  | `internal_error`           | Unhandled server error                                                        |

---

## 1. Auth

### `POST /api/auth/register`

Patient self-registration only — no `role` param accepted; server always sets `role: "patient"`.

**Request**

```json
{
  "name": "string",
  "email": "string",
  "password": "string (min 8 chars)",
  "phone_number": "string (optional, saved to linked patient record)"
}
```

**Response `201`**

```json
{
  "user_id": "uuid",
  "role": "patient"
}
```

**Errors:** `400 validation_error` (weak password, malformed email), `400 validation_error` (email already registered — do not leak via 409, keep it generic per spec's "don't reveal whether email exists")

---

### `POST /api/auth/login`

**Request**

```json
{ "email": "string", "password": "string" }
```

**Response `200`**

```json
{
  "token": "jwt string",
  "role": "patient | receptionist | doctor"
}
```

**Errors:** `401 unauthorized` — generic "invalid credentials", same message whether email exists or not.

---

### `POST /api/auth/logout`

V1: client-side token discard is sufficient; endpoint exists for future blacklisting, not wired up.

**Response `200`**

```json
{ "ok": true }
```

---

### `GET /api/auth/me`

**Response `200`**

```json
{
  "user_id": "uuid",
  "name": "string",
  "email": "string",
  "role": "patient | receptionist | doctor"
}
```

---

## 2. Consent

### `POST /api/consent`

Patient-scoped, not case-scoped. Valid 30 minutes from `timestamp`.

**Request**

```json
{
  "patient_id": "uuid",
  "given_by": "self | staff",
  "staff_id": "uuid (required if given_by = staff)",
  "policy_version": "string",
  "timestamp": "ISO8601 string"
}
```

**Response `201`**

```json
{
  "consent_id": "uuid",
  "patient_id": "uuid",
  "given_by": "self | staff",
  "valid_until": "ISO8601 string (timestamp + 30min)"
}
```

**Role access:** patient → own (`given_by` must be `self`); receptionist → on behalf (`given_by` must be `staff`, `staff_id` auto-set server-side from JWT, not trusted from body).

**Errors:** `400 validation_error` (missing `staff_id` when `given_by=staff`, or role/`given_by` mismatch).

---

### `GET /api/consent/:caseId`

Fetches the consent record linked to a case (via its `consent_id` FK), for audit/review — not a direct patient_id lookup, so a patient/receptionist can't fish for another patient's consent.

**Response `200`**

```json
{
  "consent_id": "uuid",
  "patient_id": "uuid",
  "given_by": "self | staff",
  "staff_id": "uuid | null",
  "policy_version": "string",
  "given_at": "ISO8601 string"
}
```

**Role access:** patient → own case only; receptionist → case they created only; doctor → any.
**Errors:** `404 not_found` (deliberately returned instead of `403` if the case isn't theirs, so existence of the case ID isn't confirmed — same anti-enumeration pattern as login).

---

## 3. Patients (receptionist-only)

### `GET /api/patients/search?q=`

Logged as `patient_search` audit event.

**Response `200`**

```json
{
  "patients": [
    { "patient_id": "uuid", "name": "string", "phone_number": "string" }
  ]
}
```

---

### `POST /api/patients`

Creates a walk-in patient record — **not** a login account. No password/email.

**Request**

```json
{ "name": "string", "phone_number": "string" }
```

**Response `201`**

```json
{ "patient_id": "uuid", "name": "string", "phone_number": "string" }
```

Logged as `patient_created` audit event.

---

## 4. Intake / Case Creation

### `POST /api/cases`

Validates (in order): (1) consent exists for `patient_id`, (2) `given_by` matches submission mode, (3) consent still within 30-min window. Fails closed → `403 consent_required`.

**Request**

```json
{
  "patient_id": "uuid",
  "mode": "self | assisted",
  "phone_number": "string (optional, updates patient contact if provided during intake)",
  "chief_complaint": "string (required)",
  "duration": "string",
  "symptoms": "string"
}
```

(Files are attached afterward via `/upload` — not in this body.)

**Response `201`**

```json
{
  "case_id": "uuid",
  "status": "submitted",
  "consent_id": "uuid",
  "mode": "self | assisted"
}
```

Server internally fires `POST /api/cases/:id/process` after upload(s) land — not called by frontend.

> **Changed from original contract:** `POST /api/cases` is now `multipart/form-data`, carrying both the text fields and the upload file(s) in a single request, instead of a separate `POST /api/cases/:id/upload` call after case creation. Changed to eliminate a processing-trigger race condition between case creation and upload arrival — one request, one atomic create-with-upload-and-trigger operation. `POST /api/cases/:id/upload` is removed from V1's active endpoint list as a result.

**Errors:**

- `403 consent_required` — `{ "error": { "code": "consent_required" } }` → frontend routes back to consent screen.
- `400 validation_error` — missing `chief_complaint` or missing required upload files.

---

### `POST /api/cases/:id/upload`

`multipart/form-data`. At least one of `voice` or `image` must be attached across calls to this endpoint before processing is considered complete; both may be used.

**Request (multipart fields)**

- `modality`: `"voice" | "image_ocr"`
- `file`: binary

**Response `201`**

```json
{
  "upload_id": "uuid",
  "case_id": "uuid",
  "modality": "voice | image_ocr",
  "file_path": "string"
}
```

**Errors:** `400 validation_error` (bad file type/size — validated client- and server-side).

---

### `GET /api/cases/:id`

**Response `200`**

```json
{
  "case_id": "uuid",
  "patient_id": "uuid",
  "status": "submitted | processing | queued | manual_fallback | assigned | closed | withdrawn",
  "mode": "self | assisted",
  "case_type": "walk_in | follow_up",
  "created_at": "ISO8601 string",
  "updated_at": "ISO8601 string"
}
```

---

### `GET /api/cases`

Server-filtered by role: patient → own; receptionist → created-by-them; doctor → full queue-eligible set.

**Query params:** `status` (optional filter)

**Response `200`**

```json
{
  "cases": [
    {
      "case_id": "uuid",
      "status": "string",
      "chief_complaint": "string (truncated)",
      "risk_level": "low | medium | high | critical | null",
      "created_at": "ISO8601 string"
    }
  ]
}
```

---

## 5. AI Structuring + Rules Engine

### `POST /api/cases/:id/process`

**Internal only — never exposed to any frontend role.** Block externally via internal-only middleware, not just by omitting a frontend button.

Runs AI extraction + full rules engine. On success: `status: processing → queued`. On AI/OCR failure or low confidence: `status → manual_fallback` (never retried-and-hidden). Accepts internal `skip_ai: true` for rules-only re-run after manual fallback fill.

**Response `200` (internal)**

```json
{
  "case_id": "uuid",
  "status": "queued | manual_fallback",
  "risk_level": "low | medium | high | critical | null",
  "ai_rules_disagreement": true
}
```

---

### `GET /api/cases/:id/report`

**Response `200`**

```json
{
  "case_id": "uuid",
  "chief_complaint": { "value": "string", "source": "ai | manual" },
  "duration": { "value": "string", "source": "ai | manual" },
  "symptoms": { "value": "string", "source": "ai | manual" },
  "vitals": { "value": {}, "source": "ai | manual" },
  "missing_info": ["string"],
  "risk_level": "low | medium | high | critical",
  "ai_rules_disagreement": {
    "present": true,
    "ai_suggested": "low",
    "rules_result": "high",
    "note": "rules result applies"
  }
}
```

---

### `GET /api/cases/:id/report/versions`

Doctor-only.

**Response `200`**

```json
{
  "versions": [
    {
      "version_number": 1,
      "source": "ai | doctor_edit | manual",
      "content": {},
      "edited_by": "uuid | null",
      "created_at": "ISO8601 string"
    }
  ]
}
```

---

## 6. Manual Fallback

### `PATCH /api/cases/:id/manual-fallback`

Only valid when `status = manual_fallback`.

**Request**

```json
{
  "chief_complaint": "string",
  "duration": "string",
  "symptoms": "string",
  "vitals": {}
}
```

**Response `200`**

```json
{ "case_id": "uuid", "status": "queued" }
```

**Errors:** `409 invalid_state_transition` if case isn't currently `manual_fallback`.

---

## 7. Doctor Queue & Review

### `GET /api/queue`

Doctor-only. Sorted by risk (critical → high → medium → low), then by `created_at`.

**Query params:** `status`, `risk_level`, `sort` (optional)

**Response `200`**

```json
{
  "queue": [
    {
      "case_id": "uuid",
      "patient_display": "string (name or anonymized id)",
      "chief_complaint": "string (truncated)",
      "risk_level": "low | medium | high | critical",
      "submitted_at": "ISO8601 string",
      "status": "queued | assigned"
    }
  ]
}
```

---

### `GET /api/cases/:id/review`

Doctor-only. Superset of `/report` plus missing-info and disagreement flags surfaced explicitly for the review UI.

**Response `200`**

```json
{
  "case_id": "uuid",
  "report": { "...same shape as GET /report" },
  "missing_info": ["string"],
  "ai_rules_disagreement": { "present": false }
}
```

---

### `PATCH /api/cases/:id/edit`

Doctor-only. Never overwrites — inserts a new `case_report_versions` row.

**Request**

```json
{
  "chief_complaint": "string",
  "duration": "string",
  "symptoms": "string",
  "vitals": {}
}
```

**Response `200`**

```json
{
  "case_id": "uuid",
  "new_version_number": 2
}
```

---

### `PATCH /api/cases/:id/risk-level`

Doctor-only. `reason` is required — request is rejected without it.

**Request**

```json
{
  "risk_level": "low | medium | high | critical",
  "reason": "string (required)"
}
```

**Response `200`**

```json
{ "case_id": "uuid", "risk_level": "high" }
```

**Errors:** `400 validation_error` — missing `reason`.

---

### `POST /api/cases/:id/approve`

Doctor-only. Sets `status = assigned`.

**Response `200`**

```json
{ "case_id": "uuid", "status": "assigned" }
```

**Errors:** `409 invalid_state_transition` if case is not currently `queued`.

---

### `POST /api/cases/:id/close`

Doctor-only. Sets `status = closed`.

**Response `200`**

```json
{ "case_id": "uuid", "status": "closed" }
```

**Errors:** `409 invalid_state_transition` if case is not currently `assigned`.

---

## 8. Audit Log

### `GET /api/cases/:id/audit`

Query-only — no write endpoint (audit rows are written server-side as a side effect of state-changing endpoints, via a single `transitionStatus()` function for all status changes).

**Response `200`**

```json
{
  "events": [
    {
      "event_type": "consent_given | intake_submitted | ai_report_generated | status_changed | report_edited | risk_overridden | assigned | closed | patient_search | patient_created",
      "actor_id": "uuid",
      "metadata": { "from": "queued", "to": "assigned" },
      "created_at": "ISO8601 string"
    }
  ]
}
```

**Role access:** patient → own case only; receptionist → case they created only; doctor → any. Same 404-not-403 anti-enumeration pattern as `/consent/:caseId`.

---

## 9. Misc

### `GET /api/disclaimer`

Optional — frontend may hardcode instead.

**Response `200`**

```json
{ "text": "string" }
```

### `GET /api/health`

**Response `200`**

```json
{ "status": "ok" }
```

---

## 10. Role Access Matrix

| Endpoint                               | Patient      | Receptionist      | Doctor               |
| -------------------------------------- | ------------ | ----------------- | -------------------- |
| `POST /api/auth/register`              | ✓ (self)     | —                 | —                    |
| `POST /api/auth/login`                 | ✓            | ✓                 | ✓                    |
| `GET /api/auth/me`                     | ✓            | ✓                 | ✓                    |
| `POST /api/consent`                    | own          | on behalf         | —                    |
| `GET /api/consent/:caseId`             | own case     | case they created | ✓                    |
| `GET /api/patients/search`             | —            | ✓                 | —                    |
| `POST /api/patients`                   | —            | ✓                 | —                    |
| `POST /api/cases`                      | own          | on behalf         | —                    |
| `POST /api/cases/:id/upload`           | own case     | case they created | —                    |
| `GET /api/cases/:id`                   | own case     | case they created | ✓                    |
| `GET /api/cases`                       | own only     | own-created only  | all (queue-filtered) |
| `POST /api/cases/:id/process`          | — (internal) | — (internal)      | — (internal)         |
| `PATCH /api/cases/:id/manual-fallback` | own case     | case they created | —                    |
| `GET /api/cases/:id/report`            | own case     | case they created | ✓                    |
| `GET /api/cases/:id/report/versions`   | —            | —                 | ✓                    |
| `GET /api/queue`                       | —            | —                 | ✓                    |
| `GET /api/cases/:id/review`            | —            | —                 | ✓                    |
| `PATCH /api/cases/:id/edit`            | —            | —                 | ✓                    |
| `PATCH /api/cases/:id/risk-level`      | —            | —                 | ✓                    |
| `POST /api/cases/:id/approve`          | —            | —                 | ✓                    |
| `POST /api/cases/:id/close`            | —            | —                 | ✓                    |
| `GET /api/cases/:id/audit`             | own case     | own-created case  | ✓                    |

Row-level ownership is enforced in addition to role checks: `case.patient_id === req.user.id` for patients, `case.created_by === req.user.id` for receptionists — not role-only middleware.

---

## 11. State Machine Reference (for the `409 invalid_state_transition` checks above)

```
submitted → processing → queued → assigned → closed
                 ↓
          manual_fallback → queued
```

`withdrawn` exists as a reserved status value from V1 but has no transition into it until the V3 consent-revocation action ships — no endpoint above should produce it yet.
