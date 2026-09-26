# 🏥 Multimodal Healthcare Triage Assistant (`HM-Triage`)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-ESM-green.svg?logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-lightgrey.svg?logo=express)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-blue.svg?logo=postgresql)](https://neon.tech/)
[![Drizzle ORM](https://img.shields.io/badge/ORM-Drizzle-orange.svg?logo=drizzle)](https://orm.drizzle.team/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

An intelligent, safety-first **Multimodal Clinical Triage Assistant** designed to streamline hospital outpatient (OPD) and emergency triage. It combines multi-modal patient intake (voice transcription, image OCR, and structured forms) with an AI extraction layer backed by a **deterministic clinical rules engine** to detect emergencies, prioritize patient queues, and provide doctors with editable, version-controlled triage notes.

---

## 🌟 Key Highlights

- **Multimodal Intake**: Accepts conversational voice descriptions, scanned medical documents/prescriptions (OCR), and structured form inputs in self-service or staff-assisted mode.
- **AI + Deterministic Safety Net**: LLM extraction is cross-checked against a hardcoded clinical rules engine. Discrepancies trigger an explicit `ai_rules_disagreement` flag for mandatory doctor review.
- **Privacy-by-Design Architecture**: Patient contact info (`patients`) is strictly isolated from clinical cases (`triage_cases`), ensuring unbiased medical assessment and HIPAA/GDPR-aligned privacy.
- **Doctor Queue & Immutable Versioning**: Triage queue sorted by risk level (`critical` → `high` → `medium` → `low`). Every doctor edit creates a new immutable version (`case_report_versions`).
- **Comprehensive Audit Trail**: Every sensitive action (consent, case intake, report edits, risk overrides, patient lookups) is permanently recorded in `audit_log`.

---

## 🛠️ Technology Stack

| Component            | Technology                          | Purpose                                                                   |
| :------------------- | :---------------------------------- | :------------------------------------------------------------------------ |
| **Runtime**          | **Node.js** (ESM, `NodeNext`)       | Fast, modern asynchronous runtime                                         |
| **Language**         | **TypeScript 5.9**                  | Strict typing, interfaces, and end-to-end type safety                     |
| **Web Framework**    | **Express 5.2**                     | Robust HTTP REST API layer                                                |
| **Database**         | **PostgreSQL (Neon)**               | Serverless cloud relational database                                      |
| **ORM & Migrations** | **Drizzle ORM & Drizzle Kit**       | Type-safe queries, Postgres `pgEnum`s, and schema migrations              |
| **Authentication**   | **JWT (`jsonwebtoken`) + `bcrypt`** | Stateless role-based access control (`patient`, `receptionist`, `doctor`) |
| **File Uploads**     | **Multer**                          | Multipart stream parsing for voice audio and OCR images                   |
| **Config & Tooling** | **dotenv**, **tsx**, **Prettier**   | Environment management, rapid TS execution, code formatting               |

---

## 🏗️ System Architecture & Workflow

```mermaid
flowchart LR
    A[Patient / Receptionist] -->|1. Sign Consent| B[(Consent 30min)]
    A -->|2. Voice / OCR / Form Intake| C[Case Created]
    C -->|3. Multimodal Extraction| D[AI Processing]
    D -->|4. Cross-Verification| E{Rules Engine}
    E -->|Safe / Flag Discrepancy| F[Triage Queue]
    F -->|5. Prioritized Review| G[Doctor Dashboard]
    G -->|6. Approve / Override / Edit| H[(Case Report Versions)]
```

### 1. The Core Lifecycle States

A triage case transitions deterministically through the following states:

```
submitted ──► processing ──► queued ──► assigned ──► closed
                 │              ▲
                 ▼              │
          manual_fallback ──────┘
                 │
                 ▼
             withdrawn
```

---

## 📂 Project Structure

This project follows a **Domain-Driven Modular Architecture** under `src/modules/` where each domain encapsulates its routes, controllers, services, and repositories:

```text
HM-Triage/
├── docs/                                # System design, API contracts & specs
│   ├── api-contract.md                  # Frozen V1 API contract
│   ├── spec.md                          # Full system specification
│   ├── triage-erd.mermaid               # Entity Relationship Diagram
│   └── triage-assistant-core-design.md  # Architectural deep-dive
├── migrations/                          # Drizzle-generated SQL migration files
├── progress-logs/                       # Running development logs
├── src/
│   ├── modules/
│   │   ├── auth/                        # JWT authentication & role-based guards
│   │   ├── patients/                    # Patient registration & lookup
│   │   ├── consent/                     # Digital consent lifecycle
│   │   ├── cases/                       # Triage case state-machine & management
│   │   ├── processing/                  # AI extraction & deterministic rules engine
│   │   ├── queue/                       # Doctor triage priority queue
│   │   ├── review/                      # Doctor review, report edit & approval
│   │   └── audit/                       # Immutable audit logger
│   ├── shared/
│   │   ├── config/
│   │   │   ├── db.ts                    # Drizzle connection client
│   │   │   ├── env.ts                   # Validated environment configuration
│   │   │   └── schema.ts                # Unified Drizzle schema & relationships
│   │   ├── middleware/
│   │   │   └── error-handler.ts         # Central standardized error envelope
│   │   └── utils/
│   │       └── AppError.ts              # Custom operational error class
│   ├── app.ts                           # Express app configuration & middleware
│   └── server.ts                        # HTTP server bootstrap
├── tests/                               # Test suites grouped by module
├── drizzle.config.ts                    # Drizzle Kit CLI configuration
├── package.json
└── tsconfig.json                        # TypeScript NodeNext configuration
```

---

## 🗄️ Database Schema

The database consists of 7 tightly scoped tables modeled in [`src/shared/config/schema.ts`](file:///home/xandev/Programming/Projects/HM-Triage/src/shared/config/schema.ts):

1. **`users`**: Login credentials, passwords (`bcrypt`), system roles (`patient`, `receptionist`, `doctor`), and unique 1-to-1 link to `patients`.
2. **`patients`**: Minimal identity and contact record (`name`, `phone_number`).
3. **`consent`**: Patient consent records, timestamped with a strict 30-minute validity window for intake authorization.
4. **`triage_cases`**: Clinical cases holding complaints, symptoms, vitals JSONB, risk level, AI discrepancy status, and lifecycle state.
5. **`case_uploads`**: Audio recordings and OCR document upload metadata.
6. **`case_report_versions`**: Monotonic version history of clinical reports (`UNIQUE(case_id, version_number)`).
7. **`audit_log`**: Immutable record of all system operations, role transitions, and searches.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v20+ or v22+
- **npm** v10+
- A **PostgreSQL** database (e.g. [Neon](https://neon.tech/))

### 1. Clone & Install

```bash
git clone https://github.com/your-username/HM-Triage.git
cd HM-Triage
npm install
```

### 2. Environment Configuration

Copy the template and fill in your database and auth credentials:

```bash
cp .env.example .env
```

Inside `.env`:

```env
PORT=8000
DATABASE_URL="postgresql://user:password@host/neondb?sslmode=require"
JWT_SECRET="your_secure_256_bit_random_hex_secret"
JWT_EXPIRES_IN="7d"
```

### 3. Apply Database Migrations

Run the migrations against your Neon PostgreSQL instance:

```bash
# Push schema directly or apply migrations
npm run db:push
```

### 4. Seed Staff Accounts (Doctors & Receptionists)

Bootstrap default hospital staff accounts into your database:

```bash
npm run seed
```

### 5. Seed Demo Scenarios (Optional for Presentation / Practice)

Populate the 4 canonical synthetic demo cases (Scenarios A, B, C, D):

```bash
npm run seed:demo
```

### 6. Run the Development Server

```bash
npm run dev
```

---

## 📘 User Guide & End-to-End Walkthrough

For a step-by-step walkthrough covering all personas, cURL examples, and operational workflows, refer to the complete guide:

👉 [**Read the Complete User & Operator Guide (`docs/user-guide.md`)**](docs/user-guide.md)

### What's inside the User Guide:

- **Patient Self-Service**: Registration, 30m digital consent window, multimodal intake (text, voice, OCR).
- **Receptionist Assisted-Intake**: Desk-assisted intake, managing walk-ins, resolving manual fallbacks.
- **Doctor Clinical Triage**: Urgency-sorted queue, AI review notes, versioned edits, and risk overrides.
- **Staff Management CLI**: Adding and removing staff members via terminal (`npm run staff:add`, `npm run staff:remove`).

---

## 📜 Available Scripts

| Command                | Description                                                                    |
| :--------------------- | :----------------------------------------------------------------------------- |
| `npm run dev`          | Starts the development server with hot-reload (`tsx watch`)                    |
| `npm test`             | Runs the full test suite (28 suites covering unit, domain, & HTTP)             |
| `npm run seed`         | Seeds default staff accounts (`doctor`, `receptionist`) idempotently           |
| `npm run seed:demo`    | Seeds or resets the 4 canonical synthetic demo cases (A, B, C, D) idempotently |
| `npm run db:clean`     | Completely wipes test data from all database tables and clears test uploads    |
| `npm run staff:list`   | Lists all active doctors and receptionists in a formatted table                |
| `npm run staff:add`    | CLI command to add a new doctor or receptionist                                |
| `npm run staff:remove` | CLI command to safely delete a staff account by email                          |
| `npm run format`       | Formats the codebase using Prettier                                            |
| `npm run format:check` | Checks formatting without writing changes                                      |
| `npm run db:push`      | Syncs the TypeScript schema directly to the database                           |
| `npm run db:generate`  | Generates a new SQL migration file from schema changes                         |
| `npm run db:migrate`   | Runs all pending SQL migrations                                                |
| `npm run db:studio`    | Launches Drizzle Studio GUI in your browser                                    |
| `npx tsc --noEmit`     | Performs TypeScript type checking across the project                           |

---

## 📖 Documentation & Specifications

Detailed architectural specifications, user guides, and API contracts can be reviewed in the [`docs/`](file:///home/xandev/Programming/Projects/HM-Triage/docs) directory:

- [**User & Operator Guide**](docs/user-guide.md): Complete end-to-end usage walkthrough for patients, receptionists, and doctors.
- [**API Contract (V1)**](docs/api-contract.md): Frozen request/response specifications and error envelopes (`{ error: { code, message, details } }`).
- [**System Specification**](docs/spec.md): Scope, user journeys, edge cases, and non-negotiables.
- [**Core Design Document**](docs/triage-assistant-core-design.md): In-depth algorithmic decisions, rules engine breakdown, and retention policies.
- [**Mermaid ERD**](docs/triage-erd.mermaid): Visual data model and entity relationships.

---

## ⚖️ License

This project is licensed under the [ISC License](LICENSE).
