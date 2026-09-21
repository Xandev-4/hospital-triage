# Work Log — Multimodal Healthcare Triage Assistant (17-09-26)

Running log of decisions and progress. Newest entries at the top.

---

## Entry — Authentication Module & End-to-End Flow Verification

**What was done:**

- Created `src/shared/types/express.d.ts` extending Express `Request` with `user?: { id: string; role: UserRole }`.
- Implemented `src/modules/auth/auth.service.ts`:
  - `register`: Validates email, name, password (min 8 chars), hashes via bcrypt, and executes an atomic Drizzle transaction creating linked `patients` and `users` records. Preserves optional `phone_number` on the patient record. Employs anti-enumeration validation error on existing email.
  - `login`: Validates credentials against hashed passwords and signs JWT tokens with configurable expiration and user role.
  - `getCurrentUser`: Retrieves user profile by UUID without exposing password hash.
- Implemented `src/modules/auth/auth.middleware.ts` with `requireAuth` (extracting Bearer token and attaching `req.user`) and `requireRole` role guard.
- Implemented `src/modules/auth/auth.controller.ts` with clean Express 5 async handlers delegating error handling to `errorHandler` without redundant wrapper utilities.
- Implemented `src/modules/auth/auth.routes.ts` mounting `/register`, `/login`, `/logout`, and `/me` under `/api/auth` in `src/app.ts`.
- Verified end-to-end via curl against local dev server:
  - `POST /api/auth/register` returned HTTP 201 with `user_id` and `role`. Direct database query confirmed both `users` and `patients` rows were created with foreign key linkage and phone number stored.
  - `POST /api/auth/login` returned HTTP 200 with JWT token.
  - `GET /api/auth/me` with Bearer token returned HTTP 200 with user profile.
  - `POST /api/auth/logout` returned HTTP 200 `{"ok": true}`.
  - Verified error envelopes: duplicate registration (400 validation error), wrong password (401 unauthorized), invalid Bearer token (401 unauthorized).

---

## Entry — Express app skeleton and health check verification

**What was done:**

- Configured `src/app.ts` with global JSON middleware, the baseline `GET /api/health` endpoint returning `{"status": "ok"}` matching `docs/api-contract.md`, and clean routing anchors for subsequent modules.
- Built `src/server.ts` to bootstrap the HTTP server using port and environment configuration from `src/shared/config/env.ts`.
- Added the `"dev": "tsx watch src/server.ts"` command to `package.json`.
- Started the server via `npm run dev` and verified end-to-end connectivity with curl, confirming HTTP 200 `{"status": "ok"}`.

---

## Entry — Centralized AppError and Express error handling middleware

**What was done:**

- Implemented `AppError` in `src/shared/utils/AppError.ts` as a strongly typed domain error class matching the frozen error envelope from `api-contract.md` (`{ error: { code, message, details } }`).
- Built static factory methods (`validation`, `unauthorized`, `forbidden`, `consentRequired`, `notFound`, `invalidStateTransition`, `internal`) ensuring correct HTTP status codes and strict `ErrorCode` enforcement.
- Implemented `errorHandler` in `src/shared/middleware/error-handler.ts` catching operational `AppError`s, handling client JSON `SyntaxError`s with 400 validation responses, and safely logging and masking unexpected 500 errors.
- Registered `errorHandler` in `src/app.ts` as the terminal error middleware and verified end-to-end behavior via a live HTTP 404 test request.

---

## Entry — Fail-fast typed environment configuration

**What was done:**

- Built out `src/shared/config/env.ts` with a `required(name)` validation function to enforce fail-fast behavior at startup for critical variables (`DATABASE_URL`, `JWT_SECRET`).
- Exported a unified, typed `env` configuration object with sensible defaults for `port`, `nodeEnv`, and `jwtExpiresIn`.
- Updated `src/shared/config/db.ts` to consume `env.databaseUrl`, eliminating raw unvalidated `process.env` access and redundant `dotenv` imports across the codebase.
- Verified both success and failure cases: confirmed loud, immediate startup failure when required variables are missing and validated clean runtime execution.

---

## Entry — Drizzle ORM implementation, schema hardening, Prettier, and migrations

**What was done:**

- Replaced Prisma with **Drizzle ORM** (`drizzle-orm`, `drizzle-kit`) using the `postgres` (`postgres.js`) driver for lightweight, type-safe database access on Neon PostgreSQL.
- Implemented the complete 7-table schema in `src/shared/config/schema.ts` from `docs/triage-erd.mermaid` and `docs/api-contract.md`:
  - Enforced strict database-level enum safety using Postgres `pgEnum`s for `role`, `case_status`, `risk_level`, `case_mode`, `case_type`, `given_by`, `report_source`, `upload_modality`, and `audit_event_type`.
  - Fixed 3 critical schema bugs: made `patients.phone_number` nullable (ensuring self-registration doesn't fail on missing phone), added composite unique constraint on `case_report_versions(case_id, version_number)` to prevent version collisions, and added `.unique()` on `users.patient_id` to enforce a strict 1-to-1 account-to-patient invariant.
  - Added B-Tree indexes on `triage_cases(status, risk_level)` for fast doctor queue querying, plus indexes on `patients(name, phone_number)` and foreign keys.
- Generated version-controlled SQL migrations via `drizzle-kit generate` (`0000_slow_madripoor.sql`, `0001_equal_orphan.sql`).
- Moved obsolete 0-byte manual migration templates to a git-ignored `trash/` directory.
- Configured repository-wide Prettier formatting (`.prettierrc`, `.prettierignore`, and `npm run format` / `format:check` scripts).
