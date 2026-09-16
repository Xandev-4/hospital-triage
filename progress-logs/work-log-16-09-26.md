# Work Log — Multimodal Healthcare Triage Assistant

Running log of decisions and progress. Newest entries at the top.

---

## Entry — TypeScript migration, ESM build config, and .gitignore hardening

**What was done:**
- Configured a hardened `.gitignore` covering environment files and secrets (`.env*`, whitelisting `.env.example`), upload/media buffers (`uploads/`, `tmp/`, OCR caches), Neon/Postgres SQL dumps, test coverage, and build artifacts (`dist/`).
- Initialized `tsconfig.json` for NodeNext ESM (`target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`), `rootDir: "./src"`, `outDir: "./dist"`, strict type checking, `isolatedModules` for `tsx` runner compatibility, and safety flags (`noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`).
- Migrated all 37 scaffolded JavaScript files (`.js`) in `src/` to TypeScript (`.ts`) across all domain modules (`auth`, `patients`, `consent`, `cases`, `processing`, `queue`, `review`, `audit`) and shared infrastructure using `git mv` to preserve git history.
- Validated complete TypeScript compilation with `npx tsc --noEmit` cleanly with zero errors.

---

## Entry — Repo scaffold + auth module built

**What was done:**
- Created the repo skeleton using a **module structure** (not layer-based) — everything about one domain (`auth`, `patients`, `consent`, `cases`, `processing`, `queue`, `review`, `audit`) lives together in one folder under `src/modules/`, instead of being split across top-level `routes/`, `controllers/`, `models/` directories.
- Reasoning: `processing/` is kept separate from `cases/` specifically because the AI extraction + rules engine is the riskiest, most independently-testable part of the system — isolating it means `rules-engine.js` can be unit-tested with zero HTTP/DB involved. `review/` is kept separate from `cases/` even though both touch the same table, because they're different actors (patient/receptionist vs doctor-only) — separating them makes the role boundary visible in the folder tree, not just in middleware.
- Built shared infrastructure first, before any feature code: env loader, single Postgres connection pool, a typed `AppError` class, and a central error-handling middleware that matches the error envelope frozen in `api-contract.md` (`{ error: { code, message, details } }`).
- Wrote the 4 SQL migrations for all 7 tables from the finalized ERD (`users`, `patients`, `consent`, `triage_cases`, `case_uploads`, `case_report_versions`, `audit_log`), including the `users.patient_id` fix.
- Built the `auth` module fully: `POST /api/auth/register` (patient self-registration only, creates a linked `patients` row in the same DB transaction per the ERD fix), `POST /api/auth/login`, `POST /api/auth/logout` (client-side discard for V1), `GET /api/auth/me`. JWT verify + role-check middleware built here since every other module depends on it.

**Not yet built:** consent, cases, processing/rules-engine, queue, review, audit modules. `app.js` has a comment marking where each gets mounted as it's built.

**Next step:** the first vertical slice — `POST /api/consent → POST /api/cases → POST /api/cases/:id/process (stubbed AI) → GET /api/queue → POST /api/cases/:id/approve` — working end to end before touching voice/OCR upload or manual fallback.

---

## Entry — ERD finalized

- Reviewed the hand-drawn ERD (7 tables: `USERS`, `PATIENTS`, `CONSENT`, `TRIAGE_CASES`, `CASE_UPLOADS`, `CASE_REPORT_VERSIONS`, `AUDIT_LOG`) against `spec.md` and `api-contract.md`.
- Found one real gap: `triage_cases.patient_id` and `consent.patient_id` both FK into `PATIENTS`, but a self-registered patient only exists in `USERS` — nothing linked the two, which would've blocked the self-intake path entirely.
- Fix chosen: add `users.patient_id` (nullable FK → `patients.id`), set at registration time. Chosen over the alternative (reusing the same UUID across both tables) because it's more explicit and matches how the schema already separates identity from account.
- Converted the corrected ERD to Mermaid (`docs/triage-erd.mermaid`) as the source of truth going forward.

---

## Entry — Spec doc consolidated

- Pulled together everything decided across prior conversations (roles, retention, facility scoping, follow-up scheduling, the full core design, the V1/V2/V3 roadmap, the API reference, and frontend page spec) into one `docs/spec.md` as the single source of truth.
- Spec is scoped so V1 stands alone as the actual grading/demo bar, with V2/V3 called out separately so nothing gets built early by accident.
- Later superseded in detail by `api-contract.md` (frozen V1 endpoint contract, written after the spec) — `spec.md` still holds the high-level architecture and non-negotiables; `api-contract.md` is the byte-level source of truth for request/response shapes.

---

## Entry — Approach decided

- Decided to build this the way a professional engineering team would, not hackathon-improvised: spec doc before code, data model before API, API contract before implementation, vertical slices instead of building all models/all routes/all UI in separate passes, branch/commit discipline, a testing plan scoped to time budget, env/config hygiene, logging from day one, and a rehearsed demo script as a first-class deliverable.
