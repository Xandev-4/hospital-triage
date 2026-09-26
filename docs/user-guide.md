# 🏥 HM-Triage — Complete User & Operator Guide

Welcome to the **Multimodal Healthcare Triage Assistant (`HM-Triage`)** user guide. This document explains how to set up, operate, and interact with the application across all system roles: **Patients**, **Receptionists**, and **Doctors**.

---

## 📑 Table of Contents

1. [System Roles & Workflow Overview](#1-system-roles--workflow-overview)
2. [Prerequisites & First-Time Setup](#2-prerequisites--first-time-setup)
3. [Staff Account Seeding & Management](#3-staff-account-seeding--management)
4. [Role 1: Patient Self-Service Workflow](#4-role-1-patient-self-service-workflow)
5. [Role 2: Receptionist Assisted-Intake Workflow](#5-role-2-receptionist-assisted-intake-workflow)
6. [Role 3: Doctor Clinical Triage Workflow](#6-role-3-doctor-clinical-triage-workflow)
7. [Audit Trails & Clinical Governance](#7-audit-trails--clinical-governance)
8. [Automated Verification & Testing](#8-automated-verification--testing)
9. [API Troubleshooting & FAQ](#9-api-troubleshooting--faq)

---

## 1. System Roles & Workflow Overview

`HM-Triage` implements strict **Role-Based Access Control (RBAC)** across three personas:

```mermaid
flowchart TD
    subgraph Intake["Intake Layer"]
        P["👤 Patient (Self-Service)"] -->|1. Sign Consent| C1[(Consent 30m)]
        R["🧑‍💼 Receptionist (Assisted)"] -->|1. Desk Consent| C1
        P -->|2. Multipart Form + Voice/OCR| API["POST /api/cases"]
        R -->|2. Assisted Intake Form| API
    end

    subgraph Processing["AI & Deterministic Engine"]
        API --> OCR["OCR (Tesseract)"]
        API --> STT["Speech-to-Text (Whisper)"]
        API --> LLM["Structuring LLM (Gemini)"]
        OCR & STT & LLM --> RULES{"Deterministic Rules Engine"}
        RULES -->|Safety floor & Discrepancy check| Q[(Prioritized Queue)]
    end

    subgraph Clinical["Doctor Review Layer"]
        Q --> DOC["🩺 Doctor"]
        DOC -->|3. View Queue (Critical → Low)| QUEUE_API["GET /api/queue"]
        DOC -->|4. Inspect Clinical Report| REV_API["GET /api/cases/:id/review"]
        DOC -->|5. Edit / Override / Approve| EDIT_API["PATCH /api/cases/:id/edit"]
        DOC -->|6. Close Case| CLOSE_API["POST /api/cases/:id/close"]
    end
```

### Role Permissions Matrix

| Endpoint                               | Description                        |  Patient  | Receptionist  |  Doctor  |
| :------------------------------------- | :--------------------------------- | :-------: | :-----------: | :------: |
| `POST /api/auth/register`              | Patient self-registration          |    ✅     |      ❌       |    ❌    |
| `POST /api/auth/login`                 | Login (returns JWT)                |    ✅     |      ✅       |    ✅    |
| `GET /api/auth/me`                     | Current authenticated user profile |    ✅     |      ✅       |    ✅    |
| `POST /api/consent`                    | Digital consent record             | ✅ (self) | ✅ (assisted) |    ❌    |
| `POST /api/cases`                      | Multimodal intake submission       |    ✅     |      ✅       |    ❌    |
| `PATCH /api/cases/:id/manual-fallback` | Manual fallback completion         | ✅ (own)  |      ✅       |    ❌    |
| `GET /api/cases`                       | List cases                         | ✅ (own)  | ✅ (assisted) | ✅ (all) |
| `GET /api/queue`                       | Priority clinical queue            |    ❌     |      ❌       |    ✅    |
| `GET /api/cases/:id/review`            | Clinical review payload            |    ❌     |      ❌       |    ✅    |
| `PATCH /api/cases/:id/edit`            | Edit triage report version         |    ❌     |      ❌       |    ✅    |
| `PATCH /api/cases/:id/risk-level`      | Override clinical risk level       |    ❌     |      ❌       |    ✅    |
| `POST /api/cases/:id/close`            | Finalize / close case              |    ❌     |      ❌       |    ✅    |
| `GET /api/cases/:id/audit`             | Query immutable audit trail        |    ❌     |      ❌       |    ✅    |

### Edge Rate Limiting & Abuse Defense

To prevent brute-forcing, cloud API budget exhaustion, and database spamming, route-specific rate limiters are mounted on critical ingress points:

| Endpoint                            | Quota                      | Key Strategy            | Primary Protection                                                                                           |
| :---------------------------------- | :------------------------- | :---------------------- | :----------------------------------------------------------------------------------------------------------- |
| **`POST /api/auth/login`**          | 5 failed attempts / 15 min | Client IP (`req.ip`)    | **Brute-Force Lockout**: Skips successful logins (`200 OK`); blocks repeated invalid password attempts.      |
| **`POST /api/auth/register`**       | 10 registrations / hr      | Client IP (`req.ip`)    | **Bot Flooding Defense**: Prevents scripted mass creation of fake patient and user records.                  |
| **`POST /api/cases`**               | 20 submissions / hr        | User ID (`req.user.id`) | **AI & OCR Cost Guard**: Protects upstream Gemini LLM and Whisper STT quotas from runaway bills.             |
| **`POST /api/cases/:id/upload`**    | 20 uploads / hr            | User ID (`req.user.id`) | **Disk & Compute Protection**: Evaluated before Multer disk writes to stop disk exhaustion.                  |
| **`POST /api/consent`**             | 20 submissions / hr        | User ID (`req.user.id`) | **State Flooding Defense**: Restricts excessive creation of consent authorization rows.                      |
| **`GET /api/queue`, `/api/health`** | _Unthrottled_              | N/A                     | **Clinical Operations**: Guarantees zero latency or lockout for doctor queue review and cloud health probes. |

> **Privacy Note on 429 Responses**: Rate limit responses return a generic HTTP 429 error envelope (`{ "error": { "code": "rate_limit_exceeded", "message": "..." } }`) without exposing exact remaining seconds or attempt counters, denying attackers granular timing information.

---

## 2. Prerequisites & First-Time Setup

### Requirements

- **Node.js** v20.x or v22.x LTS
- **npm** v10+
- **PostgreSQL Database** (e.g., [Neon Serverless Postgres](https://neon.tech/))

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/your-username/HM-Triage.git
cd HM-Triage
npm install
```

### 2. Configure Environment Variables

Create your local `.env` file from the example template:

```bash
cp .env.example .env
```

Open `.env` and configure your credentials:

```env
# Application Port
PORT=8000

# Postgres Database (e.g. Neon connection string)
DATABASE_URL="postgresql://user:password@ep-billowing-silence.neon.tech/neondb?sslmode=require"
DATABASE_URL_POOLED="postgresql://user:password@ep-billowing-silence-pooler.neon.tech/neondb?sslmode=require"

# JWT Authentication
JWT_SECRET="generate_a_random_32_character_string_here"
JWT_EXPIRES_IN="7d"

# Optional Cloud AI Providers (Fallbacks to local stub/Tesseract if left empty)
GROQ_API_KEY=""
GEMINI_API_KEY=""
```

### 3. Push Database Schema

Sync the Drizzle schema directly to your PostgreSQL database:

```bash
npm run db:push
```

### 4. Start the Application

```bash
# Start with hot-reloading (development mode)
npm run dev
```

The server will start listening at `http://localhost:8000`.

---

## 3. Staff Account Seeding & Management

Staff accounts (`doctor` and `receptionist`) cannot be created through the public registration endpoint. They are provisioned through administrative CLI tools.

### Initial Database Seed

To bootstrap default staff accounts into a fresh database:

```bash
npm run seed
```

This idempotently creates:

- `dr.aisha.sharma@hospital.org` (Doctor)
- `dr.marcus.chen@hospital.org` (Doctor)
- `reception.priya@hospital.org` (Receptionist)
- `reception.rahul@hospital.org` (Receptionist)

Unique, cryptographically secure passwords are automatically generated and printed in the terminal table.

### Managing Staff via CLI

Use the built-in staff CLI anytime without touching the database directly:

```bash
# 1. List all doctors and receptionists
npm run staff:list

# 2. Add a new doctor (auto-generates strong password)
npm run staff:add -- --role doctor --name "Dr. Gregory House" --email "dr.house@hospital.org"

# 3. Add a staff member with a specific password
npm run staff:add -- --role receptionist --name "John Doe" --email "john@hospital.org" --password "StaffSecure@2026!"

# 4. Remove a staff account
npm run staff:remove -- dr.house@hospital.org
```

---

## 4. Role 1: Patient Self-Service Workflow

Patients interact with the system on their personal mobile devices or kiosks.

```mermaid
sequenceDiagram
    autonumber
    actor Patient
    participant API as HM-Triage Server
    participant DB as PostgreSQL

    Patient->>API: POST /api/auth/register
    API->>DB: Create user & patient profile
    Patient->>API: POST /api/auth/login
    API-->>Patient: JWT Token (role: patient)

    Patient->>API: POST /api/consent (Authorization: Bearer <token>)
    API->>DB: Store consent with 30m window

    Patient->>API: POST /api/cases (multipart/form-data)
    Note over Patient,API: text complaint + audio/image attachments
    API->>DB: Create case in 'submitted' status
    API-->>Patient: Return case_id & status: 'queued'
```

### Step 1: Self-Registration & Login

```bash
# 1. Register
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Doe",
    "email": "jane.doe@example.com",
    "password": "SecurePassword123!",
    "phone_number": "+919876543210"
  }'

# 2. Login to receive JWT token
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "jane.doe@example.com",
    "password": "SecurePassword123!"
  }'
```

_Save the returned `token` as `PATIENT_TOKEN`._

### Step 2: Record Digital Consent

Consent must be given before an intake can be processed and remains valid for **30 minutes**:

```bash
curl -X POST http://localhost:8000/api/consent \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "consent_type": "general_treatment",
    "given_by": "self"
  }'
```

### Step 3: Submit Intake Case (Multipart with Voice / Image)

Patients can submit plain text, or attach a prescription image or voice recording:

```bash
curl -X POST http://localhost:8000/api/cases \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -F "mode=self" \
  -F "chief_complaint=Sharp chest pain radiating to left arm for 2 hours with sweating" \
  -F "heart_rate=110" \
  -F "systolic_bp=150" \
  -F "diastolic_bp=95" \
  -F "spo2=96" \
  -F "voice_upload=@/path/to/voice-recording.wav" \
  -F "image_upload=@/path/to/prescription.jpg"
```

The system automatically extracts the multimodal inputs, evaluates deterministic clinical rules, and assigns initial risk (`critical`, `high`, `medium`, or `low`).

---

## 5. Role 2: Receptionist Assisted-Intake Workflow

Receptionists register walk-in patients who cannot use a mobile device or need emergency assistance.

### Step 1: Login as Receptionist

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "reception.priya@hospital.org",
    "password": "YourReceptionistPassword"
  }'
```

_Save the returned `token` as `RECEPTIONIST_TOKEN`._

### Step 2: Record Staff-Assisted Consent

At the triage desk, the receptionist confirms verbal consent on behalf of the patient:

```bash
curl -X POST http://localhost:8000/api/consent \
  -H "Authorization: Bearer $RECEPTIONIST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "patient_id": "<PATIENT_UUID>",
    "consent_type": "general_treatment",
    "given_by": "staff"
  }'
```

### Step 3: Submit Assisted Case

```bash
curl -X POST http://localhost:8000/api/cases \
  -H "Authorization: Bearer $RECEPTIONIST_TOKEN" \
  -F "mode=assisted" \
  -F "patient_id=<PATIENT_UUID>" \
  -F "chief_complaint=Elderly walk-in patient with high fever (103.5F) for 4 days" \
  -F "temperature=103.5"
```

### Step 4: Handle Manual Fallback (If Uploads Fail)

If an attached image is blurry or audio is unintelligible, the case transitions to `manual_fallback`. Receptionists or patients can fulfill the missing fields:

```bash
curl -X PATCH http://localhost:8000/api/cases/<CASE_UUID>/manual-fallback \
  -H "Authorization: Bearer $RECEPTIONIST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chief_complaint": "Persistent high fever and severe chills",
    "symptoms": ["high fever", "chills", "fatigue"],
    "duration": "4 days",
    "vitals": { "temperature": 103.5, "heartRate": 98 }
  }'
```

This resolves the fallback and moves the case directly into the doctor's prioritized queue.

---

## 6. Role 3: Doctor Clinical Triage Workflow

Doctors manage the clinical queue, review AI structured notes, correct diagnoses, and approve triage plans.

### Step 1: Login as Doctor

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dr.aisha.sharma@hospital.org",
    "password": "YourDoctorPassword"
  }'
```

_Save the returned `token` as `DOCTOR_TOKEN`._

### Step 2: View Prioritized Queue

The queue is automatically sorted strictly by medical urgency: `critical` &rarr; `high` &rarr; `medium` &rarr; `low`:

```bash
curl -X GET http://localhost:8000/api/queue \
  -H "Authorization: Bearer $DOCTOR_TOKEN"
```

### Step 3: Inspect Case Review Details

Fetches clinical report version 1, uploaded images/audio provenance, and any detected discrepancies:

```bash
curl -X GET http://localhost:8000/api/cases/<CASE_UUID>/review \
  -H "Authorization: Bearer $DOCTOR_TOKEN"
```

### Step 4: Edit Report & Clinical Notes

Doctors can update symptoms, vitals, or clinical summaries. Each edit automatically creates an immutable new report version (`v2`, `v3`, etc.) with full attribution:

```bash
curl -X PATCH http://localhost:8000/api/cases/<CASE_UUID>/edit \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chief_complaint": "Acute Coronary Syndrome presentation",
    "symptoms": ["crushing chest pain", "left arm radiation", "diaphoresis"],
    "vitals": { "heartRate": 110, "spo2": 95, "systolicBp": 150 },
    "edit_reason": "Corrected triage description after bedside ECG evaluation"
  }'
```

### Step 5: Override Risk Level (With Mandatory Audit Justification)

If clinical judgment warrants elevating or lowering the urgency, the doctor overrides the risk level:

```bash
curl -X PATCH http://localhost:8000/api/cases/<CASE_UUID>/risk-level \
  -H "Authorization: Bearer $DOCTOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "risk_level": "critical",
    "reason": "ECG shows ST-elevation in leads V1-V4. Initiating cath lab activation."
  }'
```

### Step 6: Close / Finalize Case

Once reviewed and routed, the doctor finalizes the case:

```bash
curl -X POST http://localhost:8000/api/cases/<CASE_UUID>/close \
  -H "Authorization: Bearer $DOCTOR_TOKEN"
```

---

## 7. Audit Trails & Clinical Governance

For medical safety, legal compliance, and quality review, every critical event is permanently logged in the `audit_log` table.

Doctors can inspect the complete audit trail for any case:

```bash
curl -X GET http://localhost:8000/api/cases/<CASE_UUID>/audit \
  -H "Authorization: Bearer $DOCTOR_TOKEN"
```

Example audit events tracked:

- `consent_given` (Who consented, timestamp, mode)
- `intake_submitted` (Original modality and payload)
- `ai_report_generated` (Provider used, processing latency, confidence score)
- `risk_overridden` (Previous risk, new risk, doctor's mandatory written justification)
- `report_edited` (Monotonic version number created)
- `closed` (Final disposition timestamp)

---

## 8. Automated Verification & Testing

The repository includes a comprehensive, multi-layer automated test suite:

```bash
# Run the complete test suite (26 suites covering unit, domain, security, & integration tests)
npm test

# Run the live staff authentication & role-guard verification
npx tsx tests/scripts/verify-seed-staff.ts

# Verify TypeScript types without compiling
npx tsc --noEmit

# Check code formatting
npm run format:check
```

---

## 9. API Troubleshooting & FAQ

### Q: Why do I get `403 forbidden` when creating a case as a doctor?

**A:** By design, `POST /api/cases` is restricted to `patient` and `receptionist` roles. Doctors review, edit, and triage cases—they do not submit initial patient intake.

### Q: What does `consent_required` (HTTP 403) mean?

**A:** A patient must have a valid consent record created within **30 minutes** prior to intake submission. If more than 30 minutes elapse, submit `POST /api/consent` again.

### Q: What if an image or audio file fails processing?

**A:** If an upload fails format verification or OCR/STT yields no readable text, the case safely routes to `manual_fallback`. The patient or receptionist can submit the structured fields directly via `PATCH /api/cases/:id/manual-fallback` without losing their queue priority.

### Q: How do I inspect the raw database visually?

**A:** Run `npm run db:studio`. Drizzle Studio will open locally in your browser connected securely to your Neon database.
