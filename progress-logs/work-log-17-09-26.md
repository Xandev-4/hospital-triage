# Work Log — Multimodal Healthcare Triage Assistant (17-09-26)

Running log of decisions and progress. Newest entries at the top.

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
